# AlphaClock Backend

AlphaClock 的独立后端：Express API、x402 报价与结算、Monad 事件索引、内容交付和收据签发。前端只依赖仓库根目录的 `shared/API.md`，后端不托管前端资源。

## 环境

- Node.js 22
- npm 10+
- 合约开发/本地链另需 Foundry

```bash
cd backend
nvm use                         # 若使用 nvm，读取 backend/.nvmrc
npm install
cp .env.example .env

# API 不会自动读取 .env；每个新终端都要显式导入
set -a
source .env
set +a

npm run check
npm run serve
```

默认监听 `http://127.0.0.1:4030`。前端可通过 `?api=http://<后端IP>:4030` 联调。

## 分层

```text
src/chain/alpha-gateway.ts     Monad RPC、v2 ABI、发布与 recordX402
src/domain/content-store.ts    正文与 keccak256 校验、原子落盘
src/domain/quote-store.ts      10 秒锁价、10 分钟落盘保留
src/indexer/alpha-indexer.ts   Published/Bought/Claimed/Opened 增量索引
src/server/create-app.ts       HTTP、CORS、x402、SSE、错误契约
src/server/alpha-api.ts        进程入口与优雅退出
```

价格算法不在后端复制实现，直接导入 `../shared/curve.mjs`。所有带实时价格的响应使用链上最新块时间作为 `serverTime`；RPC 不可用时返回统一的 `502 UPSTREAM`，不使用可能偏离链上状态的本机时钟报价。默认每 20 次实时价格响应再调用合约 `priceAt()` 抽样比对一次，可通过 `PRICE_CHECK_EVERY` 调整。

## 接口

实现 `shared/API.md` v1.0.0：

- `GET /health`
- `GET /api/config`
- `GET|POST /api/signals`
- `GET /api/signals/:id`
- `GET /api/signals/:id/curve`
- `GET /api/signals/:id/trades`
- `GET /api/signals/:id/quote`
- `GET /api/signals/:id/content`
- `POST /api/signals/:id/claim`
- `GET /api/signals/:id/receipt`
- `GET /api/live/:id`
- `GET /api/live/:id/stream`
- `GET /manifest`

错误统一为：

```json
{ "error": { "code": "NOT_FOUND", "message": "信号不存在" } }
```

CORS 显式暴露 `PAYMENT-REQUIRED`、`PAYMENT-RESPONSE` 和 `X-Quote-Id`。

## 报价和正文

`GET /api/signals/:id/quote` 将当时价格锁定 10 秒，同一信号在窗口内复用同一报价。报价在 `.runtime/quotes.json` 保留 10 分钟，所以客户端签名稍慢时仍能按原报价完成 x402 结算；结算金额不重新读取实时价。

`/content` 的放行条件：

1. 买家在链上已有 `Access`；
2. x402 verify + settle 成功；
3. 买家已有免费领取记录。

按已冻结的接口约定，成功后直接返回明文 `body`，不下发浏览器端密钥片段。服务端仍校验 `keccak256(body) == contentHash`。`content.json` 是 P0 本地存储，不应用于生产敏感内容。

## 索引器

索引器每秒增量读取 `Published`、`Bought`、`Claimed`、`Opened`，在内存中重建 `buyers`、`claims`、`revenue`、`maxPaid`、`minPaid`、`recent`，不依赖合约全局计数器。

测试网必须提供准确起点，二选一：

- `contracts/deployments.json` 增加 `deploymentBlock`；
- `.env` 设置 `DEPLOYMENT_BLOCK`。

未配置时，非本地网络只从当前块开始并输出警告，避免无边界扫描公共 RPC；此时重启后历史聚合不完整。

RPC 查询失败不会推进游标，下一轮会从同一块重试，不会静默跳过事件。

## x402

测试网默认开启，使用 `FACILITATOR_URL`。本地 Anvil 默认关闭；即使关闭，未付款请求仍返回标准化 `402`、`PAYMENT-REQUIRED` 和 `X-Quote-Id`，便于前端与契约测试。

x402 成功结算后，后端使用 `VERIFIER_PRIVATE_KEY`（未配置时回退 `PRIVATE_KEY`）调用 `recordX402`。密钥只放 `.env`。

## 验证

```bash
# 类型 + 5 项领域单测 + 14 项 shared API 契约测试
npm run check

# 真链联调：先启动 Anvil、部署 v2 合约、seed，再启动 API
set -a; source .env; set +a
npm run serve
node ../shared/check-contract.mjs http://127.0.0.1:4030
```

`npm run test:contract` 使用后端自己的 fixture，只验证 HTTP 契约，不冒充链上端到端证明。真实的发布、购买、`recordX402`、索引重建仍需在已部署的 PRD v2 合约上验证。

## 已确认的跨团队约定

- `/content` 返回明文正文。
- `/api/config` 为前端提供网络、RPC、合约与 USDC 地址。
- 所有实时价格响应包含 `serverTime` 或等价的报价时间字段。
- 修改 `shared/` 必须另开 `contract/xxx` 分支并由前后端共同评审；本分支不修改共享契约。
