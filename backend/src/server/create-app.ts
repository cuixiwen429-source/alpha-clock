import { createHmac } from "node:crypto";
import { appendFileSync } from "node:fs";
import { resolve } from "node:path";
import express, { type NextFunction, type Request, type RequestHandler, type Response } from "express";
import { z } from "zod";
import { isAddress, type Address, type Hex } from "viem";
import { paymentMiddleware, x402ResourceServer } from "@x402/express";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import { HTTPFacilitatorClient, type HTTPRequestContext } from "@x402/core/server";
import { CONTRACT_VERSION } from "../../../shared/contract.mjs";
import { fmtUsdc, freeAt, nextDrop, parseUsdc, priceAt, sampleCurve } from "../../../shared/curve.mjs";
import { FACILITATOR_URL, ROOT } from "../config.js";
import { AlphaGateway } from "../chain/alpha-gateway.js";
import { ContentStore, hashContent, type StoredContent } from "../domain/content-store.js";
import { QuoteStore, type QuoteRecord } from "../domain/quote-store.js";
import type { ChainSignal, Trade } from "../domain/types.js";
import { AlphaIndexer } from "../indexer/alpha-indexer.js";

const ZERO_HASH = `0x${"0".repeat(64)}`;
let priceCheckSequence = 0;

class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

const route = (handler: (req: Request, res: Response, next: NextFunction) => Promise<unknown>): RequestHandler =>
  (req, res, next) => void handler(req, res, next).catch(next);

const parseId = (raw: string): number => {
  const id = Number(raw);
  if (!Number.isSafeInteger(id) || id < 1) throw new ApiError(400, "BAD_PARAMS", "signal id 不合法");
  return id;
};

const parseAddress = (raw: unknown, label = "address"): Address => {
  if (typeof raw !== "string" || !isAddress(raw)) throw new ApiError(400, "BAD_PARAMS", `${label} 不合法`);
  return raw as Address;
};

const tradeView = (trade: Trade) => ({
  rank: trade.rank,
  buyer: trade.buyer,
  label: trade.label,
  price: fmtUsdc(trade.priceMicro),
  elapsed: trade.elapsed,
  at: trade.at,
  channel: trade.channel,
  txHash: trade.txHash,
});

const publishSchema = z.object({
  title: z.string().trim().min(1).max(60),
  // 摘要允许留空：契约 Signal.previewText 是普通 string，mock 也允许空，
  // publish.html 的输入框没有 required。后端卡 min(1) 会让"不填摘要就发布"
  // 在真后端 400、在 mock 成功 —— 联调时最难查的那类差异。
  previewText: z.string().trim().max(140).default(""),
  body: z.string().min(1),
  basePriceMicro: z.string().regex(/^\d+$/),
  floorPriceMicro: z.string().regex(/^\d+$/),
  halfLife: z.number().int().positive().max(365 * 24 * 60 * 60),
  attestPublicSource: z.literal(true),
  txHash: z.string().regex(/^0x[0-9a-fA-F]{64}$/).optional(),
  source: z.string().max(500).optional(),
});

const FIELD_LABELS: Record<string, string> = {
  title: "标题",
  previewText: "摘要",
  body: "正文",
  basePriceMicro: "初始价格",
  floorPriceMicro: "最低价",
  halfLife: "半衰期",
  attestPublicSource: "来源声明",
  txHash: "交易哈希",
};

/**
 * zod 的默认 message 是英文，而 publish.html 把 message 原样显示给用户
 * （`document.getElementById("err").textContent = err.message`），
 * 于是现场看到的是 "Required" / "Invalid literal value, expected true"。
 * 这里统一翻成人话，前端不用再维护一份字段名映射。
 */
function publishErrorMessage(error: z.ZodError): string {
  const issue = error.issues[0];
  if (!issue) return "发布参数不合法";
  const key = String(issue.path[0] ?? "");
  const label = FIELD_LABELS[key] ?? key ?? "参数";
  switch (issue.code) {
    case "invalid_type":
      return issue.received === "undefined" ? `缺少${label}` : `${label}格式不正确`;
    case "too_big":
      return `${label}最多 ${issue.maximum} 个字符`;
    case "too_small":
      if (issue.minimum === 1) return `${label}不能为空`;
      return issue.inclusive === false ? `${label}必须大于 ${issue.minimum}` : `${label}不能小于 ${issue.minimum}`;
    case "invalid_literal":
      return "必须勾选「本内容源自公开信息」";
    case "invalid_string":
      return `${label}格式不正确`;
    default:
      return `${label}不合法`;
  }
}

interface AppContext {
  gateway: AlphaGateway;
  contents: ContentStore;
  quotes: QuoteStore;
  indexer: AlphaIndexer;
}

function withStoredHash(signal: ChainSignal, content?: StoredContent): ChainSignal {
  if (!content) return signal;
  if (signal.contentHash.toLowerCase() !== ZERO_HASH && signal.contentHash.toLowerCase() !== content.contentHash.toLowerCase()) {
    throw new ApiError(502, "UPSTREAM", `signal #${signal.id} 的链上 contentHash 与服务端正文不一致`);
  }
  return signal.contentHash.toLowerCase() === ZERO_HASH ? { ...signal, contentHash: content.contentHash } : signal;
}

async function requireSignal(ctx: AppContext, id: number): Promise<ChainSignal> {
  const signal = await ctx.gateway.readSignal(id);
  if (!signal) throw new ApiError(404, "NOT_FOUND", "信号不存在");
  return withStoredHash(signal, ctx.contents.get(id));
}

async function chainTime(ctx: AppContext): Promise<number> {
  return ctx.gateway.blockTime();
}

function samplePriceConsistency(ctx: AppContext, signal: ChainSignal, at: number, localPrice: bigint) {
  const configured = Number(process.env.PRICE_CHECK_EVERY || 20);
  const every = Number.isSafeInteger(configured) && configured > 0 ? configured : 20;
  priceCheckSequence += 1;
  if (priceCheckSequence % every !== 0) return;
  void ctx.gateway.priceAt(signal.id, at).then((onchainPrice) => {
    if (onchainPrice !== localPrice) {
      console.error(
        `[price-check] signal #${signal.id} at ${at}: shared/curve=${localPrice}, contract=${onchainPrice}`,
      );
    }
  }).catch((error) => console.error(`[price-check] signal #${signal.id} 抽样失败`, error));
}

function statusOf(signal: ChainSignal, now: number, openedAt: number | null) {
  if (priceAt(signal, now) > 0n) return "LIVE" as const;
  const opened = openedAt ?? freeAt(signal);
  return now - opened > 1_800 ? ("CLOSED" as const) : ("OPEN" as const);
}

async function signalView(ctx: AppContext, signal: ChainSignal, now?: number) {
  const serverTime = now ?? (await chainTime(ctx));
  const content = ctx.contents.get(signal.id);
  const stats = ctx.indexer.stats(signal.id);
  const price = priceAt(signal, serverTime);
  samplePriceConsistency(ctx, signal, serverTime, price);
  const drop = nextDrop(signal, serverTime);
  const naturalFreeAt = freeAt(signal);
  return {
    id: signal.id,
    title: signal.title,
    previewText: content?.previewText ?? signal.previewURI,
    publisher: signal.publisher,
    publishedAt: signal.publishedAt,
    basePrice: fmtUsdc(signal.basePrice),
    basePriceMicro: signal.basePrice.toString(),
    floorPrice: fmtUsdc(signal.floorPrice),
    floorPriceMicro: signal.floorPrice.toString(),
    halfLife: signal.halfLife,
    freeAt: signal.forcedOpen ? (stats.openedAt ?? serverTime) : naturalFreeAt,
    forcedOpen: signal.forcedOpen,
    price: fmtUsdc(price),
    priceMicro: price.toString(),
    timeToFree: price === 0n ? 0 : Math.max(0, naturalFreeAt - serverTime),
    halvingsElapsed: Math.round((Math.max(0, serverTime - signal.publishedAt) / signal.halfLife) * 100) / 100,
    nextDropIn: price === 0n ? 0 : Math.max(0, drop.inSec),
    nextDropAmount: fmtUsdc(price === 0n ? 0n : drop.amount),
    buyers: stats.buyers,
    revenue: fmtUsdc(stats.revenue),
    spread: stats.spread,
    status: statusOf(signal, serverTime, stats.openedAt),
    network: ctx.gateway.net.network,
    contract: ctx.gateway.alpha,
    serverTime,
  };
}

function quoteFor(ctx: AppContext, signal: ChainSignal, now: number): QuoteRecord {
  const amount = priceAt(signal, now);
  if (amount === 0n) throw new ApiError(409, "FREE_ALREADY", "信号已经免费，请走 claim");
  return ctx.quotes.active(signal.id, now) ?? ctx.quotes.create({
    signalId: signal.id,
    amountMicro: amount,
    now,
    network: ctx.gateway.net.network,
    asset: ctx.gateway.deployments.usdc,
    payTo: signal.publisher,
  });
}

function contentView(content: StoredContent, trade: Trade | undefined, channel: Trade["channel"], paid: bigint, rank: number) {
  return {
    signalId: content.id,
    title: content.title,
    body: content.body,
    contentHash: content.contentHash,
    channel,
    paid: fmtUsdc(paid),
    rank: trade?.rank ?? rank,
  };
}

function paymentRequiredHeader(req: Request, ctx: AppContext, quote: QuoteRecord): string {
  const payload = {
    x402Version: 2,
    error: "Payment required",
    resource: {
      url: `${req.protocol}://${req.get("host")}${req.originalUrl}`,
      description: "AlphaClock signal content",
      mimeType: "application/json",
    },
    accepts: [
      {
        scheme: "exact",
        network: ctx.gateway.net.network,
        amount: quote.amountMicro,
        asset: quote.asset,
        payTo: quote.payTo,
        maxTimeoutSeconds: 60,
        extra: { name: "USDC", version: "2" },
      },
    ],
  };
  return Buffer.from(JSON.stringify(payload)).toString("base64");
}

function idFromPaymentContext(context: HTTPRequestContext): number {
  const match = context.adapter.getPath().match(/^\/api\/signals\/(\d+)\/content$/);
  return match ? Number(match[1]) : 0;
}

async function resolvePaymentQuote(context: HTTPRequestContext, ctx: AppContext): Promise<QuoteRecord> {
  const id = idFromPaymentContext(context);
  if (!id) throw new ApiError(400, "BAD_PARAMS", "signal id 不合法");
  const quoteId = context.adapter.getQueryParam?.("quoteId");
  const value = Array.isArray(quoteId) ? quoteId[0] : quoteId;
  const quote = value ? ctx.quotes.get(value, id) : undefined;
  if (quote) return quote;
  const signal = await requireSignal(ctx, id);
  return quoteFor(ctx, signal, await chainTime(ctx));
}

function payerFromPaymentHeader(req: Request): Address | null {
  const encoded = req.header("PAYMENT-SIGNATURE") ?? req.header("X-PAYMENT");
  if (!encoded) return null;
  try {
    const parsed = JSON.parse(Buffer.from(encoded, "base64").toString("utf8")) as any;
    const candidate =
      parsed?.payload?.authorization?.from ??
      parsed?.payload?.permit2Authorization?.from ??
      parsed?.payload?.from;
    return typeof candidate === "string" && isAddress(candidate) ? (candidate as Address) : null;
  } catch {
    return null;
  }
}

function createX402(ctx: AppContext): { enabled: boolean; middleware?: RequestHandler } {
  const enabled =
    (process.env.X402_ENABLED ??
      (ctx.gateway.net.facilitatorSupported || process.env.USE_LOCAL_FACILITATOR === "1" ? "true" : "false")) === "true";
  if (!enabled) return { enabled };

  const facilitator = new HTTPFacilitatorClient({ url: FACILITATOR_URL });
  const resourceServer = new x402ResourceServer(facilitator);
  const scheme = new ExactEvmScheme();
  scheme.registerMoneyParser(async (amount: string | number, network: string) => {
    if (network !== ctx.gateway.net.network) return null;
    const normalized = String(amount).replace(/^\$/, "");
    return {
      amount: parseUsdc(normalized).toString(),
      asset: ctx.gateway.deployments.usdc,
      extra: { name: "USDC", version: "2" },
    };
  });
  resourceServer.register(ctx.gateway.net.network, scheme);
  resourceServer.onAfterSettle(async (settled) => {
    if (!settled.result.success || !settled.result.payer) return;
    const requestContext = (settled.transportContext as any)?.request as HTTPRequestContext | undefined;
    if (!requestContext) return;
    const id = idFromPaymentContext(requestContext);
    const quoteId = requestContext.adapter.getQueryParam?.("quoteId");
    const value = Array.isArray(quoteId) ? quoteId[0] : quoteId;
    const quote = value ? ctx.quotes.get(value, id) : undefined;
    if (!id || !quote || !isAddress(settled.result.payer)) return;
    try {
      await ctx.gateway.recordX402(id, settled.result.payer as Address, BigInt(quote.amountMicro));
    } catch (error) {
      console.error("[x402] settlement succeeded but recordX402 failed", error);
    }
  });

  const middleware = paymentMiddleware(
    {
      "GET /api/signals/:id/content": {
        accepts: {
          scheme: "exact",
          network: ctx.gateway.net.network,
          payTo: async (context) => (await resolvePaymentQuote(context, ctx)).payTo,
          price: async (context) => `$${fmtUsdc((await resolvePaymentQuote(context, ctx)).amountMicro)}`,
          maxTimeoutSeconds: 60,
        },
        description: "一条按时间衰减定价的信息正文",
        mimeType: "application/json",
        unpaidResponseBody: async () => ({
          contentType: "application/json",
          body: { error: { code: "PAYMENT_REQUIRED", message: "需要完成 x402 支付" } },
        }),
        settlementFailedResponseBody: async () => ({
          contentType: "application/json",
          body: { error: { code: "UPSTREAM", message: "x402 结算失败" } },
        }),
      },
    },
    resourceServer,
  );
  return { enabled, middleware };
}

export function createApp(ctx: AppContext) {
  const app = express();
  app.disable("x-powered-by");
  app.use((_req, res, next) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, PAYMENT-SIGNATURE, X-PAYMENT");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Expose-Headers", "PAYMENT-REQUIRED, PAYMENT-RESPONSE, X-Quote-Id");
    next();
  });
  app.options("*", (_req, res) => res.sendStatus(204));
  app.use(express.json({ limit: "256kb" }));

  const x402 = createX402(ctx);

  app.get("/health", route(async (_req, res) => {
    const blockNumber = await ctx.gateway.blockNumber();
    res.json({ ok: true, network: ctx.gateway.net.network, chainId: ctx.gateway.net.chainId, contract: ctx.gateway.alpha, blockNumber });
  }));

  app.get("/api/config", (_req, res) => {
    res.json({
      contractVersion: CONTRACT_VERSION,
      network: ctx.gateway.net.network,
      chainId: ctx.gateway.net.chainId,
      rpcUrl: ctx.gateway.net.rpcUrl,
      explorer: ctx.gateway.net.explorer,
      contract: ctx.gateway.alpha,
      usdc: ctx.gateway.deployments.usdc,
      x402: x402.enabled,
      // 显式给 false 而不是省略：前端靠 cfg.mock 决定"走钱包"还是"走 /__mock/buy"，
      // 省略时读到的是 undefined，虽然结果一样，但排查"我现在连的是哪个后端"时
      // 需要这个字段能直接看出来。
      mock: false,
    });
  });

  app.get("/manifest", (_req, res) => {
    res.json({
      name: "AlphaClock API",
      version: CONTRACT_VERSION,
      network: ctx.gateway.net.network,
      endpoints: ["/api/signals", "/api/signals/:id/quote", "/api/signals/:id/content", "/api/live/:id"],
    });
  });

  app.get("/api/signals", route(async (_req, res) => {
    const [count, now] = await Promise.all([ctx.gateway.signalCount(), chainTime(ctx)]);
    const values = await Promise.all(Array.from({ length: count }, (_, i) => ctx.gateway.readSignal(i + 1)));
    const signals = await Promise.all(
      values.filter((value): value is ChainSignal => Boolean(value)).map((value) => signalView(ctx, withStoredHash(value, ctx.contents.get(value.id)), now)),
    );
    signals.sort((a, b) => b.publishedAt - a.publishedAt);
    res.json({ signals });
  }));

  app.post("/api/signals", route(async (req, res) => {
    const parsed = publishSchema.safeParse(req.body);
    if (!parsed.success) throw new ApiError(400, "BAD_PARAMS", publishErrorMessage(parsed.error));
    const input = parsed.data;
    const basePrice = BigInt(input.basePriceMicro);
    const floorPrice = BigInt(input.floorPriceMicro);
    const uint128Max = (1n << 128n) - 1n;
    if (basePrice === 0n || floorPrice > basePrice || basePrice > uint128Max) {
      throw new ApiError(400, "BAD_PARAMS", "价格参数不合法");
    }
    const contentHash = hashContent(input.body);
    const published = input.txHash
      ? { id: await ctx.gateway.publishedId(input.txHash as Hex, contentHash), txHash: input.txHash as Hex }
      : await ctx.gateway.publish({
          title: input.title,
          previewText: input.previewText,
          contentHash,
          basePrice,
          floorPrice,
          halfLife: input.halfLife,
        });
    ctx.contents.put({
      id: published.id,
      title: input.title,
      previewText: input.previewText,
      body: input.body,
      contentHash,
      source: input.source,
      attestPublicSource: input.attestPublicSource,
    });
    appendFileSync(
      resolve(ROOT, "events.ndjson"),
      `${JSON.stringify({ event: "published_content", signalId: published.id, contentHash, attestPublicSource: true, at: Date.now() })}\n`,
    );
    const base = (process.env.PUBLIC_APP_URL || `${req.protocol}://${req.get("host")}`).replace(/\/$/, "");
    res.status(201).json({ id: published.id, url: `${base}/s/${published.id}`, txHash: published.txHash });
  }));

  app.get("/api/signals/:id", route(async (req, res) => {
    const id = parseId(req.params.id);
    res.json(await signalView(ctx, await requireSignal(ctx, id)));
  }));

  app.get("/api/signals/:id/curve", route(async (req, res) => {
    const id = parseId(req.params.id);
    const signal = await requireSignal(ctx, id);
    const raw = Number(req.query.samples ?? 120);
    if (!Number.isInteger(raw) || raw < 2 || raw > 500) throw new ApiError(400, "BAD_PARAMS", "samples 必须在 2–500 之间");
    const curve = sampleCurve(signal, raw);
    res.json({ times: curve.times, prices: curve.prices.map(fmtUsdc) });
  }));

  app.get("/api/signals/:id/trades", route(async (req, res) => {
    const id = parseId(req.params.id);
    await requireSignal(ctx, id);
    res.json({ trades: ctx.indexer.stats(id).trades.map(tradeView) });
  }));

  app.get("/api/signals/:id/quote", route(async (req, res) => {
    const id = parseId(req.params.id);
    const signal = await requireSignal(ctx, id);
    res.json(ctx.quotes.toResponse(quoteFor(ctx, signal, await chainTime(ctx))));
  }));

  const contentPath = "/api/signals/:id/content";
  app.get(contentPath, route(async (req, res, next) => {
    const id = parseId(req.params.id);
    const signal = await requireSignal(ctx, id);
    const content = ctx.contents.get(id);
    if (!content) throw new ApiError(404, "NOT_FOUND", "正文不存在");
    const buyer = req.query.buyer == null ? null : parseAddress(req.query.buyer, "buyer");
    if (buyer) {
      const indexed = ctx.indexer.findTrade(id, buyer);
      if (indexed) return res.json(contentView(content, indexed, indexed.channel, indexed.priceMicro, indexed.rank));
      const access = await ctx.gateway.accessOf(id, buyer);
      if (access.at > 0) {
        const rank = ctx.indexer.stats(id).trades.length + 1;
        return res.json(contentView(content, undefined, access.price === 0n ? "free" : "onchain", access.price, rank));
      }
    }
    const now = await chainTime(ctx);
    if (priceAt(signal, now) === 0n) throw new ApiError(409, "FREE_ALREADY", "信号已经免费，请走 claim");
    const requestedId = typeof req.query.quoteId === "string" ? req.query.quoteId : "";
    let quote = requestedId ? ctx.quotes.get(requestedId, id, now) : undefined;
    if (!quote) {
      quote = quoteFor(ctx, signal, now);
      res.setHeader("X-Quote-Id", quote.quoteId);
      const url = new URL(req.url, "http://alpha-clock.local");
      url.searchParams.set("quoteId", quote.quoteId);
      req.url = `${url.pathname}${url.search}`;
    }
    res.locals.alphaContent = { content, signal, quote };
    if (!x402.enabled || !x402.middleware) {
      res.setHeader("PAYMENT-REQUIRED", paymentRequiredHeader(req, ctx, quote));
      throw new ApiError(402, "PAYMENT_REQUIRED", "需要完成 x402 支付或先在链上购买");
    }
    return next();
  }));

  if (x402.middleware) app.use(x402.middleware);

  app.get(contentPath, route(async (req, res) => {
    const id = parseId(req.params.id);
    const local = res.locals.alphaContent as { content: StoredContent; signal: ChainSignal; quote: QuoteRecord } | undefined;
    const content = local?.content ?? ctx.contents.get(id);
    if (!content) throw new ApiError(404, "NOT_FOUND", "正文不存在");
    const quoteId = typeof req.query.quoteId === "string" ? req.query.quoteId : "";
    const quote = local?.quote ?? ctx.quotes.get(quoteId, id);
    if (!quote) throw new ApiError(409, "QUOTE_EXPIRED", "报价不存在或已超过保留期");
    const buyer = req.query.buyer == null ? payerFromPaymentHeader(req) : parseAddress(req.query.buyer, "buyer");
    const existing = buyer ? ctx.indexer.findTrade(id, buyer) : undefined;
    const rank = existing?.rank ?? ctx.indexer.stats(id).trades.length + 1;
    res.json(contentView(content, existing, "x402", BigInt(quote.amountMicro), rank));
  }));

  app.post("/api/signals/:id/claim", route(async (req, res) => {
    const id = parseId(req.params.id);
    const address = parseAddress(req.body?.address);
    const signal = await requireSignal(ctx, id);
    const content = ctx.contents.get(id);
    if (!content) throw new ApiError(404, "NOT_FOUND", "正文不存在");
    const now = await chainTime(ctx);
    if (priceAt(signal, now) > 0n) throw new ApiError(409, "NOT_FREE_YET", "还没到免费时间");
    let trade = ctx.indexer.findTrade(id, address);
    if (!trade) {
      const access = await ctx.gateway.accessOf(id, address);
      trade = access.at > 0 && access.price > 0n
        ? {
            rank: ctx.indexer.stats(id).trades.length + 1,
            buyer: address,
            label: address.slice(2, 6),
            priceMicro: access.price,
            elapsed: Math.max(0, now - signal.publishedAt),
            at: now,
            channel: "onchain",
            txHash: null,
            blockNumber: null,
          }
        : ctx.indexer.recordFreeClaim(id, address, signal.publishedAt, now);
    }
    res.json(contentView(content, trade, trade.channel, trade.priceMicro, trade.rank));
  }));

  app.get("/api/signals/:id/receipt", route(async (req, res) => {
    const id = parseId(req.params.id);
    const address = parseAddress(req.query.address);
    const signal = await requireSignal(ctx, id);
    const content = ctx.contents.get(id);
    if (!content) throw new ApiError(404, "NOT_FOUND", "正文不存在");
    let trade = ctx.indexer.findTrade(id, address);
    if (!trade) {
      // 索引器 1s 轮询，而链上访问权一确认就能读。前端买完是
      // 「buy() → 立刻要收据」，两者之间有 1–2 秒的空窗（实测 1.61s）：
      // /content 有 accessOf 兜底所以先 200，/receipt 没有，于是收据 404，
      // s.html 的 showReceipt() 整个抛错 —— 用户看到"钱付了，收据打不开"。
      // 这里补上和 /content 完全一致的兜底。
      const access = await ctx.gateway.accessOf(id, address);
      if (access.at === 0) throw new ApiError(404, "NOT_FOUND", "没有该地址的访问记录");
      trade = {
        rank: ctx.indexer.stats(id).trades.length + 1,
        buyer: address,
        label: address.slice(2, 6),
        priceMicro: access.price,
        elapsed: Math.max(0, access.at - signal.publishedAt),
        at: access.at,
        channel: access.price === 0n ? "free" : "onchain",
        txHash: null,
        blockNumber: null,
      };
    }
    const first = ctx.indexer.stats(id).trades[0]?.priceMicro ?? trade.priceMicro;
    const multiple = trade.priceMicro === 0n ? "∞" : (Number((first * 100n) / trade.priceMicro) / 100).toFixed(2);
    const payload = `${signal.id}|${address.toLowerCase()}|${fmtUsdc(trade.priceMicro)}|${trade.rank}`;
    const secret = process.env.SERVER_SECRET || "development-only-secret";
    res.json({
      signalId: id,
      address,
      rank: trade.rank,
      paid: fmtUsdc(trade.priceMicro),
      firstPaid: fmtUsdc(first),
      multipleVsFirst: multiple,
      elapsed: trade.elapsed,
      contentHash: content.contentHash,
      signature: `0x${createHmac("sha256", secret).update(payload).digest("hex")}`,
    });
  }));

  app.get("/api/live/:id", route(async (req, res) => {
    const id = parseId(req.params.id);
    const signal = await requireSignal(ctx, id);
    const now = await chainTime(ctx);
    const view = await signalView(ctx, signal, now);
    const stats = ctx.indexer.stats(id);
    const curve = sampleCurve(signal, 120);
    res.json({
      signalId: id,
      title: signal.title,
      price: view.price,
      priceMicro: view.priceMicro,
      timeToFree: view.timeToFree,
      freeAt: view.freeAt,
      buyers: stats.buyers,
      claims: stats.claims,
      revenue: fmtUsdc(stats.revenue),
      maxPaid: stats.maxPaid === null ? null : fmtUsdc(stats.maxPaid),
      minPaid: stats.minPaid === null ? null : fmtUsdc(stats.minPaid),
      spread: stats.spread,
      recent: stats.recent.map(tradeView),
      curve: { times: curve.times, prices: curve.prices.map(fmtUsdc) },
      status: view.status,
      serverTime: now,
      blockNumber: stats.blockNumber,
    });
  }));

  app.get("/api/live/:id/stream", route(async (req, res) => {
    const id = parseId(req.params.id);
    // 注意：signal 是「连接建立那一刻」的快照，forcedOpen 之后就不会再变。
    // 所以下面所有价格计算都必须用会刷新的 current，否则发布者点「提前公开」
    // 之后这个连接会一直报旧价格，大屏上永远不会出现归零。
    let current = await requireSignal(ctx, id);
    let openedAt: number | null = null;
    res.status(200);
    res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders();
    let closed = false;
    const send = (event: string, data: unknown) => {
      // 客户端断开后仍可能有 tick 在 await 途中，写已 end 的响应会抛
      // ERR_STREAM_WRITE_AFTER_END，把整个进程一起带走。
      if (closed || res.writableEnded) return;
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };
    let openedSent = false;
    let ticks = 0;
    const tick = async () => {
      // 每 10 次（约 8s）回链上重读一次。索引器挂掉或事件还没索引到时，
      // 这条兜底路径能保证大屏最终看到 openNow 的结果。
      if (++ticks % 10 === 0) {
        try {
          const fresh = await ctx.gateway.readSignal(id);
          if (fresh) current = fresh;
        } catch {
          /* 单次失败沿用旧值，下个周期再试 */
        }
      }
      const now = await chainTime(ctx);
      const price = priceAt(current, now);
      send("tick", {
        price: fmtUsdc(price),
        priceMicro: price.toString(),
        timeToFree: price === 0n ? 0 : Math.max(0, freeAt(current) - now),
        serverTime: now,
      });
      if (price === 0n && !openedSent) {
        openedSent = true;
        send("opened", { at: openedAt ?? (current.forcedOpen ? now : freeAt(current)) });
      }
    };
    await tick();
    const timer = setInterval(() => void tick().catch(() => undefined), 800);
    const unsubscribe = ctx.indexer.subscribe((event) => {
      if (event.signalId !== id) return;
      if (event.event === "opened") {
        openedAt = event.data.at;
        void ctx.gateway
          .readSignal(id)
          .then((fresh) => {
            if (fresh) current = fresh;
            return tick();
          })
          .catch(() => undefined);
        // tick 可能已经先看到价格归零并推过一次 opened，这里不能重复推，
        // 否则大屏会把"开放"动画播两遍。
        if (openedSent) return;
        openedSent = true;
      }
      send(event.event, event.event === "trade" ? tradeView(event.data) : event.data);
    });
    req.on("close", () => {
      closed = true;
      clearInterval(timer);
      unsubscribe();
      res.end();
    });
  }));

  app.use((_req, _res, next) => next(new ApiError(404, "NOT_FOUND", "接口不存在")));
  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (error instanceof ApiError) {
      return res.status(error.status).json({ error: { code: error.code, message: error.message } });
    }
    if (error instanceof SyntaxError && (error as SyntaxError & { status?: number }).status === 400) {
      return res.status(400).json({ error: { code: "BAD_PARAMS", message: "JSON 请求体不合法" } });
    }
    console.error(error);
    return res.status(502).json({ error: { code: "UPSTREAM", message: "RPC 或上游服务异常" } });
  });
  return app;
}
