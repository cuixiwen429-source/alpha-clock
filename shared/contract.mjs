// 前后端接口契约（机器可读版）。人读版见 shared/API.md。
// mock 按它造数据，check-contract 按它验收真实后端。改字段 = 改这里 + 改 API.md，PR 需前后端双方 review。

export const CONTRACT_VERSION = "1.0.0";

// ── 字段类型 ─────────────────────────────────────────────
// usdc     "7.071067"   6 位小数字符串（展示用）
// micro    "7071067"    micro-USDC 整数字符串（计算用，前端转 BigInt）
// address  0x + 40 hex
// hex32    0x + 64 hex
// ts       秒级 unix 时间戳（整数）
const T = {
  string: (v) => typeof v === "string",
  number: (v) => typeof v === "number" && Number.isFinite(v),
  integer: (v) => Number.isInteger(v),
  boolean: (v) => typeof v === "boolean",
  ts: (v) => Number.isInteger(v) && v > 1_000_000_000,
  usdc: (v) => typeof v === "string" && /^\d+\.\d{6}$/.test(v),
  micro: (v) => typeof v === "string" && /^\d+$/.test(v),
  address: (v) => typeof v === "string" && /^0x[0-9a-fA-F]{40}$/.test(v),
  hex32: (v) => typeof v === "string" && /^0x[0-9a-fA-F]{64}$/.test(v),
  status: (v) => ["LIVE", "OPEN", "CLOSED"].includes(v),
};

// "type?" = 可为 null；"[type]" = 数组；对象 = 嵌套结构
export const Signal = {
  id: "integer",
  title: "string",
  previewText: "string",
  publisher: "address",
  publishedAt: "ts",
  basePrice: "usdc",
  basePriceMicro: "micro",
  floorPrice: "usdc",
  floorPriceMicro: "micro",
  halfLife: "integer",
  freeAt: "ts",
  forcedOpen: "boolean",
  price: "usdc",
  priceMicro: "micro",
  timeToFree: "integer",
  halvingsElapsed: "number",
  nextDropIn: "integer",
  nextDropAmount: "usdc",
  buyers: "integer",
  revenue: "usdc",
  spread: "number?", // 最高/最低成交价；不足两笔或最低为 0 时 null
  status: "status",
  network: "string",
  contract: "address",
  serverTime: "ts", // 前端用它校准本地时钟，再本地插值
};

export const Trade = {
  rank: "integer", // 第几个知道的（1 起）
  buyer: "address",
  label: "string", // 大屏展示用短名，如 "1f3a"
  price: "usdc", // 免费领取为 "0.000000"
  elapsed: "integer",
  at: "ts",
  channel: "string", // "onchain" | "x402" | "free"
  txHash: "hex32?",
};

export const Curve = { times: "[integer]", prices: "[usdc]" };

export const Quote = {
  quoteId: "string",
  signalId: "integer",
  amount: "usdc",
  amountMicro: "micro",
  priceAt: "ts",
  expiresAt: "ts",
  network: "string",
  asset: "address",
  payTo: "address",
};

export const Content = {
  signalId: "integer",
  title: "string",
  body: "string",
  contentHash: "hex32",
  channel: "string", // "onchain" | "x402" | "free"
  paid: "usdc",
  rank: "integer",
};

export const Receipt = {
  signalId: "integer",
  address: "address",
  rank: "integer",
  paid: "usdc",
  firstPaid: "usdc",
  multipleVsFirst: "string", // "14.59" 或 "∞"
  elapsed: "integer",
  contentHash: "hex32",
  signature: "string",
};

export const Live = {
  signalId: "integer",
  title: "string",
  price: "usdc",
  priceMicro: "micro",
  timeToFree: "integer",
  freeAt: "ts",
  buyers: "integer",
  claims: "integer",
  revenue: "usdc",
  maxPaid: "usdc?",
  minPaid: "usdc?",
  spread: "number?",
  recent: [Trade], // 最近 50 条，新的在前
  curve: Curve,
  status: "status",
  serverTime: "ts",
  blockNumber: "integer?",
};

export const Config = {
  contractVersion: "string",
  network: "string", // "eip155:10143"
  chainId: "integer",
  rpcUrl: "string",
  explorer: "string",
  contract: "address",
  usdc: "address",
  x402: "boolean",
};

export const PublishResult = { id: "integer", url: "string", txHash: "hex32?" };

export const ErrorBody = { error: { code: "string", message: "string" } };

export const ERROR_CODES = [
  "BAD_PARAMS", "NOT_FOUND", "CLOSED", "FREE_ALREADY", "NOT_FREE_YET",
  "ALREADY_OWN", "NOT_PUBLISHER", "QUOTE_EXPIRED", "PAYMENT_REQUIRED", "UPSTREAM",
];

// SSE 事件 → data 结构
export const StreamEvents = {
  tick: { price: "usdc", priceMicro: "micro", timeToFree: "integer", serverTime: "ts" },
  trade: Trade,
  stampede: { claims: "integer", window: "string" },
  opened: { at: "ts" },
};

/** 返回不符合契约的字段路径列表；空数组 = 通过 */
export function validate(value, schema, path = "$") {
  if (typeof schema === "string") {
    const nullable = schema.endsWith("?");
    const base = nullable ? schema.slice(0, -1) : schema;
    if (value === null || value === undefined) return nullable ? [] : [`${path}: 缺失`];
    if (base.startsWith("[")) {
      if (!Array.isArray(value)) return [`${path}: 应为数组`];
      return value.flatMap((v, i) => validate(v, base.slice(1, -1), `${path}[${i}]`));
    }
    return T[base](value) ? [] : [`${path}: 应为 ${base}，实际 ${JSON.stringify(value)}`];
  }
  if (Array.isArray(schema)) {
    if (!Array.isArray(value)) return [`${path}: 应为数组`];
    return value.flatMap((v, i) => validate(v, schema[0], `${path}[${i}]`));
  }
  if (value === null || typeof value !== "object") return [`${path}: 应为对象`];
  return Object.entries(schema).flatMap(([k, s]) => validate(value[k], s, `${path}.${k}`));
}
