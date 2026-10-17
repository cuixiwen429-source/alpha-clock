/**
 * AlphaClock API —— 一条信息的价格，每秒都在掉。
 *
 * 核心端点：
 *   GET  /api/signals              全部信号（含此刻价格）
 *   GET  /api/signal/:id           详情 + 完整价格曲线（免费）
 *   GET  /api/signal/:id/body      正文（x402 保护，价格 = 链上此刻的价格）
 *   POST /api/claim                用链上购买记录领取正文（人类路径 / 断网回退）
 *   GET  /api/quote/:id            只报价不下单，给 Agent 做决策用
 *
 * 定价的唯一真相源是链上合约。服务器不算价格，只读价格。
 * 这一条是产品的核心承诺：卖家改不了，平台也改不了。
 */
import express from "express";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { createPublicClient, http, type Address } from "viem";
import { paymentMiddleware, x402ResourceServer } from "@x402/express";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import { HTTPFacilitatorClient } from "@x402/core/server";
import { ALPHA_ABI, FACILITATOR_URL, ROOT, fmtUsdc, getDeployments, getNetwork, money, usdc } from "../config.js";

const net = getNetwork();
const dep = getDeployments();
const PORT = Number(process.env.PORT || 4030);

const publicClient = createPublicClient({ transport: http(net.rpcUrl) });
const ALPHA = dep.alphaClock;

const app = express();
app.use(express.json());
app.use((_req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "*");
  res.setHeader("Access-Control-Allow-Methods", "*");
  next();
});

// 投屏页面
app.use("/web", express.static(resolve(ROOT, "../frontend")));

// ──────────────────────────── 内容库 ────────────────────────────
//
// 合约里只存 contentURI（一个指针）。正文在这里。
// 生产环境应该是加密后放 IPFS/Arweave，密钥由服务器在付款后下发 ——
// 黑客松范围内保持最小实现，但接口形态是对齐的。

interface Content {
  id: number;
  title: string;
  preview: string;
  body: string;
  source?: string;
}

const CONTENT_PATH = resolve(ROOT, "content.json");

function loadContent(): Map<number, Content> {
  const m = new Map<number, Content>();
  if (!existsSync(CONTENT_PATH)) return m;
  const arr = JSON.parse(readFileSync(CONTENT_PATH, "utf8")) as Content[];
  for (const c of arr) m.set(c.id, c);
  return m;
}

const contents = loadContent();

function saveContent() {
  writeFileSync(CONTENT_PATH, JSON.stringify([...contents.values()], null, 2), "utf8");
}

// ──────────────────────────── 链上读 ────────────────────────────

async function readSignal(id: number) {
  const v = await publicClient.readContract({
    address: ALPHA,
    abi: ALPHA_ABI,
    functionName: "getSignal",
    args: [BigInt(id)],
  });
  return v;
}

async function readPrice(id: number): Promise<bigint> {
  const p = await publicClient.readContract({
    address: ALPHA,
    abi: ALPHA_ABI,
    functionName: "currentPrice",
    args: [BigInt(id)],
  });
  return BigInt(p);
}

async function readCurve(id: number, n = 48) {
  const [prices, times] = await publicClient.readContract({
    address: ALPHA,
    abi: ALPHA_ABI,
    functionName: "curve",
    args: [BigInt(id), n],
  });
  return {
    prices: (prices as bigint[]).map((p) => Number(p) / 1e6),
    times: (times as bigint[]).map((t) => Number(t)),
  };
}

async function hasAccess(id: number, who: Address): Promise<boolean> {
  return publicClient.readContract({
    address: ALPHA,
    abi: ALPHA_ABI,
    functionName: "hasAccess",
    args: [BigInt(id), who],
  });
}

async function paidPriceOf(id: number, who: Address): Promise<bigint> {
  const p = await publicClient.readContract({
    address: ALPHA,
    abi: ALPHA_ABI,
    functionName: "paidPrice",
    args: [BigInt(id), who],
  });
  return BigInt(p);
}

// ──────────────────────────── 免费端点 ────────────────────────────

app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    network: net.network,
    chainId: net.chainId,
    alphaClock: ALPHA,
    usdc: dep.usdc,
    facilitator: FACILITATOR_URL,
  });
});

app.get("/api/signals", async (_req, res) => {
  try {
    const count = Number(
      await publicClient.readContract({ address: ALPHA, abi: ALPHA_ABI, functionName: "signalCount" }),
    );
    const out = [];
    for (let i = 1; i <= count; i++) {
      const v = await readSignal(i);
      const c = contents.get(i);
      out.push({
        id: i,
        title: v.title,
        publisher: v.publisher,
        price: Number(v.price) / 1e6,
        priceLabel: money(v.price),
        basePrice: Number(v.basePrice) / 1e6,
        halfLife: Number(v.halfLife),
        buyCount: Number(v.buyCount),
        revenue: Number(v.revenue) / 1e6,
        freeNow: v.freeNow,
        preview: c?.preview ?? "",
      });
    }
    res.json({ count, signals: out });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

app.get("/api/signal/:id", async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id < 1) return res.status(400).json({ error: "bad id" });
  try {
    const v = await readSignal(id);
    const [curve, ttf] = await Promise.all([
      readCurve(id, 64),
      publicClient.readContract({
        address: ALPHA,
        abi: ALPHA_ABI,
        functionName: "timeToFree",
        args: [BigInt(id)],
      }),
    ]);
    const c = contents.get(id);
    res.json({
      id,
      title: v.title,
      publisher: v.publisher,
      preview: c?.preview ?? "",
      publishedAt: Number(v.publishedAt),
      basePrice: Number(v.basePrice) / 1e6,
      floorPrice: Number(v.floorPrice) / 1e6,
      halfLife: Number(v.halfLife),
      buyCount: Number(v.buyCount),
      revenue: Number(v.revenue) / 1e6,
      price: Number(v.price) / 1e6,
      priceLabel: money(v.price),
      freeNow: v.freeNow,
      timeToFree: Number(ttf),
      curve,
      now: Math.floor(Date.now() / 1000),
    });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

/** 成交流水（投屏右栏用） */
app.get("/api/signal/:id/buys", async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id < 1) return res.status(400).json({ error: "bad id" });
  try {
    const logs = await publicClient.getContractEvents({
      address: ALPHA,
      abi: ALPHA_ABI,
      eventName: "Bought",
      args: { id: BigInt(id) },
      fromBlock: 0n,
    });
    res.json(
      logs.map((l) => ({
        buyer: l.args.buyer,
        price: Number(l.args.price) / 1e6,
        buyCount: Number(l.args.buyCount),
        elapsed: Number(l.args.elapsed),
        viaX402: l.args.viaX402,
        tx: l.transactionHash,
        block: Number(l.blockNumber),
      })),
    );
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

/** 只报价不下单 —— Agent 用它决定"现在买还是再等等" */app.get("/api/quote/:id", async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id < 1) return res.status(400).json({ error: "bad id" });
  try {
    const [v, ttf] = await Promise.all([
      readSignal(id),
      publicClient.readContract({
        address: ALPHA,
        abi: ALPHA_ABI,
        functionName: "timeToFree",
        args: [BigInt(id)],
      }),
    ]);
    const price = BigInt(v.price);
    res.json({
      id,
      price: Number(price) / 1e6,
      priceUnits: price.toString(),
      priceLabel: money(price),
      freeNow: v.freeNow,
      timeToFree: Number(ttf),
      // 再等 30 秒能省多少（前向差分，Agent 的决策依据）
      priceIn30s: Number(await readAt(id, Math.floor(Date.now() / 1000) + 30)) / 1e6,
      buyCount: Number(v.buyCount),
    });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

async function readAt(id: number, ts: number): Promise<bigint> {
  const p = await publicClient.readContract({
    address: ALPHA,
    abi: ALPHA_ABI,
    functionName: "priceAt",
    args: [BigInt(id), BigInt(ts)],
  });
  return BigInt(p);
}

// ──────────────────────────── x402 保护的正文 ────────────────────────────

/**
 * 从 x402 的 context 里把 signal id 挖出来。
 * SDK 不同版本传进来的可能是 express Request、或包了一层的对象，这里做兼容。
 */
function idFromCtx(ctx: unknown): number {
  const c = ctx as Record<string, any>;
  const sources = [
    c?.params?.id,
    c?.req?.params?.id,
    String(c?.path ?? "").match(/\/api\/signal\/(\d+)\/body/)?.[1],
    String(c?.url ?? "").match(/\/api\/signal\/(\d+)\/body/)?.[1],
    String(c?.originalUrl ?? "").match(/\/api\/signal\/(\d+)\/body/)?.[1],
  ];
  for (const s of sources) {
    if (s && /^\d+$/.test(String(s))) return Number(s);
  }
  return 0;
}

const X402_ENABLED =
  (process.env.X402_ENABLED ?? (net.facilitatorSupported || process.env.USE_LOCAL_FACILITATOR === "1" ? "true" : "false")) ===
  "true";

if (X402_ENABLED) {
  const facilitatorClient = new HTTPFacilitatorClient({ url: FACILITATOR_URL });
  const server = new x402ResourceServer(facilitatorClient);

  const scheme = new ExactEvmScheme();
  // Monad 测试网 USDC 不在 @x402/evm 内置资产表里，必须自己注册 money parser
  scheme.registerMoneyParser(async (amount: string | number, network: string) => {
    if (network === net.network) {
      return {
        amount: Math.floor(Number(amount) * 1_000_000).toString(),
        asset: dep.usdc,
        extra: { name: "USDC", version: "2" },
      };
    }
    return null;
  });
  server.register(net.network, scheme);

  app.use(
    paymentMiddleware(
      {
        // 动态定价：价格不是写死的，而是每次请求现从链上读
        "GET /api/signal/:id/body": {
          accepts: {
            scheme: "exact",
            network: net.network,
            payTo: dep.treasury as Address,
            price: async (ctx: unknown) => {
              const id = idFromCtx(ctx);
              if (!id) return "$0.01";
              const p = await readPrice(id);
              if (p === 0n) return "$0.000001"; // 已免费，给一个名义价（正常不会走到这里）
              // 加一点缓冲，避免请求在链上算价和结算之间价格变动导致校验失败
              return `$${fmtUsdc(p + p / 100n)}`;
            },
          },
          description: "一条正在按秒贬值的信息的正文",
          mimeType: "application/json",
        },
      },
      server,
      undefined,
      undefined,
      true,
    ),
  );

  app.get("/api/signal/:id/body", async (req, res) => {
    const id = Number(req.params.id);
    const c = contents.get(id);
    if (!c) return res.status(404).json({ error: "no content" });

    // 买家地址：x402 结算后由中间件挂在 req 上；拿不到就要求 query 里显式给
    const buyer = (req.query.buyer as string) || (req as any).payment?.payer || (req as any).payer;
    if (buyer && /^0x[0-9a-fA-F]{40}$/.test(buyer)) {
      try {
        const price = await readPrice(id).catch(() => 0n);
        await recordOnChain(id, buyer as Address, price);
      } catch {
        /* 上链记账失败不影响本次交付 */
      }
    }

    return res.json({
      id,
      title: c.title,
      body: c.body,
      source: c.source,
      settlement: "x402",
      deliveredAt: new Date().toISOString(),
    });
  });
}

/** 把 x402 的成交写回链上（只有 verifier 能做） */
async function recordOnChain(id: number, buyer: Address, price: bigint) {
  const pk = process.env.VERIFIER_PRIVATE_KEY;
  if (!pk) return;
  const { createWalletClient } = await import("viem");
  const { privateKeyToAccount } = await import("viem/accounts");
  const account = privateKeyToAccount(pk as `0x${string}`);
  const wallet = createWalletClient({ account, transport: http(net.rpcUrl) });
  const hash = await wallet.writeContract({
    address: ALPHA,
    abi: ALPHA_ABI,
    functionName: "recordX402",
    args: [BigInt(id), buyer, price],
    chain: null,
  });
  console.log(`  ⛓  recordX402 #${id} buyer=${buyer.slice(0, 8)} price=${money(price)} tx=${hash.slice(0, 10)}`);
}

// ──────────────────────────── 人类路径：用链上购买记录领取 ────────────────────────────

/**
 * 客户端已经调过合约 buy(id)，这里只验证链上 hasAccess —— 不信任客户端提供的任何金额。
 */
app.post("/api/claim", async (req, res) => {
  const { id, buyer } = req.body as { id?: number; buyer?: string };
  if (!id || !buyer || !/^0x[0-9a-fA-F]{40}$/.test(buyer)) {
    return res.status(400).json({ error: "需要 { id, buyer }" });
  }
  try {
    const ok = await hasAccess(id, buyer as Address);
    if (!ok) return res.status(402).json({ error: "链上没有你的购买记录" });

    const c = contents.get(id);
    if (!c) return res.status(404).json({ error: "no content" });

    const paid = await paidPriceOf(id, buyer as Address);
    return res.json({
      id,
      title: c.title,
      body: c.body,
      source: c.source,
      paid: money(paid),
      settlement: "onchain",
      deliveredAt: new Date().toISOString(),
    });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// ──────────────────────────── 内部：登记内容 ────────────────────────────

/**
 * 发布时把正文存进服务器。合约里的 contentURI 指向这里的 id。
 * 生产环境这里应该校验"调用者就是该 signal 的 publisher"。
 */
app.post("/api/content", async (req, res) => {
  const { id, title, preview, body, source } = req.body as Partial<Content>;
  if (!id || !title || !body) return res.status(400).json({ error: "需要 { id, title, body }" });
  const c: Content = { id, title, preview: preview ?? "", body, source };
  contents.set(id, c);
  saveContent();
  res.json({ ok: true, id });
});

app.listen(PORT, () => {
  console.log(`\n  AlphaClock API`);
  console.log(`  ─────────────────────────────────────────`);
  console.log(`  URL         http://localhost:${PORT}`);
  console.log(`  网络        ${net.network} (chainId ${net.chainId})`);
  console.log(`  合约        ${ALPHA}`);
  console.log(`  USDC        ${dep.usdc}`);
  console.log(`  x402 正文   ${X402_ENABLED ? "已开启 GET /api/signal/:id/body（链上动态定价）" : "已关闭（仅 /api/claim）"}`);
  console.log(`  facilitator ${FACILITATOR_URL}`);
  console.log(`  内容条数    ${contents.size}`);
  console.log(`  ─────────────────────────────────────────\n`);
});
