# 前端 × 后端 联调审查

审查方式：用一个「假前端」把 `frontend/js/api.js`、`s.html`、`live.html`、`publish.html`
真正调用的每个接口、每个字段都打了一遍，并对 mock（4030）和真后端（4031，anvil + 真合约）
跑同一套断言。工具已入库：

```bash
node shared/check-frontend.mjs http://127.0.0.1:4030            # 对着 mock
node shared/check-frontend.mjs http://127.0.0.1:4031            # 对着真后端
node shared/check-frontend.mjs http://127.0.0.1:4031 --with-publish   # 额外测发布（会真发信号）
```

真后端侧全部修正后：**54 项全过**。下面 6 条是前端代码里的问题，按严重程度排序。
每条都写了「为什么会炸」和「最小改法」，改完可以用上面同一套脚本回归。

| # | 位置 | 问题 | 现场后果 |
|---|---|---|---|
| F1 | `js/wallet.js:17,20` | 钱包地址只存在模块变量里，刷新即丢 | **买完刷新页面 = 没买过** |
| F2 | `live.html:77,82,110` | 提前公开后倒计时继续走、终局卡不出现 | 压轴镜头演不出来 |
| F3 | `live.html:63,108` | SSE `trade` 用 `trades.length` 覆盖买家数 | 人数从第 51 个人起不再增长 |
| F4 | `live.html:53` | 成交不按 `rank` 去重 | feed 出现重复条目、终局卡人数虚高 |
| F5 | `js/api.js:75` | `onerror` 一次就永久降级成轮询 | 弱网抖一下，整场没有实时推送 |
| F6 | `js/wallet.js:42` | `blockExplorerUrls: [cfg.explorer]`，本地链 explorer 是空串 | 本地链加网络被钱包拒绝 |

---

## F1. 买完刷新页面就"没买过"（最严重）

`wallet.js` 里 `connected` 只是一个模块级变量，只有 `connectWallet()` 会写它，而
`connectWallet()` 只在 `buy()` 里被调用。`identity()` 的取值顺序是 `connected || burner`：

```js
let connected = null;                       // :17 刷新后变回 null
export function identity() {
  if (connected) return connected;
  let a = localStorage.getItem(BURNER_KEY); // :22 于是退回一次性 burner
  ...
}
```

所以「连接钱包 → 购买 → `F5` 刷新」之后，`identity()` 返回的是 burner 地址，后端按地址
查访问权 → 查不到 → 购买页重新显示「现在买」，收据页 `api.receipt()` 直接 404。
评委现场刷新一下，付费内容就"消失"了。

**改法**（`wallet.js`，三行）：

```js
const WALLET_KEY = "alpha.wallet";

export function identity() {
  if (connected) return connected;
  const saved = localStorage.getItem(WALLET_KEY);   // 刷新后仍认得出自己
  if (saved) return saved;
  ... // 原有 burner 逻辑
}

export async function connectWallet() {
  ...
  connected = addr;
  localStorage.setItem(WALLET_KEY, addr);
  return addr;
}
```

更完整一点的话，在页面 init 时静默恢复一次（`eth_accounts` 不会弹窗，不需要用户点确认）：

```js
export async function restoreIdentity() {
  if (!window.ethereum) return null;
  const [addr] = await window.ethereum.request({ method: "eth_accounts" });
  if (addr) { connected = addr; localStorage.setItem(WALLET_KEY, addr); }
  return connected;
}
```

> 后端只按地址放行（`shared/API.md:60` 写明的「防君子」取舍），所以**只恢复地址就够了**，
> 不需要签名。

---

## F2. 提前公开后，大屏倒计时还在走、终局卡不出现

`freeAt()` 来自 `shared/curve.mjs:36`：`publishedAt + halfLife * 8` —— 它**不认识
`forcedOpen`**。而 `render()` 用 `freeAt(sig)` 算剩余时间：

```js
const left = Math.max(0, Math.ceil(freeAt(sig) - t));   // :77
$("left").textContent = `${Math.floor(left / 60)}:${...}`;
```

发布者点「提前公开」后，`priceAt` 因为 `sig.forcedOpen = true` 立刻返回 0（价格显示
「现在免费」），但「还剩」那一格还在从 3:20 往下数 —— 两个数字自相矛盾。

同一个原因导致终局卡永远不出现：

```js
if (p === 0n && !finalShown && t - freeAt(sig) > 20) showFinal();   // :82
```

提前公开时 `t < freeAt(sig)`，`t - freeAt` 是负数，条件永远不成立；要等到原始归零时间
过后 20 秒才弹。**如果这场 demo 的高潮就是「提前公开」，那这张卡根本不会出现。**

**改法**：别再用本地算的 `freeAt`，改用后端给的真实开放时间。后端在
`GET /api/live/:id` 和 SSE 里都已经给了（`forcedOpen` 时 `freeAt` 就是 `openedAt`）：

```js
let openedAt = null;                                   // 新增

// applySnapshot 里（:61）
openedAt = d.freeAt;

// render 里（:77、:82）
const free = openedAt ?? freeAt(sig);
const left = Math.max(0, Math.ceil(free - t));
...
if (p === 0n && !finalShown && t - free > 20) showFinal();

// opened 事件（:110）
opened: (d) => { openedAt = d.at; sig.forcedOpen = true; }
```

自然归零时 `d.freeAt` 就等于 `freeAt(sig)`，所以这个改动对原有路径没有副作用。

---

## F3. 买家数被 SSE 事件覆盖成 `trades.length`

两个地方写同一个 DOM，语义不同：

```js
$("buyers").textContent = d.buyers + d.claims;          // :63 快照：付费 + 领取，正确
...
trade: (t) => { addTrade(t); $("buyers").textContent = trades.length; },  // :108
```

`trades` 只包含**本页加载过**的成交，而且初始只从 `recent` 拿最近 50 条。所以：
- 成交超过 50 条的信号，页面一打开就显示 50；
- 之后每来一条 SSE，人数被重置成 `trades.length`，也就是「50 + 本次会话新增」；
- 免费领取会同时进 `trades`，但没进 `buyers`，两个口径混在一起。

**改法**：增量 +1，不要重算。

```js
trade: (t) => { if (addTrade(t)) $("buyers").textContent = Number($("buyers").textContent) + 1; },
```

（配合 F4 让 `addTrade` 返回是否真的插入了。）

---

## F4. 成交没有按 `rank` 去重

SSE 推来的 `trade` 和每 5 秒一次的 `applySnapshot` 会各插一次同一条成交。
`applySnapshot` 虽然做了去重，但门槛是 `d.recent.length > trades.length`：

```js
if (d.recent.length > trades.length) {                 // :66
  const known = new Set(trades.map((t) => t.rank));
  ...
}
```

一旦因为重复插入导致 `trades.length` 变大，这个条件更难成立 —— 去重逻辑被自己的重复
数据锁死了。表现是 feed 里同一个人出现两次，`showFinal()` 的「N 个人买了同一句话」也偏大。

**改法**：把去重放进 `addTrade` 本身。

```js
const known = new Set();
function addTrade(t) {
  if (known.has(t.rank)) return false;
  known.add(t.rank);
  trades.push(t);
  ...
  return true;
}
```

`applySnapshot` 里的 `known` 局部变量可以删掉，直接 `d.recent.slice().reverse().forEach(addTrade)`。

---

## F5. `onerror` 一次就永久降级为轮询

```js
es.onerror = () => { es.close(); poll(); };   // :75
```

`EventSource` 在**正常重连**时也会触发 `onerror`（`readyState === CONNECTING`）。
现在是无条件 `close()` + 永久轮询，于是：
- 弱网抖一下、后端重启一次，这一整场就只能拿到每秒一次的 `snapshot`；
- `trade` / `stampede` / `opened` 三个事件**再也没有了**，大屏的实时感和踩踏效果全丢；
- 轮询模式下 `handlers.snapshot` 才会被调用，`opened` 不会触发 —— 也就是 F2 里那个
  「终局卡」在降级后更不会出现。

**改法**：让浏览器先自己重连，连续失败才降级。

```js
let errs = 0;
es.onopen = () => { errs = 0; };
es.onerror = () => {
  // CONNECTING(0)：浏览器正在自己重连，别插手；CLOSED(2)：不会再连了
  if (es.readyState === EventSource.CLOSED && ++errs >= 3) { es.close(); poll(); }
};
```

---

## F6. 本地链上 `blockExplorerUrls: [""]` 会被钱包拒绝

```js
blockExplorerUrls: [cfg.explorer],   // :42
```

`local-anvil` 的 `explorer` 是空字符串（`backend/src/config.ts:55`），于是传给
`wallet_addEthereumChain` 的是 `[""]`，MetaMask 会报
`Invalid block explorer URL`，链加不进去，`buy()` 走不下去。

**改法**（一行）：

```js
blockExplorerUrls: cfg.explorer ? [cfg.explorer] : undefined,
```

顺带一提：`s.html:100` 把 `quote.amount` 原样拼进按钮文案，会显示「已锁定 $8.590000」；
`s.html:86` 用 `fmtUsdc(p).slice(0, -4)` 截成两位小数，价格低于 $0.01 时会显示「$0.00 现在买」。
都不影响功能，收尾时顺手改成 `Number(x).toFixed(2)` 或 `money()` 即可。

---

## 后端这边已经改掉的（不需要前端配合）

| 问题 | 影响 | 修复 |
|---|---|---|
| `POST /api/signals` 要求 `previewText` 至少 1 字 | 发布台不填摘要就 400，而 mock 允许 | 放宽为可空（对齐 `shared/API.md` 与 mock） |
| 校验失败返回 zod 英文原文 | 页面显示 `Required` / `String must contain at most 60 character(s)` | 全部翻成中文（`标题最多 60 个字符` / `必须勾选「本内容源自公开信息」`） |
| `/receipt` 没有链上兜底 | **付款成功到索引器跟进之间有 1.6 秒，收据 404**，`showReceipt()` 直接抛错 | 与 `/content` 一致地回 `accessOf()` 兜底，实测窗口降到 0.00s |
| mock 的 `minPaid` 把免费领取算进去 | mock 上出现 `0.000000` → 大屏走 `∞` 分支，真链永远不会 | mock 改为只统计付费成交，与 `alpha-indexer.ts` 同口径 |
| `reset-state` 不清 `deployments.json` | 部署失败后残留旧地址，服务带着不存在的合约起来，全部接口 502 | 一并清理，失败会暴露成「请先 forge script」 |
| `/api/config` 缺 `mock` 字段 | 排查"我连的是哪个后端"时看不出来 | 显式返回 `mock: false` |

## 契约本身没动

`shared/API.md` 和 `shared/contract.mjs` **一个字没改**，版本仍是 1.0.0。
新增的 `shared/check-frontend.mjs` 只是工具，不进契约。
