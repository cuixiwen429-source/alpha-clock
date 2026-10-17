// 前端唯一的后端入口。页面不直接写 fetch，全部走这里；接口定义见 shared/API.md。
//
// 后端地址优先级：?api=http://host:4030（会记住） > localStorage > 当前页面同源
//   ?api=reset 清掉记忆，回到同源

const LS_KEY = "alpha.api";

function resolveBase() {
  const q = new URLSearchParams(location.search).get("api");
  if (q === "reset") localStorage.removeItem(LS_KEY);
  else if (q) localStorage.setItem(LS_KEY, q.replace(/\/$/, ""));
  return localStorage.getItem(LS_KEY) || location.origin;
}

export const API_BASE = resolveBase();

export class ApiError extends Error {
  constructor(status, code, message, headers) {
    super(message);
    Object.assign(this, { status, code, headers });
  }
}

async function call(path, { method = "GET", body, headers = {} } = {}) {
  let r;
  try {
    r = await fetch(API_BASE + path, {
      method,
      headers: body ? { "Content-Type": "application/json", ...headers } : headers,
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch (e) {
    throw new ApiError(0, "NETWORK", "连不上后端：" + API_BASE);
  }
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new ApiError(r.status, data.error?.code || "HTTP_" + r.status, data.error?.message || r.statusText, r.headers);
  return data;
}

let _config;
export const api = {
  base: API_BASE,
  config: () => (_config ??= call("/api/config")),
  signals: () => call("/api/signals").then((d) => d.signals),
  signal: (id) => call(`/api/signals/${id}`),
  curve: (id, samples = 120) => call(`/api/signals/${id}/curve?samples=${samples}`),
  trades: (id) => call(`/api/signals/${id}/trades`).then((d) => d.trades),
  quote: (id) => call(`/api/signals/${id}/quote`),
  /** 已有访问权（链上买过 / 已领取）时直接拿正文；否则抛 402 PAYMENT_REQUIRED */
  content: (id, buyer, { quoteId, paymentHeader } = {}) =>
    call(`/api/signals/${id}/content?buyer=${buyer}${quoteId ? `&quoteId=${quoteId}` : ""}`, {
      headers: paymentHeader ? { "PAYMENT-SIGNATURE": paymentHeader } : {},
    }),
  claim: (id, address) => call(`/api/signals/${id}/claim`, { method: "POST", body: { address } }),
  receipt: (id, address) => call(`/api/signals/${id}/receipt?address=${address}`),
  publish: (payload) => call("/api/signals", { method: "POST", body: payload }),
  live: (id) => call(`/api/live/${id}`),

  /**
   * 订阅大屏实时流。SSE 断了自动降级为 1s 轮询（PRD §8.7）。
   * handlers: { tick, trade, stampede, opened, snapshot }；snapshot 只在轮询模式下触发，参数是 /api/live/:id 全量
   * 返回取消函数。
   */
  stream(id, handlers) {
    let es, timer, closed = false;
    const poll = () => {
      if (closed || timer) return;
      timer = setInterval(() => api.live(id).then((d) => handlers.snapshot?.(d)).catch(() => {}), 1000);
    };
    try {
      es = new EventSource(`${API_BASE}/api/live/${id}/stream`);
      for (const ev of ["tick", "trade", "stampede", "opened"]) {
        es.addEventListener(ev, (e) => handlers[ev]?.(JSON.parse(e.data)));
      }
      es.onerror = () => { es.close(); poll(); };
    } catch {
      poll();
    }
    return () => { closed = true; es?.close(); clearInterval(timer); };
  },

  // ── 仅 mock 模式 ──
  mockBuy: (signalId, address, quoteId) => call("/__mock/buy", { method: "POST", body: { signalId, address, quoteId } }),
  mockReset: (halfLife) => call("/__mock/reset", { method: "POST", body: { halfLife } }),
};

/** 服务端时钟偏移：本地插值价格时用 serverNow() 而不是 Date.now() */
let offset = 0;
export const syncClock = (serverTime) => { offset = serverTime - Date.now() / 1000; };
export const serverNow = () => Date.now() / 1000 + offset;

/** /api/signals/:id 的返回 → curve.mjs 需要的结构 */
export const toCurveSig = (s) => ({
  publishedAt: s.publishedAt,
  basePrice: BigInt(s.basePriceMicro),
  floorPrice: BigInt(s.floorPriceMicro),
  halfLife: s.halfLife,
  forcedOpen: s.forcedOpen,
});
