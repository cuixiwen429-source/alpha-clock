# 后端交接 · 给前端（Claude Code）

> 一句话：**后端和合约已经能端到端跑通，接口严格按 `shared/API.md` v1.0.0，契约测试 14/14。**
> 前端需要动的只有「把 `?api=` 指向真后端」和下面 5 个坑。

## 1. 现在能跑什么

真后端已在本机验证过整条链路（本地 anvil）：

| 环节 | 状态 | 验证方式 |
|---|---|---|
| 合约部署 + `publish()` | ✅ | `npm run deploy:local && npm run seed` |
| 链上 `buy()` → 索引器 → `/trades` | ✅ | 3 个买家，价格 5.81 → 5.00 → 4.39 |
| `/content?buyer=` 交付正文 | ✅ | 返回 `channel:"onchain"`、`rank`、明文 body |
| `/receipt` 收据签名 | ✅ | `multipleVsFirst` 计算正确 |
| `openNow` → 免费 → `claimFree` | ✅ | `status` 从 `LIVE` 变 `OPEN`，claims=1 |
| 进程重启后聚合恢复 | ✅ | 重启后 buyers/claims/revenue 一字不差 |
| `shared/check-contract.mjs` | ✅ | **14/14**（对真链后端跑的，不是 fixture） |
| x402 真金白银结算 | ⚠️ 未跑 | 需要 Monad 测试网 + 真实 facilitator，本地只验了 402 响应头形态 |

## 2. 怎么接到真后端

```bash
cd backend && npm run anvil        # 终端 A
npm run deploy:local && npm run seed && npm run serve   # 终端 B
```

然后前端页面加 `?api=http://127.0.0.1:4030`（会记进 localStorage）：

```
http://localhost:<你的静态服务>/s.html?id=1&api=http://127.0.0.1:4030
```

`/api/config` 返回 `mock: false` 时，页面就该走「浏览器钱包 → approve → `AlphaClock.buy()`」而不是 `/__mock/buy`。这条分支目前**只有 mock 侧被跑过**，真后端侧的钱包路径请你重点验。

## 3. 五个坑（都是真踩过的）

1. **`POST /api/signals` 的 `attestPublicSource` 必须是 `true`**（布尔，不是字符串）。zod 是 `literal(true)`，传 `"true"` 会 400。
2. **不传 `txHash` = 后端代发**，此时链上 `publisher` 是平台钱包（`PRIVATE_KEY`），不是用户钱包，发布者分成也归平台。要保留用户身份就得让前端钱包先发 `publish()`，再把 `txHash` 传上来——后端会从回执里解析 `Published` 事件拿 id，并校验 `contentHash == keccak256(body)`，对不上直接报错。
3. **`publish()` 现在吃的是 `contentHash`（bytes32），不是 `contentURI`**。合约已经改过了，前端如果手里有旧 ABI 请重新拉。
4. **价格归零后 `/content` 返回 `409 FREE_ALREADY`，不是 200**——必须再调 `POST /api/signals/:id/claim` 拿正文。两者都返回同一个 `Content` 结构，前端可以统一处理。
5. **`/quote` 的有效期是 10 秒，但报价记录保留 10 分钟**。所以签名慢一点不会失败，别在前端做 10 秒倒计时强制刷新，反而会把锁到的低价换掉。

另外：`PublishResult.url` 是 `/s/:id` 形态（和 mock 一致），前端目前自己拼 `s.html?id=`，两边都没用这个字段，不用管。

## 4. 错误码（前端做分支用）

`BAD_PARAMS 400` / `NOT_FOUND 404` / `CLOSED 409` / `FREE_ALREADY 409` / `NOT_FREE_YET 409` / `ALREADY_OWN 409` / `QUOTE_EXPIRED 409` / `PAYMENT_REQUIRED 402` / `UPSTREAM 502`

结构永远是 `{ error: { code, message } }`，`code` 是机器可读那个。

## 5. 需要你确认的两件事

1. **发布页的「钱包直发 `publish()`」要不要接**？现在 `publish.html` 头部注释里写的是「待后端定索引方案后再接」——索引方案已就位（`Published` 事件 + `contentHash` 校验），只差前端用 v1 ABI 发交易并把 `txHash` 传上来。
2. **x402 走真钱还是纯演示**？如果要上台演示 x402，需要提前在 Monad 测试网部署 + 拿测试 USDC + 确认 facilitator 可用；本地 anvil 的 facilitator 是自建的，只能验流程不能验真结算。

## 6. 我这边的边界

- `shared/` 我一个字没改（契约照旧 v1.0.0），只补了后端和合约。
- 前端代码我一行没动。上面所有验证都是 curl / 脚本层，**UI 长什么样我没看过**，视觉效果仍然由你负责。
- `frontend/shared` 是指向 `../shared` 的软链接，价格曲线和字段校验都是同一份文件，不存在两边算法不一致的问题。
