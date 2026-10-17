// 契约验收：对任意后端（mock 或真后端）跑一遍，逐个接口校验返回结构。
//   node shared/check-contract.mjs                       # 默认 http://127.0.0.1:4030
//   node shared/check-contract.mjs http://192.168.1.8:4030 [signalId]
// 后端提 PR 前必须全绿；前端只依赖这里校验过的字段。

import * as C from "./contract.mjs";

const BASE = (process.argv[2] || "http://127.0.0.1:4030").replace(/\/$/, "");
const ID = Number(process.argv[3] || 1);
const PROBE = "0x000000000000000000000000000000000000dEaD";

const rows = [];
const check = async (name, fn) => {
  try {
    const errs = (await fn()) || [];
    rows.push([errs.length ? "✗" : "✓", name, errs.slice(0, 4).join("; ")]);
  } catch (e) {
    rows.push(["✗", name, String(e.message || e)]);
  }
};

async function get(path, init) {
  const r = await fetch(BASE + path, init);
  const text = await r.text();
  let body;
  try { body = JSON.parse(text); } catch { body = text; }
  return { status: r.status, headers: r.headers, body };
}

const expect = (r, code, schema) =>
  r.status !== code ? [`HTTP ${r.status}（应为 ${code}）${JSON.stringify(r.body).slice(0, 120)}`] : C.validate(r.body, schema);

// 错误必须走统一格式
const expectError = (r, codes) => {
  if (r.status < 400) return [`HTTP ${r.status}（应为错误）`];
  const errs = C.validate(r.body, C.ErrorBody);
  if (!errs.length && !codes.includes(r.body.error.code)) errs.push(`error.code=${r.body.error.code}（应为 ${codes.join("/")}）`);
  return errs;
};

let sig;
await check("GET /health", async () => { const r = await get("/health"); return r.status === 200 ? [] : [`HTTP ${r.status}`]; });
await check("GET /api/config", async () => expect(await get("/api/config"), 200, C.Config));
await check("GET /api/signals", async () => expect(await get("/api/signals"), 200, { signals: [C.Signal] }));
await check(`GET /api/signals/${ID}`, async () => { const r = await get(`/api/signals/${ID}`); sig = r.body; return expect(r, 200, C.Signal); });
await check("GET /api/signals/999999 → 404", async () => expectError(await get("/api/signals/999999"), ["NOT_FOUND"]));
await check(`GET /api/signals/${ID}/curve`, async () => expect(await get(`/api/signals/${ID}/curve?samples=64`), 200, C.Curve));
await check(`GET /api/signals/${ID}/trades`, async () => expect(await get(`/api/signals/${ID}/trades`), 200, { trades: [C.Trade] }));

const live = sig && sig.priceMicro !== "0";
await check(`GET /api/signals/${ID}/quote`, async () => {
  const r = await get(`/api/signals/${ID}/quote`);
  return live ? expect(r, 200, C.Quote) : expectError(r, ["FREE_ALREADY"]);
});
await check(`GET /api/signals/${ID}/content（未付款）`, async () => {
  const r = await get(`/api/signals/${ID}/content?buyer=${PROBE}`);
  if (!live) return expectError(r, ["FREE_ALREADY"]);
  const errs = expectError(r, ["PAYMENT_REQUIRED"]);
  if (r.status !== 402) errs.push(`HTTP ${r.status}（应为 402）`);
  if (!r.headers.get("payment-required")) errs.push("缺 PAYMENT-REQUIRED 响应头（或未在 Access-Control-Expose-Headers 暴露）");
  return errs;
});
await check(`POST /api/signals/${ID}/claim`, async () => {
  const r = await get(`/api/signals/${ID}/claim`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ address: PROBE }) });
  return live ? expectError(r, ["NOT_FREE_YET"]) : expect(r, 200, C.Content);
});
await check(`GET /api/signals/${ID}/receipt（无记录）`, async () => {
  const r = await get(`/api/signals/${ID}/receipt?address=0x000000000000000000000000000000000000bEEF`);
  return expectError(r, ["NOT_FOUND"]);
});
await check(`GET /api/live/${ID}`, async () => expect(await get(`/api/live/${ID}`), 200, C.Live));
await check("CORS 头", async () => {
  const r = await fetch(`${BASE}/api/signals/${ID}`, { headers: { Origin: "http://localhost:5173" } });
  return r.headers.get("access-control-allow-origin") ? [] : ["缺 Access-Control-Allow-Origin"];
});
await check(`SSE /api/live/${ID}/stream（3s 内收到 tick）`, async () => {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 3000);
  try {
    const r = await fetch(`${BASE}/api/live/${ID}/stream`, { signal: ctrl.signal });
    if (!String(r.headers.get("content-type")).includes("text/event-stream")) return ["content-type 不是 text/event-stream"];
    const reader = r.body.getReader();
    let buf = "";
    while (true) {
      const { value, done } = await reader.read();
      if (done) return ["流提前结束"];
      buf += new TextDecoder().decode(value);
      const m = buf.match(/event: tick\ndata: (.*)\n\n/);
      if (m) return C.validate(JSON.parse(m[1]), C.StreamEvents.tick, "tick");
    }
  } catch (e) {
    return [ctrl.signal.aborted ? "3s 内没有 tick 事件" : String(e)];
  } finally {
    clearTimeout(timer);
    ctrl.abort();
  }
});

console.log(`\n契约 v${C.CONTRACT_VERSION} → ${BASE}（信号 #${ID}，当前${live ? "未归零" : "已归零"}）\n`);
for (const [ok, name, why] of rows) console.log(`  ${ok} ${name}${why ? `\n      ${why}` : ""}`);
const bad = rows.filter((r) => r[0] === "✗").length;
console.log(`\n  ${rows.length - bad}/${rows.length} 通过\n`);
process.exit(bad ? 1 : 0);
