import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { QuoteStore } from "./quote-store.js";

const ASSET = "0x534b2f3A21130d7a60830c2Df862319e593943A3";
const PAY_TO = "0x000000000000000000000000000000000000bEEF";

test("报价锁定 10 秒，并在 10 分钟保留期内仍可结算", () => {
  const dir = mkdtempSync(join(tmpdir(), "alpha-clock-quotes-"));
  try {
    const path = join(dir, "quotes.json");
    const store = new QuoteStore(path);
    const quote = store.create({
      signalId: 7,
      amountMicro: 7_071_067n,
      now: 1_800_000_000,
      network: "eip155:10143",
      asset: ASSET,
      payTo: PAY_TO,
    });
    assert.equal(quote.expiresAt, 1_800_000_010);
    assert.equal(store.active(7, 1_800_000_010)?.quoteId, quote.quoteId);
    assert.equal(store.active(7, 1_800_000_011), undefined);
    assert.equal(store.get(quote.quoteId, 7, 1_800_000_011)?.amountMicro, "7071067");
    assert.equal(store.get(quote.quoteId, 8, 1_800_000_011), undefined);
    assert.equal(store.get(quote.quoteId, 7, 1_800_000_601), undefined);
    assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("报价落盘后可由新进程恢复", () => {
  const dir = mkdtempSync(join(tmpdir(), "alpha-clock-quotes-"));
  try {
    const path = join(dir, "quotes.json");
    const first = new QuoteStore(path);
    const quote = first.create({
      signalId: 1,
      amountMicro: 625_000n,
      now: Math.floor(Date.now() / 1000),
      network: "eip155:10143",
      asset: ASSET,
      payTo: PAY_TO,
    });
    const restored = new QuoteStore(path);
    assert.equal(restored.get(quote.quoteId, 1)?.amountMicro, "625000");
    assert.equal(restored.toResponse(quote).amount, "0.625000");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
