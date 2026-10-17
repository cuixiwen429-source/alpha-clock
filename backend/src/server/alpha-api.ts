import { resolve } from "node:path";
import { AlphaGateway } from "../chain/alpha-gateway.js";
import { ROOT } from "../config.js";
import { ContentStore } from "../domain/content-store.js";
import { QuoteStore } from "../domain/quote-store.js";
import { AlphaIndexer } from "../indexer/alpha-indexer.js";
import { createApp } from "./create-app.js";

const port = Number(process.env.PORT || 4030);
const gateway = new AlphaGateway();
const contents = new ContentStore(resolve(ROOT, "content.json"));
const quotes = new QuoteStore(resolve(ROOT, ".runtime/quotes.json"));
const indexer = new AlphaIndexer(gateway, resolve(ROOT, ".runtime/free-claims.ndjson"));

const app = createApp({ gateway, contents, quotes, indexer });
const server = app.listen(port, () => {
  console.log(`AlphaClock API http://127.0.0.1:${port}`);
  console.log(`network=${gateway.net.network} contract=${gateway.alpha}`);
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
