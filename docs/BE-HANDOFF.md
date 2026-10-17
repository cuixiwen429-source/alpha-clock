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
| 干净 clone 后 `npm ci && npm run check` | ✅ | 无 `.env`、无 `deployments.json` 也能过（CI 的 backend job 就是这么跑的） |
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

**注意端口冲突**：mock 和真后端默认都是 4030，不能同时开。开发期建议 mock 用 `PORT=4031 npm run mock`，或者联调时只开真后端。真后端被 mock 顶掉时 `npm run serve` 会直接报 `端口 4030 已被占用`。

一条命令从零跑完整链路（清链、部署、seed、起服务、造几笔成交、打战报）：

```bash
cd backend && npm run demo          # 或 bash scripts/demo-local.sh 5 12
```

`/api/config` 返回 `mock: false` 时，页面就该走「浏览器钱包 → approve → `AlphaClock.buy()`」而不是 `/__mock/buy`。这条分支目前**只有 mock 侧被跑过**，真后端侧的钱包路径请你重点验。

## 3. 五个坑（都是真踩过的）

1. **`POST /api/signals` 的 `attestPublicSource` 必须是 `true`**（布尔，不是字符串）。zod 是 `literal(true)`，传 `"true"` 会 400。
2. **不传 `txHash` = 后端代发**，此时链上 `publisher` 是平台钱包（`PRIVATE_KEY`），不是用户钱包，发布者分成也归平台。要保留用户身份就得让前端钱包先发 `publish()`，再把 `txHash` 传上来——后端会从回执里解析 `Published` 事件拿 id，并校验 `contentHash == keccak256(body)`，对不上直接报错。
3. **`publish()` 现在吃的是 `contentHash`（bytes32），不是 `contentURI`**。`frontend/js/wallet.js` 里的 `ALPHA_ABI` 只有 `buy`，买这条链路是对的、不用动；只有当你决定接「钱包直发 `publish()`」时才需要补上 v1 的 `publish` 片段（见第 5 节）。
4. **价格归零后 `/content` 返回 `409 FREE_ALREADY`，不是 200**——必须再调 `POST /api/signals/:id/claim` 拿正文。两者都返回同一个 `Content` 结构，前端可以统一处理。
5. **`/quote` 的有效期是 10 秒，但报价记录保留 10 分钟**。所以签名慢一点不会失败，别在前端做 10 秒倒计时强制刷新，反而会把锁到的低价换掉。

另外：`PublishResult.url` 是 `/s/:id` 形态（和 mock 一致），前端目前自己拼 `s.html?id=`，两边都没用这个字段，不用管。

## 4. 错误码（前端做分支用）

`BAD_PARAMS 400` / `NOT_FOUND 404` / `CLOSED 409` / `FREE_ALREADY 409` / `NOT_FREE_YET 409` / `ALREADY_OWN 409` / `QUOTE_EXPIRED 409` / `PAYMENT_REQUIRED 402` / `UPSTREAM 502`

结构永远是 `{ error: { code, message } }`，`code` 是机器可读那个。

## 5. 两件需要你决定的事（都不阻塞现在能跑的部分）

**① 发布页要不要「钱包直发 `publish()`」？**

现在 `publish.html` 是 POST 给后端、由平台钱包代发。代发的代价：链上 `publisher` 是平台地址，发布者分成也归平台，页面上那个「我发布的」身份只是数据库层面的一句话。要保留用户身份，前端钱包先发这笔交易、再把 `txHash` 传给后端即可：

```js
// 钱包直发（viem 已从 esm.sh 动态加载，和 wallet.js 一样的方式）
const PUBLISH_ABI = [{
  type: "function", name: "publish", stateMutability: "nonpayable",
  inputs: [
    { name: "title", type: "string" }, { name: "previewURI", type: "string" },
    { name: "contentHash", type: "bytes32" },
    { name: "basePrice", type: "uint128" }, { name: "floorPrice", type: "uint128" },
    { name: "halfLife", type: "uint32" },
  ],
  outputs: [{ name: "id", type: "uint256" }],
}];
// contentHash = keccak256(toBytes(body))，USDC 是 6 位小数，$10 → 10_000_000n
```

然后 `POST /api/signals` 带上 `txHash`。后端会从回执里解析 `Published` 事件取 id，并校验 `contentHash === keccak256(body)`，对不上直接 400——所以正文必须和链上哈希一致，前端不要做任何 trim。

**② 免费领取要不要落链上？**

`/claim` 是后端本地记账（`.runtime/free-claims.ndjson`），立刻能拿到正文，演示不受影响。但合约里那个 `claimFree()` 只有**领取人自己的钱包**能发（访问权记在 `msg.sender` 上），后端代发等于记到平台头上。想让「免费领取」在链上留痕，就在调 `/claim` 之前加一笔：

```js
await wallet.writeContract({ address: cfg.contract, abi: [{ type: "function", name: "claimFree", stateMutability: "nonpayable", inputs: [{ name: "id", type: "uint256" }] }], functionName: "claimFree", args: [BigInt(signalId)] });
```

后端索引器同时监听 `Claimed` 事件和本地记账，两边都走 `recordFreeClaim` 的去重逻辑，不会重复计数。**不做也不影响**，只是链上看不到这次领取。

顺带一句：`/api/config` 已经下发 `contract` / `usdc` / `chainId` / `rpcUrl` / `explorer`，前端别写死地址；`contracts/deployments.json` 现在不进 git 了，本地也读不到。

**③ x402 走真钱还是纯演示？** 本地只验了 402 响应头的形态（金额、`accepts`、`X-PAYMENT` 解析），没跑过真结算。要上台演示真结算，得提前在 Monad 测试网部署 + 拿测试 USDC + 确认 facilitator 可用；否则建议台上只讲这层设计，不放实时扣款。

## 6. 我这边的边界

- `shared/` 我一个字没改（契约照旧 v1.0.0），只补了后端和合约。
- 前端代码我一行没动。上面所有验证都是 curl / 脚本层，**UI 长什么样我没看过**，视觉效果仍然由你负责。
- `frontend/shared` 是指向 `../shared` 的软链接，价格曲线和字段校验都是同一份文件，不存在两边算法不一致的问题。

## 7. 第二轮 review 的结论（后端侧）

**修掉的：**

1. `GET /api/live/:id/stream` 连上之后再点「提前公开」，这个连接会一直报旧价格 —— 它在建立时拍了一张 `signal` 快照，`forcedOpen` 永远是 false。现在每 8 秒回链上重读一次，并且收到索引器的 `opened` 事件时立刻重算。实测：8.59 → 0.000000，`opened` 只发一次。
2. 前端把 `txHash` 传上来时，如果那笔交易一直不打包，后端会**永久挂住那个请求**（`waitForTransactionReceipt` 没有超时）。现在 90 秒超时，可用 `TX_TIMEOUT_MS` 调。
3. 索引器启动只试一次：RPC 抖一下，索引器就永远不跑了，而 `/health` 照样 ok。现在指数退避重试。
4. `deploy:local` / `deploy:testnet` 现在先 `reset-state`：重新部署后 id 从 1 开始，旧的 `content.json`、免费领取记录、报价全是上一条链的。旧报价里的 `payTo` 还是旧发布者 —— 拿它走 x402，钱会打给一个跟新信号无关的地址。
5. SSE 客户端断开后仍在 await 途中的 tick 会往已结束的响应写入，可能带崩进程。加了 closed 守卫。

**发现但没改的（给你参考）：**

- `frontend/js/api.js` 的 `api.stream()`：`es.onerror` 里直接 `es.close()` 并**永久降级为轮询**。EventSource 在弱网下每次重连都会触发 `onerror`，所以大屏只要有一下抖动，整场都变成 1s 轮询（没有 `trade`/`stampede` 实时事件，只有 tick）。建议改成「先让 EventSource 自己重连，连续失败 3 次再降级」。
- `/content?buyer=` 只凭地址放行，`shared/API.md` 第 60 行已经把它写成明示取舍（「防君子」）。要真防，得加钱包签名挑战，那要改契约，得双方一起动手。
- `/api/signals` 每次请求对每条信号各读一次合约（N+1）。现在 3–5 条无所谓，真到几十条要加按区块号的缓存。
