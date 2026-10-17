import { rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Address } from "viem";
import { AlphaGateway } from "../chain/alpha-gateway.js";
import { ContentStore, hashContent } from "../domain/content-store.js";
import { QuoteStore } from "../domain/quote-store.js";
import type { ChainSignal } from "../domain/types.js";
import { AlphaIndexer } from "../indexer/alpha-indexer.js";
import { createApp } from "../server/create-app.js";

process.env.X402_ENABLED = "false";
process.env.SERVER_SECRET = "contract-test-secret";

const port = Number(process.env.PORT || 4398);
const runtime = join(tmpdir(), `alpha-clock-contract-${process.pid}`);
const now = Math.floor(Date.now() / 1000);
const signal: ChainSignal = {
  id: 1,
  publisher: "0x000000000000000000000000000000000000bEEF",
  publishedAt: now,
  basePrice: 10_000_000n,
  floorPrice: 1_000n,
  halfLife: 300,
  forcedOpen: false,
  contentHash: hashContent("契约测试正文"),
  title: "契约测试信号",
  previewURI: "契约测试摘要",
};

const gateway = {
  net: {
    key: "local-anvil",
    chainId: 31337,
    network: "eip155:31337",
    rpcUrl: "http://127.0.0.1:8545",
    usdc: "0x000000000000000000000000000000000000c0Fe",
    explorer: "",
    facilitatorSupported: false,
  },
  deployments: {
    chainId: 31337,
    usdc: "0x000000000000000000000000000000000000c0Fe",
    isMockUSDC: true,
    alphaClock: "0x000000000000000000000000000000000000a1c0",
    verifier: "0x000000000000000000000000000000000000bEEF",
    treasury: "0x000000000000000000000000000000000000bEEF",
  },
  alpha: "0x000000000000000000000000000000000000a1c0",
  signalCount: async () => 1,
  readSignal: async (id: number) => (id === 1 ? signal : null),
  blockTime: async () => Math.floor(Date.now() / 1000),
  blockNumber: async () => 1,
  currentPrice: async () => 10_000_000n,
  priceAt: async () => 10_000_000n,
  accessOf: async (_id: number, _buyer: Address) => ({ at: 0, price: 0n }),
} as unknown as AlphaGateway;

const contents = new ContentStore(join(runtime, "content.json"));
contents.put({
  id: 1,
  title: signal.title,
  previewText: signal.previewURI,
  body: "契约测试正文",
  contentHash: signal.contentHash,
  attestPublicSource: true,
});
const quotes = new QuoteStore(join(runtime, "quotes.json"));
const indexer = new AlphaIndexer(gateway, join(runtime, "free-claims.ndjson"));
const app = createApp({ gateway, contents, quotes, indexer });
const server = app.listen(port, "127.0.0.1", () => console.log(`fixture backend ready:${port}`));

const shutdown = () => {
  server.close(() => {
    rmSync(runtime, { recursive: true, force: true });
    process.exit(0);
  });
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
