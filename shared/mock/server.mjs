// Mock 后端 —— 零依赖，完整实现 shared/API.md 的全部接口。
// 前端在真后端没好之前就对着它开发；真后端好了把 ?api= 指过去即可，前端代码不改。
//
//   node shared/mock/server.mjs            # 默认 :4030，信号 #1 半衰期 30s（LIVE 预设，4 分钟归零）
//   MOCK_HALFLIFE=10 PORT=4031 node shared/mock/server.mjs
//
// 额外的 mock 专用接口（真后端没有，前端只在 mock 模式下调用）：
//   POST /__mock/buy    { signalId, address, quoteId? }  模拟"钱包已链上 buy() 成功"
//   POST /__mock/reset  { halfLife? }                     重新发布 #1，从头再演一遍
//   POST /__mock/bots   { on: boolean }                   开关机器人买家
//   POST /__mock/open   { signalId }                      模拟发布者钱包调 openNow()

import http from "node:http";
import crypto from "node:crypto";
import { readFileSync, existsSync, statSync } from "node:fs";
import { resolve, dirname, extname } from "node:path";
import { fileURLToPath } from "node:url";
import { priceAt, freeAt, nextDrop, sampleCurve, fmtUsdc, OPEN_HALVINGS } from "../curve.mjs";
import { CONTRACT_VERSION } from "../contract.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const FRONTEND = resolve(HERE, "../../frontend");
const PORT = Number(process.env.PORT || 4030);
const HALFLIFE = Number(process.env.MOCK_HALFLIFE || 30);
const QUOTE_TTL = 10;
const SECRET = "mock-secret";

const CONFIG = {
  contractVersion: CONTRACT_VERSION,
  network: "eip155:10143",
  chainId: 10143,
  rpcUrl: "https://testnet-rpc.monad.xyz",
  explorer: "https://testnet.monadvision.com",
  contract: "0x000000000000000000000000000000000000a1c0",
  usdc: "0x534b2f3A21130d7a60830c2Df862319e593943A3",
  x402: true,
  mock: true,
};

const now = () => Math.floor(Date.now() / 1000);
const randAddr = () => "0x" + crypto.randomBytes(20).toString("hex");
const randTx = () => "0x" + crypto.randomBytes(32).toString("hex");
const hash32 = (s) => "0x" + crypto.createHash("sha256").update(s).digest("hex"); // 真后端用 keccak256
const isAddr = (s) => typeof s === "string" && /^0x[0-9a-fA-F]{40}$/.test(s);

// ── 状态 ────────────────────────────────────────────────
const signals = new Map(); // id → { ...sig, title, previewText, body, publisher, trades: [] }
const quotes = new Map(); // quoteId → { signalId, amountMicro, priceAt, expiresAt }
const streams = new Map(); // id → Set<res>
let botsOn = true;
let nextId = 1;

const FIXTURES = [
  {
    title: "某地址在 12 分钟前把 4.2M USDC 转进了一个新合约",
    previewText: "0x7a3f…9c21 → 0x新合约，金额 4,200,000 USDC。全文含合约地址、资金来源与可能用途。",
    body: "合约：0x9b1e…44aa（未验证源码，部署于 12 分钟前）\n资金来源：某做市商热钱包，过去 30 天无类似操作\n可能用途：新池子的初始流动性\n—— 以上为演示数据，不构成投资建议。",
  },
  {
    title: "某交易所将在 24 小时内上线新币",
    previewText: "上币公告尚未发出；全文含代币名称、开盘时间与初始流通量。",
    body: "代币：XYZ\n开盘：明日 16:00 UTC+8\n初始流通：总量 12%\n—— 以上为演示数据，不构成投资建议。",
  },
];

function publish({ title, previewText, body, basePriceMicro, floorPriceMicro, halfLife, publisher }) {
  const id = nextId++;
  signals.set(id, {
    id, title, previewText, body,
    publisher: publisher || randAddr(),
    publishedAt: now(),
    basePrice: BigInt(basePriceMicro),
    floorPrice: BigInt(floorPriceMicro),
    halfLife: Number(halfLife),
    forcedOpen: false,
    contentHash: hash32(body),
    trades: [],
    openedEmitted: false,
  });
  return id;
}

function seed() {
  signals.clear(); quotes.clear(); nextId = 1;
  publish({ ...FIXTURES[0], basePriceMicro: "10000000", floorPriceMicro: "0", halfLife: HALFLIFE });
  publish({ ...FIXTURES[1], basePriceMicro: "10000000", floorPriceMicro: "1000", halfLife: 120 });
}
seed();

// ── 视图 ────────────────────────────────────────────────
function stats(s) {
  const paid = s.trades.filter((t) => t.channel !== "free").map((t) => t.priceMicro);
  const all = s.trades.map((t) => t.priceMicro);
  const max = all.length ? all.reduce((a, b) => (b > a ? b : a)) : null;
  const min = all.length ? all.reduce((a, b) => (b < a ? b : a)) : null;
  const revenue = paid.reduce((a, b) => a + b, 0n);
  const spread = all.length >= 2 && min > 0n ? Number((max * 100n) / min) / 100 : null;
  return { buyers: paid.length, claims: all.length - paid.length, revenue, max, min, spread };
}

function status(s, t = now()) {
  const p = priceAt(s, t);
  if (p > 0n) return "LIVE";
  const opened = s.forcedOpen ? s.openedAt : freeAt(s);
  return t - opened > 1800 ? "CLOSED" : "OPEN";
}

function signalView(s) {
  const t = now();
  const p = priceAt(s, t);
  const st = stats(s);
  const nd = nextDrop(s, t);
  return {
    id: s.id,
    title: s.title,
    previewText: s.previewText,
    publisher: s.publisher,
    publishedAt: s.publishedAt,
    basePrice: fmtUsdc(s.basePrice),
    basePriceMicro: s.basePrice.toString(),
    floorPrice: fmtUsdc(s.floorPrice),
    floorPriceMicro: s.floorPrice.toString(),
    halfLife: s.halfLife,
    freeAt: s.forcedOpen ? s.openedAt : freeAt(s),
    forcedOpen: s.forcedOpen,
    price: fmtUsdc(p),
    priceMicro: p.toString(),
    timeToFree: p === 0n ? 0 : Math.max(0, freeAt(s) - t),
    halvingsElapsed: Math.round(((t - s.publishedAt) / s.halfLife) * 100) / 100,
    nextDropIn: p === 0n ? 0 : nd.inSec,
    nextDropAmount: fmtUsdc(p === 0n ? 0n : nd.amount),
    buyers: st.buyers,
    revenue: fmtUsdc(st.revenue),
    spread: st.spread,
    status: status(s, t),
    network: CONFIG.network,
    contract: CONFIG.contract,
    serverTime: t,
  };
}

const tradeView = ({ priceMicro, ...t }) => ({ ...t, price: fmtUsdc(priceMicro) });

function curveView(s, samples) {
  const c = sampleCurve(s, samples);
  return { times: c.times, prices: c.prices.map(fmtUsdc) };
}

function liveView(s) {
  const v = signalView(s);
  const st = stats(s);
  return {
    signalId: s.id,
    title: s.title,
    price: v.price,
    priceMicro: v.priceMicro,
    timeToFree: v.timeToFree,
    freeAt: v.freeAt,
    buyers: st.buyers,
    claims: st.claims,
    revenue: fmtUsdc(st.revenue),
    maxPaid: st.max === null ? null : fmtUsdc(st.max),
    minPaid: st.min === null ? null : fmtUsdc(st.min),
    spread: st.spread,
    recent: s.trades.slice(-50).reverse().map(tradeView),
    curve: curveView(s, 120),
    status: v.status,
    serverTime: v.serverTime,
    blockNumber: 4_281_000 + (now() % 100000) * 2,
  };
}

// ── 成交 ────────────────────────────────────────────────
function record(s, address, priceMicro, channel) {
  const t = now();
  const trade = {
    rank: s.trades.length + 1,
    buyer: address,
    label: address.slice(2, 6),
    priceMicro,
    elapsed: t - s.publishedAt,
    at: t,
    channel,
    txHash: channel === "free" ? null : randTx(),
  };
  s.trades.push(trade);
  broadcast(s.id, "trade", tradeView(trade));
  return trade;
}

const findTrade = (s, address) => s.trades.find((t) => t.buyer.toLowerCase() === address.toLowerCase());

function contentView(s, trade) {
  return {
    signalId: s.id,
    title: s.title,
    body: s.body,
    contentHash: s.contentHash,
    channel: trade.channel,
    paid: fmtUsdc(trade.priceMicro),
    rank: trade.rank,
  };
}

function receiptView(s, trade) {
  const first = s.trades[0].priceMicro;
  const paid = trade.priceMicro;
  const multiple = paid === 0n ? "∞" : (Number((first * 100n) / paid) / 100).toFixed(2);
  const payload = `${s.id}|${trade.buyer}|${fmtUsdc(paid)}|${trade.rank}`;
  return {
    signalId: s.id,
    address: trade.buyer,
    rank: trade.rank,
    paid: fmtUsdc(paid),
    firstPaid: fmtUsdc(first),
    multipleVsFirst: multiple,
    elapsed: trade.elapsed,
    contentHash: s.contentHash,
    signature: "0x" + crypto.createHmac("sha256", SECRET).update(payload).digest("hex"),
  };
}

function makeQuote(s) {
  const t = now();
  const p = priceAt(s, t);
  const quoteId = "q_" + crypto.randomBytes(4).toString("hex");
  const q = { signalId: s.id, amountMicro: p, priceAt: t, expiresAt: t + QUOTE_TTL };
  quotes.set(quoteId, q);
  return {
    quoteId,
    signalId: s.id,
    amount: fmtUsdc(p),
    amountMicro: p.toString(),
    priceAt: t,
    expiresAt: q.expiresAt,
    network: CONFIG.network,
    asset: CONFIG.usdc,
    payTo: s.publisher,
  };
}

// ── SSE ────────────────────────────────────────────────
function broadcast(id, event, data) {
  for (const res of streams.get(id) || []) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

setInterval(() => {
  for (const s of signals.values()) {
    const v = signalView(s);
    broadcast(s.id, "tick", { price: v.price, priceMicro: v.priceMicro, timeToFree: v.timeToFree, serverTime: v.serverTime });
    if (v.priceMicro === "0" && !s.openedEmitted) {
      s.openedEmitted = true;
      broadcast(s.id, "opened", { at: v.freeAt });
    }
  }
}, 400);

// 机器人买家：早期稀疏、越便宜越多；归零后来一波踩踏
setInterval(() => {
  if (!botsOn) return;
  const s = signals.get(1);
  if (!s) return;
  const t = now();
  const p = priceAt(s, t);
  if (p > 0n) {
    const progress = (t - s.publishedAt) / (s.halfLife * OPEN_HALVINGS);
    if (Math.random() < 0.08 + progress * 0.35) record(s, randAddr(), p, Math.random() < 0.3 ? "x402" : "onchain");
  } else if (t - freeAt(s) < 15) {
    const before = stats(s).claims;
    const n = 3 + Math.floor(Math.random() * 10);
    for (let i = 0; i < n; i++) record(s, randAddr(), 0n, "free");
    broadcast(s.id, "stampede", { claims: before + n, window: "1s" });
  }
}, 1000);

// ── HTTP ────────────────────────────────────────────────
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "*",
  "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
  "Access-Control-Expose-Headers": "PAYMENT-REQUIRED, PAYMENT-RESPONSE, X-Quote-Id",
};

function send(res, code, body, headers = {}) {
  res.writeHead(code, { "Content-Type": "application/json; charset=utf-8", ...CORS, ...headers });
  res.end(JSON.stringify(body));
}
const fail = (res, code, errCode, message, headers) => send(res, code, { error: { code: errCode, message } }, headers);

async function readJson(req) {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  try { return raw ? JSON.parse(raw) : {}; } catch { return {}; }
}

const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8", ".css": "text/css", ".png": "image/png", ".svg": "image/svg+xml", ".json": "application/json" };
// 漂亮路径 → 实际页面（页面本身只认 ?id=，这样任何静态服务器都能托管 frontend/）
const PRETTY = [[/^\/s\/(\d+)\/?$/, "s.html"], [/^\/live\/(\d+)\/?$/, "live.html"], [/^\/publish\/?$/, "publish.html"]];

function serveStatic(res, pathname) {
  for (const [re, page] of PRETTY) {
    const m = pathname.match(re);
    if (m) return res.writeHead(302, { Location: `/${page}${m[1] ? `?id=${m[1]}` : ""}` }).end(), true;
  }
  const file = resolve(FRONTEND, "." + (pathname === "/" ? "/index.html" : decodeURIComponent(pathname)));
  if (!file.startsWith(FRONTEND) || !existsSync(file) || statSync(file).isDirectory()) return false;
  res.writeHead(200, { "Content-Type": MIME[extname(file)] || "application/octet-stream", "Cache-Control": "no-store" });
  res.end(readFileSync(file));
  return true;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  const p = url.pathname;
  if (req.method === "OPTIONS") return res.writeHead(204, CORS).end();

  if (p === "/health") return send(res, 200, { ok: true, mock: true, network: CONFIG.network, chainId: CONFIG.chainId, contract: CONFIG.contract });
  if (p === "/api/config") return send(res, 200, CONFIG);

  if (p === "/api/signals" && req.method === "GET") {
    return send(res, 200, { signals: [...signals.values()].reverse().map(signalView) });
  }
  if (p === "/api/signals" && req.method === "POST") {
    const b = await readJson(req);
    if (!b.title || !b.body || !b.basePriceMicro || !b.halfLife) return fail(res, 400, "BAD_PARAMS", "需要 title/body/basePriceMicro/halfLife");
    if (BigInt(b.floorPriceMicro || 0) > BigInt(b.basePriceMicro)) return fail(res, 400, "BAD_PARAMS", "floor 不能高于 base");
    const id = publish({ ...b, previewText: b.previewText || "", floorPriceMicro: b.floorPriceMicro || "0" });
    return send(res, 201, { id, url: `/s/${id}`, txHash: randTx() });
  }

  // /__mock/*
  if (p === "/__mock/reset" && req.method === "POST") {
    const b = await readJson(req);
    seed();
    if (b.halfLife) signals.get(1).halfLife = Number(b.halfLife);
    return send(res, 200, { ok: true });
  }
  if (p === "/__mock/bots" && req.method === "POST") {
    botsOn = !!(await readJson(req)).on;
    return send(res, 200, { ok: true, botsOn });
  }
  if (p === "/__mock/open" && req.method === "POST") {
    const s = signals.get(Number((await readJson(req)).signalId));
    if (!s) return fail(res, 404, "NOT_FOUND", "信号不存在");
    if (s.forcedOpen) return fail(res, 409, "CLOSED", "该信号已公开");
    Object.assign(s, { forcedOpen: true, openedAt: now() });
    broadcast(s.id, "opened", { at: s.openedAt });
    return send(res, 200, { txHash: randTx() });
  }
  if (p === "/__mock/buy" && req.method === "POST") {
    const b = await readJson(req);
    const s = signals.get(Number(b.signalId));
    if (!s) return fail(res, 404, "NOT_FOUND", "信号不存在");
    if (!isAddr(b.address)) return fail(res, 400, "BAD_PARAMS", "address 不合法");
    if (findTrade(s, b.address)) return fail(res, 409, "ALREADY_OWN", "你已经拿到了");
    const live = priceAt(s, now());
    if (live === 0n) return fail(res, 409, "FREE_ALREADY", "现在已经免费了，直接领取");
    const q = quotes.get(b.quoteId);
    const t = record(s, b.address, q && q.signalId === s.id ? q.amountMicro : live, "onchain");
    return send(res, 200, { txHash: t.txHash });
  }

  let m;
  if ((m = p.match(/^\/api\/(signals|live)\/(\d+)(\/[a-z]+)?$/))) {
    const [, kind, idStr, sub = ""] = m;
    const s = signals.get(Number(idStr));
    if (!s) return fail(res, 404, "NOT_FOUND", "信号不存在");
    const route = `${kind}${sub}`;

    if (route === "signals") return send(res, 200, signalView(s));
    if (route === "signals/curve") return send(res, 200, curveView(s, Math.min(512, Number(url.searchParams.get("samples")) || 120)));
    if (route === "signals/trades") return send(res, 200, { trades: s.trades.map(tradeView) });
    if (route === "signals/quote") {
      if (priceAt(s, now()) === 0n) return fail(res, 409, "FREE_ALREADY", "现在已经免费了，直接领取");
      return send(res, 200, makeQuote(s));
    }

    if (route === "signals/content") {
      const buyer = url.searchParams.get("buyer");
      const owned = buyer && isAddr(buyer) && findTrade(s, buyer);
      if (owned) return send(res, 200, contentView(s, owned));
      if (priceAt(s, now()) === 0n) return fail(res, 409, "FREE_ALREADY", "现在已经免费了，请先 POST /claim");
      // x402：带了支付头就当作 facilitator 已结算
      const paidHeader = req.headers["payment-signature"] || req.headers["x-payment"];
      const q = quotes.get(url.searchParams.get("quoteId") || "");
      if (paidHeader && isAddr(buyer)) {
        const t = record(s, buyer, q && q.signalId === s.id ? q.amountMicro : priceAt(s, now()), "x402");
        return send(res, 200, contentView(s, t), { "PAYMENT-RESPONSE": Buffer.from(JSON.stringify({ success: true, transaction: t.txHash })).toString("base64") });
      }
      const quote = q && q.signalId === s.id ? null : makeQuote(s);
      const amountMicro = q && q.signalId === s.id ? q.amountMicro : BigInt(quote.amountMicro);
      const requirements = { x402Version: 2, accepts: [{ scheme: "exact", network: CONFIG.network, asset: CONFIG.usdc, amount: amountMicro.toString(), payTo: s.publisher, maxTimeoutSeconds: 60 }] };
      const headers = { "PAYMENT-REQUIRED": Buffer.from(JSON.stringify(requirements)).toString("base64") };
      if (quote) headers["X-Quote-Id"] = quote.quoteId;
      return fail(res, 402, "PAYMENT_REQUIRED", `需要支付 $${fmtUsdc(amountMicro)}`, headers);
    }

    if (route === "signals/claim" && req.method === "POST") {
      const { address } = await readJson(req);
      if (!isAddr(address)) return fail(res, 400, "BAD_PARAMS", "address 不合法");
      const owned = findTrade(s, address);
      if (owned) return send(res, 200, contentView(s, owned));
      if (priceAt(s, now()) > 0n) return fail(res, 409, "NOT_FREE_YET", "还没到免费时间");
      return send(res, 200, contentView(s, record(s, address, 0n, "free")));
    }

    if (route === "signals/receipt") {
      const address = url.searchParams.get("address");
      const owned = isAddr(address) && findTrade(s, address);
      if (!owned) return fail(res, 404, "NOT_FOUND", "这个地址没有该信号的访问记录");
      return send(res, 200, receiptView(s, owned));
    }

    if (route === "live") return send(res, 200, liveView(s));
    if (route === "live/stream") {
      res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive", ...CORS });
      res.write(": connected\n\n");
      if (!streams.has(s.id)) streams.set(s.id, new Set());
      streams.get(s.id).add(res);
      req.on("close", () => streams.get(s.id).delete(res));
      return;
    }
  }

  if (req.method === "GET" && serveStatic(res, p)) return;
  fail(res, 404, "NOT_FOUND", `没有这个接口：${req.method} ${p}`);
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`\n  Alpha Clock MOCK 后端  http://localhost:${PORT}`);
  console.log(`  信号 #1 半衰期 ${HALFLIFE}s（${HALFLIFE * OPEN_HALVINGS}s 后归零），机器人买家已开`);
  console.log(`  购买页  http://localhost:${PORT}/s/1`);
  console.log(`  大屏    http://localhost:${PORT}/live/1`);
  console.log(`  发布台  http://localhost:${PORT}/publish\n`);
});
