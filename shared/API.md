# 前后端接口契约 v1.0.0

前后端唯一的约定。机器可读版在 `shared/contract.mjs`，验收脚本 `npm run check -- <后端地址>`。
改契约 = 同时改这两个文件 + 双方 review。以 PRD §8 为蓝本，下文标 ★ 的是相对 PRD 的补充或调整。

## 约定

- Base：本地 `http://127.0.0.1:4030`。前端用 `?api=<base>` 切换，不写死。
- 全部 JSON；错误统一 `{ "error": { "code": "...", "message": "..." } }`。
- 金额两种写法：`usdc` = `"7.071067"`（6 位小数，展示）；`micro` = `"7071067"`（整数字符串，计算，前端转 BigInt）。
- 价格算法唯一来源：`shared/curve.mjs`，与合约 `priceAt()` 逐位一致。前端本地 400ms 插值，后端不推每一跳。
- ★ 所有带价格的响应都有 `serverTime`，前端用它校准时钟。
- CORS：`Access-Control-Allow-Origin: *`，并 **必须** `Access-Control-Expose-Headers: PAYMENT-REQUIRED, PAYMENT-RESPONSE, X-Quote-Id`，否则浏览器读不到 x402 头。

## 错误码

| code | HTTP | 场景 |
|---|---|---|
| BAD_PARAMS | 400 | 参数不合法 |
| NOT_FOUND | 404 | 信号不存在 / 无访问记录 |
| CLOSED | 409 | 已提前公开 |
| FREE_ALREADY | 409 | 已免费，应走 claim |
| NOT_FREE_YET | 409 | 未免费就 claim |
| ALREADY_OWN | 409 | 已有访问权 |
| NOT_PUBLISHER | 403 | 非发布者 |
| QUOTE_EXPIRED | 409 | 报价过期（PRD §8.4 规则下通常不触发） |
| PAYMENT_REQUIRED | 402 | x402 未付款 |
| UPSTREAM | 502 | RPC / facilitator 故障 |

## 端点

| 方法 | 路径 | 返回 | 说明 |
|---|---|---|---|
| GET | `/health` | `{ ok }` | |
| GET | ★ `/api/config` | Config | 前端启动时读：链、合约、USDC、RPC |
| GET | `/api/signals` | `{ signals: Signal[] }` | 发布时间倒序 |
| POST | `/api/signals` | `201` PublishResult | 见下 |
| GET | `/api/signals/:id` | Signal | |
| GET | `/api/signals/:id/curve?samples=120` | Curve | |
| GET | `/api/signals/:id/trades` | `{ trades: Trade[] }` | rank 升序 |
| GET | `/api/signals/:id/quote` | Quote | 已免费 → 409 FREE_ALREADY |
| GET | `/api/signals/:id/content?buyer=&quoteId=` | Content | 见下 |
| POST | `/api/signals/:id/claim` `{ address }` | Content | 未免费 → 409 NOT_FREE_YET；已领过返回原记录 |
| GET | `/api/signals/:id/receipt?address=` | Receipt | 无记录 → 404 |
| GET | `/api/live/:id` | Live | 大屏全量 |
| GET | `/api/live/:id/stream` | SSE | `tick` / `trade` / `stampede` / `opened` |

字段明细见 `contract.mjs` 里的 `Signal / Trade / Curve / Quote / Content / Receipt / Live / Config`。

### `/content` 的三种放行条件（任一满足即 200）

1. `buyer` 在链上已有访问权（钱包调了 `buy()`，索引器已收到 `Bought`）→ `channel: "onchain"`
2. 请求带 x402 支付头 `PAYMENT-SIGNATURE`，facilitator verify+settle 成功 → `channel: "x402"`，后端调 `recordX402`；金额按 `quoteId` 锁价（PRD §8.4）
3. `buyer` 已免费领取过 → `channel: "free"`

都不满足：价格 > 0 → `402 PAYMENT_REQUIRED` + `PAYMENT-REQUIRED` 头（无有效 quoteId 时附 `X-Quote-Id`）；价格 = 0 → `409 FREE_ALREADY`。

★ 与 PRD §8.5 的差异：正文以明文 `body` 返回（HTTPS + 访问权校验后），不再下发 `cipher + keyFragment`。前端拿到密钥再解密并不增加安全性，徒增复杂度。服务端仍可加密落盘。待后端确认。

★ 已知取舍：条件 1/3 只凭 `buyer` 地址放行，任何人知道别人的地址就能读。PRD 定位"防君子"，赛后可改为钱包签名挑战。

### `POST /api/signals`

```json
{ "title": "...", "previewText": "...", "body": "...",
  "basePriceMicro": "10000000", "floorPriceMicro": "0", "halfLife": 30,
  "attestPublicSource": true, "txHash": "0x...（可选）" }
```

- 不带 `txHash`：后端用自己的钱包代发 `publish()`（PRD P1"现场脚本代发"）。
- 带 `txHash`：前端钱包已发 `publish()`，后端从回执里解析 `Published` 事件拿 id，并校验 `contentHash == keccak256(body)`。

### SSE

```
event: tick      data: {"price":"0.625000","priceMicro":"625000","timeToFree":478,"serverTime":1760700482}   每 400ms–1s
event: trade     data: Trade
event: stampede  data: {"claims":142,"window":"3s"}
event: opened    data: {"at":1760700960}
```

断线时前端自动降级为每 1s 轮询 `/api/live/:id`。

## Mock 专用（真后端不需要实现）

`POST /__mock/buy`、`/__mock/reset`、`/__mock/bots`、`/__mock/open`，见 `shared/mock/server.mjs` 头部注释。`/api/config` 返回 `mock: true` 时前端走这些接口代替钱包。

## 后端改造清单（现有 `backend/src/server/alpha-api.ts` → 本契约）

| 现有 | 改为 |
|---|---|
| `GET /api/signal/:id` | `GET /api/signals/:id`，补齐 Signal 字段 |
| `GET /api/signal/:id/buys` | `GET /api/signals/:id/trades` |
| `GET /api/quote/:id` | `GET /api/signals/:id/quote` + quoteStore |
| `GET /api/signal/:id/body`（x402） | `GET /api/signals/:id/content`，价格读 quoteId |
| `POST /api/claim` | 并入 `/content` 条件 1；免费领取用 `POST /api/signals/:id/claim` |
| `POST /api/content` | `POST /api/signals` |
| 无 | `/api/config`、`/curve`、`/receipt`、`/live`、`/live/stream`、索引器 |
| CORS | 补 `Access-Control-Expose-Headers` |
| 错误 `{ error: "..." }` | `{ error: { code, message } }` |

合约侧改造见 PRD 附录 C（去全局计数器、`Access` 单槽、`claimFree`、`contentHash`、`Opened` 事件）。
