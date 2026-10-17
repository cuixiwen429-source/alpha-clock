import "../env.js"; // 必须是第一个 import：在 config.ts 读 process.env 之前载入 .env
import { resolve } from "node:path";
import { AlphaGateway } from "../chain/alpha-gateway.js";
import { ROOT } from "../config.js";
import { ContentStore } from "../domain/content-store.js";
import { QuoteStore } from "../domain/quote-store.js";
import { AlphaIndexer } from "../indexer/alpha-indexer.js";
import { createApp } from "./create-app.js";

const port = Number(process.env.PORT || 4030);
// 默认监听全部网卡，方便同事用 ?api=http://<本机IP>:4030 联调；
// 本地 demo 用 HOST=127.0.0.1 只占 IPv4，端口被占时能当场报错，
// 而不是被同端口的 mock（IPv4）把 127.0.0.1 的请求悄悄接走。
const host = process.env.HOST || "0.0.0.0";
const gateway = new AlphaGateway();
const contents = new ContentStore(resolve(ROOT, "content.json"));
const quotes = new QuoteStore(resolve(ROOT, ".runtime/quotes.json"));
const indexer = new AlphaIndexer(gateway, resolve(ROOT, ".runtime/free-claims.ndjson"));

const app = createApp({ gateway, contents, quotes, indexer });
const server = app.listen(port, host, () => {
  console.log(`AlphaClock API http://127.0.0.1:${port} (bind ${host})`);
  console.log(`network=${gateway.net.network} contract=${gateway.alpha}`);
});

server.on("error", (error: NodeJS.ErrnoException) => {
  if (error.code === "EADDRINUSE") {
    console.error(`端口 ${port} 已被占用。本地 mock 后端默认也用 4030，先 pkill -f "mock/server.mjs" 或换 PORT。`);
  } else {
    console.error("API 启动失败", error);
  }
  process.exit(1);
});

void gateway
  .assertNetwork()
  .then(() => indexer.start())
  .then(() => console.log("event indexer started"))
  .catch((error) => console.error("event indexer unavailable", error));

const shutdown = () => {
  indexer.stop();
  server.close(() => process.exit(0));
};

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
