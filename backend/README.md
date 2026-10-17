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

npm run check                   # 类型 + 单测 + 契约（不需要链）
npm run serve                   # 自动读取 .env
```

默认监听 `0.0.0.0:4030`（可用 `HOST` / `PORT` 覆盖）。本机访问 `http://127.0.0.1:4030`；前端可用 `?api=http://<内网IP>:4030` 让同事的手机直接联调。

`.env` 由 `src/env.ts` 在入口最前面加载，`npm run serve/seed/buy/deploy:*` 都不需要再手动 `source .env`；已有的环境变量优先，所以测试里 `PORT=4398` 仍然压过 `.env`。

## 本地整链跑通（约 30 秒）

```bash
npm run anvil            # 终端 A：本地链，1 秒一个块
npm run deploy:local     # 终端 B：部署 MockUSDC + AlphaClock，写 contracts/deployments.json
npm run seed             # 发布 3 条演示信号，正文写进 content.json
npm run serve            # 起 API
npm run buy 1 1          # 用 anvil 第 1 个账户买 #1（余额不足会自动从 MockUSDC 领水）
```

`npm run deploy:local` 会通过 `scripts/foundry.mjs` 读 `.env` 并补 `~/.foundry/bin` 到 PATH，所以 Foundry 装在默认位置时不必手动改 PATH；`deployments.json` 里会写入 `deploymentBlock`，索引器重启后能补全历史。

部署脚本会先跑 `scripts/reset-state.mjs` 清掉 `content.json` / `.runtime/`：重新部署后信号 id 从 1 重新开始，本地这几份状态全部对不上新链 —— `content.json` 是 id→正文，`.runtime/free-claims.ndjson` 记着谁领过免费，`.runtime/quotes.json` 里的 `payTo` 是旧发布者。带着它们跑，轻则把上一条链的领取算到新信号头上，重则拿旧报价把 x402 的钱打给旧地址。所以部署后必须重新 `npm run seed`。只想单独清一次可以用 `npm run reset:state`。

`contracts/deployments.json` 和 `content.json` 都是运行产物，**不进 git**：它们分别随部署和发布被重写，提交上去只会把某人本机的 anvil 地址带给别人。新克隆的仓库里它们不存在是正常的，按上面的顺序跑一遍就有。前端不要在本地读 `deployments.json`，合约地址一律走 `/api/config` 下发。

## 分层

```text
src/env.ts                     .env 加载（必须第一个 import）
src/chain/alpha-gateway.ts     Monad RPC、v1 ABI、发布与 recordX402
src/domain/content-store.ts    正文与 keccak256 校验、原子落盘
src/domain/quote-store.ts      10 秒锁价、10 分钟落盘保留
src/indexer/alpha-indexer.ts   Published/Bought/Claimed/Opened 增量索引
src/server/create-app.ts       HTTP、CORS、x402、SSE、错误契约
src/server/alpha-api.ts        进程入口与优雅退出
scripts/foundry.mjs            forge 统一入口（读 .env、补 PATH、锁定 contracts/）
contracts/src/AlphaClock.sol   合约（v1 契约 / PRD 附录 C）
```

## 合约

`contracts/src/AlphaClock.sol` 是 `shared/API.md` v1 对应的那一版，与上一版的差别：

- `publish(title, previewURI, contentHash, basePrice, floorPrice, halfLife)` —— 正文不进链，只承诺 `keccak256(body)`；
- 访问权合并成一个 `Access{at, price}` 单槽（`accessOf`），替代原来的 `hasAccess` + `paidPrice` 两张 mapping；
- 去掉链上 `buyCount` / `revenue` 计数器，聚合一律由索引器从事件重建；
- 新增 `claimFree()` 与 `Claimed` 事件，免费抢领成为链上事实；
- `Opened(id, by, at)` 带上 `by`，区分「发布者提前公开」与「时间到了自然免费」。

`priceAt()` 与 `shared/curve.mjs` 的 `priceAt()` 必须逐位一致，`test_MatchesSharedCurveTable` 会在 CI 里盯住这一点。改任何一边都要同时改另一边。

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

测试网必须提供准确起点，优先级：

1. `.env` 的 `DEPLOYMENT_BLOCK`；
2. `contracts/deployments.json` 的 `deploymentBlock`（`npm run deploy:*` 自动写入）；
3. 本地 anvil 从 0 扫，其它网络从当前块开始并输出警告。

未配置时，非本地网络只从当前块开始并输出警告，避免无边界扫描公共 RPC；此时重启后历史聚合不完整。

RPC 查询失败不会推进游标，下一轮会从同一块重试，不会静默跳过事件。

## x402

测试网默认开启，使用 `FACILITATOR_URL`。本地 Anvil 默认关闭；即使关闭，未付款请求仍返回标准化 `402`、`PAYMENT-REQUIRED` 和 `X-Quote-Id`，便于前端与契约测试。

x402 成功结算后，后端使用 `VERIFIER_PRIVATE_KEY`（未配置时回退 `PRIVATE_KEY`）调用 `recordX402`。密钥只放 `.env`。

## 验证

```bash
# 类型 + 5 项领域单测 + 14 项 shared API 契约测试（fixture 后端，不需要链）
npm run check

# 合约
npm run forge:test        # 25 项：定价 / 抽成 / 重复购买 / 免费领取 / x402 / 提前公开

# 真链联调
npm run anvil             # 终端 A
npm run deploy:local && npm run seed && npm run serve   # 终端 B
node ../shared/check-contract.mjs http://127.0.0.1:4030 # 仓库根目录
npm run buy 1 1           # 再买一笔，观察 /api/signals/1/trades 与 SSE 的 trade 事件
```

`npm run test:contract` 使用后端自己的 fixture，只验证 HTTP 契约，不冒充链上端到端证明。真实的发布、购买、`recordX402`、索引重建需要按上面的真链流程验证；2026-10-17 已在本地 anvil 上跑通整条链路（购买 → 索引 → 正文交付 → 收据 → `openNow` → `claimFree` → 进程重启后重建）。

## 已确认的跨团队约定

- `/content` 返回明文正文。
- `/api/config` 为前端提供网络、RPC、合约与 USDC 地址。
- 所有实时价格响应包含 `serverTime` 或等价的报价时间字段。
- 修改 `shared/` 必须另开 `contract/xxx` 分支并由前后端共同评审；本分支不修改共享契约。
