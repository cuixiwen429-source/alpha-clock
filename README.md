# 半衰期 / Alpha Clock

> 这条消息，每 400 毫秒便宜一点。8 分钟后，它免费。

Monad Blitz Shanghai V3 参赛项目（Monad × x402）。产品定义见 PRD，接口见 [`shared/API.md`](shared/API.md)。

## 仓库结构

```
backend/     合约（Foundry）+ alpha-api（Express + x402）+ 索引器      ← 后端负责
frontend/    纯静态页面，无构建：s.html 购买页 / live.html 大屏 / publish.html 发布台   ← 前端负责
shared/      前后端契约（双方共同维护）
  API.md            人读版契约
  contract.mjs      机器可读契约（字段 + 类型）
  curve.mjs         价格算法，与合约 priceAt() 逐位一致，前端/后端/mock 共用
  check-contract.mjs  契约验收脚本：对任意后端跑一遍
  mock/server.mjs   零依赖 mock 后端，实现全部接口 + SSE + 机器人买家
```

`frontend/shared` 是指向 `../shared` 的软链接，前端直接 `import "./shared/curve.mjs"`。

## 前端怎么开发（不等后端）

```bash
npm run mock            # :4030，信号 #1 半衰期 30s，4 分钟归零
npm run mock:fast       # 半衰期 8s，64 秒走完一轮，调归零/终局卡用
```

打开 http://localhost:4030/s/1 、 /live/1 、 /publish。mock 同时托管 `frontend/`，改完刷新即可。

重演一轮：`curl -XPOST localhost:4030/__mock/reset -d '{"halfLife":30}'`

页面只通过 `frontend/js/api.js` 访问后端、`frontend/js/wallet.js` 处理钱包，不要在页面里直接 fetch。

## 后端怎么对齐

```bash
cd backend && npm install && npm run serve       # 真后端 :4030
npm run check -- http://127.0.0.1:4030           # 在仓库根目录跑契约验收，全绿才算打通
```

现有 `backend/src/server/alpha-api.ts` 还是旧路径，改造清单在 `shared/API.md` 末尾。

## 前后端联调

前端页面加 `?api=` 指向任意后端，会记在 localStorage：

```
http://localhost:4030/s.html?id=1&api=http://192.168.1.8:4030   # 指向同事机器上的真后端
...?api=reset                                                   # 恢复同源
```

`/api/config` 返回 `mock: true` 时，购买走 `/__mock/buy`；否则走浏览器钱包 → `approve` → `AlphaClock.buy()`。页面代码不用改。

## 协作规则

- `main` 受保护，只能走 PR 合并；CI（契约 + mock + 价格曲线测试 + `forge test`）必须绿。
- 分支名：`fe/xxx`（前端）、`be/xxx`（后端）、`contract/xxx`（改契约）。
- 改 `shared/` = 改契约：`API.md`、`contract.mjs`、mock 三处同步，CODEOWNERS 会自动拉双方 review。
- 前端只依赖契约里有的字段；后端多返回字段不算破坏，删字段/改类型必须走 `contract/` 分支。
- 合约地址只认 `backend/contracts/deployments.json`，后端通过 `/api/config` 下发，前端不写死。
- 私钥只放 `backend/.env`（已 gitignore），不进仓库。

```bash
# 首次 clone
git clone --recurse-submodules <repo>
# 已 clone 但没拉子模块
git submodule update --init --recursive
```

## 部署（Monad 测试网）

测试网已部署并验证：`chainId 10143`，合约 `0x7a30Cc771d51C4fE5586209843A5Cd50cfE055d8`
（部署块 `71778113`，广播记录见 `backend/contracts/broadcast/Deploy.s.sol/10143/`），
USDC 用链上真币 `0xc64b5C61B5c11859b72c7fc69D69b0bc15155e48`。

一个进程同时托管页面和 API（同源，不用配 CORS、页面不用带 `?api=`）：

```bash
cd backend
set -a; source .env; set +a
SERVE_FRONTEND=1 npm run serve        # http://127.0.0.1:4030/ 首页
```

必需的环境变量（`backend/.env`）：

| 变量 | 说明 |
|---|---|
| `NETWORK` | `monad-testnet` |
| `MONAD_RPC_URL` | 主 RPC。官方节点并发下会 ECONNRESET，后端已带重试 |
| `MONAD_RPC_FALLBACKS` | 备用 RPC，逗号分隔（默认 thirdweb / ankr 兜底） |
| `RPC_RETRY` / `RPC_TIMEOUT_MS` | 重试次数 / 单次超时，默认 4 / 15000 |
| `PRIVATE_KEY` | 平台代发 `publish()` 用 |
| `PUBLIC_APP_URL` | 发布成功后返回的分享链接前缀 |

`backend/contracts/deployments.json` 不进 git（避免把本机 anvil 地址带出去），
新机器上要先 `cd backend && npm run deploy:testnet` 或手写该文件指向测试网合约。

验收：`node shared/check-contract.mjs http://127.0.0.1:4030 <signalId>` 应 14/14 通过。

## 合规

本项目为测试网演示，不构成投资建议。内容将在 8 个半衰期后永久免费公开。不做中国大陆地区经营性推广。
