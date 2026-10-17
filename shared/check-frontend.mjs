#!/usr/bin/env node
/**
 * Alpha Clock · 前端契约冒烟检查器
 *
 * 用途：用一个「假前端」去打真实后端，检查前端代码真正读取的每一个字段。
 *       check-contract.mjs 验的是「后端符合 shared/API.md」；
 *       本脚本验的是「前端能照着 API.md 正常读」—— 两者不是一回事：
 *       字段名对、但类型不对（比如 buyers 是 string），契约校验通过，前端却会算错。
 *
 * 用法：
 *   node shared/check-frontend.mjs                            # 默认 http://127.0.0.1:4030
 *   node shared/check-frontend.mjs http://127.0.0.1:4030
 *   node shared/check-frontend.mjs <base> --with-publish      # 额外测 POST /api/signals（会真发信号）
 *
 * 退出码：0 = 通过；1 = 有失败项
 *
 * 为什么要单独放一个脚本：mock 和真后端是两份实现。前端是先对着 mock 写完的，
 * 两边只要有一边偷偷 diverged（比如摘要字段一边必填一边可选），
 * 现场把 ?api= 指过去才炸。这个脚本对两边都能跑，跑完对比结果即可。
 */

import { priceAt, fmtUsdc } from "./curve.mjs";

const args = process.argv.slice(2);
const BASE = (args.find((a) => a.startsWith("http")) ?? "http://127.0.0.1:4030").replace(/\/$/, "");
const WITH_PUBLISH = args.includes("--with-publish");

const pass = [];
const fail = [];
const ok = (m) => pass.push(m);
const bad = (m) => fail.push(m);
const check = (cond, m) => (cond ? ok(m) : bad(m));

async function call(path, { method = "GET", body, headers } = {}) {
  const res = await fetch(BASE + path, {
    method,
    headers: body ? { "Content-Type": "application/json", ...headers } : headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data, headers: res.headers };
}

const isUsdc = (v) => typeof v === "string" && /^\d+\.\d{6}$/.test(v);
const isMicro = (v) => typeof v === "string" && /^\d+$/.test(v);
const isAddr = (v) => typeof v === "string" && /^0x[0-9a-fA-F]{40}$/.test(v);

console.log(`\n  Alpha Clock 前端契约冒烟 —— ${BASE}${WITH_PUBLISH ? "（含发布）" : ""}\n`);

// ── 1. /api/config：wallet.js 读 chainId / rpcUrl / explorer / usdc / contract；三处页面读 mock / network
const cfgRes = await call("/api/config");
const cfg = cfgRes.data;
check(cfgRes.status === 200, `GET /api/config → 200（实际 ${cfgRes.status}）`);
check(Number.isInteger(cfg.chainId), "config.chainId 是 number（wallet 里要 .toString(16)）");
check(typeof cfg.rpcUrl === "string" && /^https?:\/\//.test(cfg.rpcUrl), "config.rpcUrl 是可用的 http(s) 地址");
check(typeof cfg.explorer === "string", "config.explorer 存在");
if (cfg.explorer === "") {
  ok("config.explorer 为空串 → 前端不能直接塞进 blockExplorerUrls（见 docs/FE-INTEGRATION-REVIEW.md F6）");
}
check(isAddr(cfg.usdc), "config.usdc 是地址（approve 用）");
check(isAddr(cfg.contract), "config.contract 是地址（buy 用）");
check(typeof cfg.network === "string", "config.network 存在（大屏页脚显示）");
check(cfg.mock === true || cfg.mock === false, "config.mock 是显式布尔值（前端据此决定走钱包还是 /__mock/buy）");

// ── 2. /api/signals：index.html 读 id / title / price
const list = await call("/api/signals");
check(list.status === 200 && Array.isArray(list.data.signals), "GET /api/signals → { signals: [] }");
const signals = list.data.signals ?? [];
check(signals.length > 0, `信号列表非空（${signals.length} 条）`);
const first = signals[signals.length - 1] ?? {};
check(Number.isInteger(first.id) && typeof first.title === "string", "列表项有 id / title");
check(isUsdc(first.price), "列表项 price 是 usdc 字符串");
check(Number.isInteger(first.buyers), "列表项 buyers 是 number（s.html 里 `meta.buyers ? ...` 判真假）");

// 取一条仍然 LIVE 的信号做后续检查；都免费了就退而用第一条
const live = signals.find((s) => s.status === "LIVE") ?? first;
const id = live.id;
console.log(`  使用信号 #${id}（${live.status}）\n`);

// ── 3. /api/signals/:id：s.html 的 toCurveSig 读 publishedAt/basePriceMicro/floorPriceMicro/halfLife/forcedOpen
const sigRes = await call(`/api/signals/${id}`);
const meta = sigRes.data;
check(sigRes.status === 200, `GET /api/signals/${id} → 200`);
check(Number.isInteger(meta.publishedAt), "signal.publishedAt 是整数");
check(isMicro(meta.basePriceMicro), "signal.basePriceMicro 是微单位整数字符串");
check(isMicro(meta.floorPriceMicro), "signal.floorPriceMicro 是微单位整数字符串");
check(Number.isInteger(meta.halfLife), "signal.halfLife 是整数");
check(typeof meta.forcedOpen === "boolean", "signal.forcedOpen 是布尔");
check(Number.isInteger(meta.serverTime), "signal.serverTime 存在（syncClock 校准用）");
check(typeof meta.previewText === "string", "signal.previewText 是字符串（购买页直接展示）");
check(["LIVE", "OPEN", "CLOSED"].includes(meta.status), `signal.status 合法（${meta.status}）`);

{
  // 前端 400ms 本地插值，后端也报一个价格 —— 两边必须逐位一致，否则大屏和购买页对不上
  const local = priceAt(
    { publishedAt: meta.publishedAt, basePrice: BigInt(meta.basePriceMicro), floorPrice: BigInt(meta.floorPriceMicro), halfLife: meta.halfLife, forcedOpen: meta.forcedOpen },
    meta.serverTime,
  );
  check(fmtUsdc(local) === meta.price, `后端 price=${meta.price} 与 shared/curve.mjs 本地插值一致`);
}

// ── 4. quote：s.html 读 quoteId / amount / amountMicro
if (meta.status === "LIVE") {
  const q = await call(`/api/signals/${id}/quote`);
  check(q.status === 200, `GET /quote → 200（实际 ${q.status} ${q.data?.error?.code ?? ""}）`);
  check(isUsdc(q.data.amount), "quote.amount 是 usdc 字符串（页面直接拼 $）");
  check(isMicro(q.data.amountMicro), "quote.amountMicro 是整数字符串（wallet 转 BigInt）");
  check(typeof q.data.quoteId === "string" && q.data.quoteId.length > 0, "quote.quoteId 存在");
  check(Number.isInteger(q.data.expiresAt), "quote.expiresAt 存在");
  check(isAddr(q.data.payTo), "quote.payTo 是地址（x402 收款方）");
} else {
  const q = await call(`/api/signals/${id}/quote`);
  check(q.status === 409 && q.data?.error?.code === "FREE_ALREADY", `免费信号 /quote → 409 FREE_ALREADY（实际 ${q.status}）`);
}

// ── 5. /content 未授权：必须 402 + PAYMENT_REQUIRED + 暴露 X-Quote-Id
{
  const stranger = "0x" + "11".repeat(20);
  const r = await call(`/api/signals/${id}/content?buyer=${stranger}`);
  if (meta.status === "LIVE") {
    check(r.status === 402 && r.data?.error?.code === "PAYMENT_REQUIRED", `未付款 /content → 402 PAYMENT_REQUIRED（实际 ${r.status} ${r.data?.error?.code}）`);
    check(Boolean(r.headers.get("x-quote-id")), "402 响应带 X-Quote-Id");
    check(Boolean(r.headers.get("payment-required")), "402 响应带 PAYMENT-REQUIRED");
    check((r.headers.get("access-control-expose-headers") ?? "").includes("X-Quote-Id"), "CORS 暴露 X-Quote-Id（否则浏览器读不到）");
  } else {
    check(r.status === 409 && r.data?.error?.code === "FREE_ALREADY", `免费后 /content → 409 FREE_ALREADY（实际 ${r.status}）`);
  }
}

// ── 6. claim / receipt 的错误语义
{
  // 两个检查用不同地址：免费信号上 claim 会成功建档，同地址再查 receipt 就是 200 了
  const claimer = "0x" + "22".repeat(20);
  const stranger = "0x" + "33".repeat(20);
  const c = await call(`/api/signals/${id}/claim`, { method: "POST", body: { address: claimer } });
  if (meta.status === "LIVE") {
    check(c.status === 409 && c.data?.error?.code === "NOT_FREE_YET", `未到期 claim → NOT_FREE_YET（实际 ${c.status}）`);
  }
  const rc = await call(`/api/signals/${id}/receipt?address=${stranger}`);
  check(rc.status === 404 && rc.data?.error?.code === "NOT_FOUND", `无记录 receipt → 404 NOT_FOUND（实际 ${rc.status}）`);
}

// ── 7. /api/live：live.html 读 buyers / claims / maxPaid / minPaid / spread / recent / serverTime
{
  const r = await call(`/api/live/${id}`);
  const d = r.data;
  check(r.status === 200, `GET /api/live/${id} → 200`);
  check(Number.isInteger(d.buyers) && Number.isInteger(d.claims), "live.buyers / claims 是 number（大屏相加显示）");
  check(d.maxPaid === null || isUsdc(d.maxPaid), "live.maxPaid 是 usdc 或 null");
  check(d.minPaid === null || isUsdc(d.minPaid), "live.minPaid 是 usdc 或 null");
  check(d.spread === null || typeof d.spread === "number", "live.spread 是 number 或 null（页面拼 ×）");
  check(isUsdc(d.revenue), "live.revenue 是 usdc 字符串");
  check(Array.isArray(d.recent), "live.recent 是数组");
  for (const t of d.recent ?? []) {
    check(Number.isInteger(t.rank), `recent[${t.rank}].rank 是整数（去重用）`);
    check(typeof t.label === "string" && typeof t.channel === "string", `recent[${t.rank}] 有 label / channel`);
    check(isUsdc(t.price), `recent[${t.rank}].price 是 usdc 字符串`);
    check(Number.isInteger(t.elapsed), `recent[${t.rank}].elapsed 是整数（打点横坐标）`);
  }
  check(Number.isInteger(d.serverTime), "live.serverTime 存在");
  if (d.minPaid === "0.000000") {
    bad("live.minPaid 出现 0.000000 —— 免费领取不应算进「成交价」，前端那行 ∞ 分支会被误触发");
  }
}

// ── 8. SSE
{
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 5000);
  try {
    const r = await fetch(`${BASE}/api/live/${id}/stream`, { signal: ctrl.signal });
    check(r.headers.get("content-type")?.includes("text/event-stream"), "SSE Content-Type 正确");
    check(r.headers.get("access-control-allow-origin") === "*", "SSE 带 CORS 头（跨端口 EventSource 必须）");
    const reader = r.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    while (!buf.includes("event: tick")) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value);
    }
    check(buf.includes("event: tick"), "SSE 5s 内收到 tick");
    const line = buf.split("\n").find((l) => l.startsWith("data:") && l.includes("priceMicro"));
    const payload = line ? JSON.parse(line.slice(5)) : {};
    check(isMicro(payload.priceMicro), "tick.priceMicro 是整数字符串");
    check(isUsdc(payload.price), "tick.price 是 usdc 字符串");
    check(Number.isInteger(payload.serverTime), "tick.serverTime 存在");
    ctrl.abort();
  } catch (e) {
    if (e.name !== "AbortError") bad("SSE 连接失败：" + e.message);
  } finally {
    clearTimeout(timer);
  }
}

// ── 9. 发布：完全照 publish.html 的字段（摘要可空、burst 预设 floor=0）
if (WITH_PUBLISH) {
  const empty = await call("/api/signals", {
    method: "POST",
    body: { title: "冒烟：空摘要", previewText: "", body: "正文", basePriceMicro: "10000000", floorPriceMicro: "1000", halfLife: 120, attestPublicSource: true },
  });
  check(empty.status === 201, `摘要留空可以发布（实际 ${empty.status} ${JSON.stringify(empty.data)}）`);
  if (empty.status === 201) {
    const back = await call(`/api/signals/${empty.data.id}`);
    check(back.data.previewText === "", "空摘要回读仍是空字符串");
  }
  const burst = await call("/api/signals", {
    method: "POST",
    body: { title: "冒烟：burst 预设", previewText: "摘要", body: "正文", basePriceMicro: "10000000", floorPriceMicro: "0", halfLife: 30, attestPublicSource: true },
  });
  check(burst.status === 201, `burst 预设（floor=0）可以发布（实际 ${burst.status}）`);

  const noAttest = await call("/api/signals", {
    method: "POST",
    body: { title: "冒烟", previewText: "摘要", body: "正文", basePriceMicro: "10000000", floorPriceMicro: "0", halfLife: 30, attestPublicSource: false },
  });
  check(/[\u4e00-\u9fa5]/.test(noAttest.data?.error?.message ?? ""), `校验失败时 message 是中文（实际「${noAttest.data?.error?.message}」）`);
}

// ── 结果
console.log(`  通过 ${pass.length} 项`);
if (fail.length) {
  console.log(`\n  ✘ 失败 ${fail.length} 项：`);
  for (const f of fail) console.log("    - " + f);
  console.log("");
  process.exit(1);
}
console.log("  ✓ 全部通过\n");
