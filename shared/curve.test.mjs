import { test } from "node:test";
import assert from "node:assert/strict";
import { priceAt, freeAt, nextDrop, fmtUsdc, parseUsdc, sampleCurve } from "./curve.mjs";

// PRD §5.4「常规」预设
const sig = { publishedAt: 1_000_000, basePrice: 10_000_000n, floorPrice: 1_000n, halfLife: 120 };
const at = (dt) => priceAt(sig, sig.publishedAt + dt);

test("PRD §5.4 对照表", () => {
  assert.equal(at(0), 10_000_000n);
  assert.equal(at(60), 7_071_067n); // 合约整数截断，PRD 表里四舍五入成 7.0711
  assert.equal(at(120), 5_000_000n);
  assert.equal(at(240), 2_500_000n);
  assert.equal(at(600), 312_500n);
  assert.equal(at(960), 0n);
  assert.equal(freeAt(sig), sig.publishedAt + 960);
});

test("单调不增 + 地板 + 归零（I1–I3）", () => {
  let prev = at(0);
  for (let dt = 1; dt < 1200; dt++) {
    const p = at(dt);
    assert.ok(p <= prev, `dt=${dt}`);
    if (dt < 960) assert.ok(p >= sig.floorPrice);
    else assert.equal(p, 0n);
    prev = p;
  }
});

test("forcedOpen 恒为 0", () => {
  assert.equal(priceAt({ ...sig, forcedOpen: true }, sig.publishedAt), 0n);
});

test("nextDrop 指向下一档", () => {
  const d = nextDrop(sig, sig.publishedAt);
  assert.equal(d.inSec, 4); // 120/32 = 3.75 → 第 4 秒落到下一档
  assert.equal(d.amount, at(0) - at(4));
});

test("金额格式化往返", () => {
  assert.equal(fmtUsdc(7_071_067n), "7.071067");
  assert.equal(parseUsdc("7.071067"), 7_071_067n);
  assert.equal(parseUsdc("0.5"), 500_000n);
});

test("sampleCurve 首尾", () => {
  const c = sampleCurve(sig, 8);
  assert.equal(c.prices[0], 10_000_000n);
  assert.equal(c.prices.at(-1), 0n);
});
