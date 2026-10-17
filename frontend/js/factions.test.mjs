import { test } from "node:test";
import assert from "node:assert/strict";
import { factionOf, factionCounts } from "./factions.js";

test("半衰期区间映射", () => {
  const hl = 120;
  assert.equal(factionOf({ elapsed: 0, halfLife: hl }).key, "bolt");
  assert.equal(factionOf({ elapsed: 119, halfLife: hl }).key, "bolt");
  assert.equal(factionOf({ elapsed: 120, halfLife: hl }).key, "rush");
  assert.equal(factionOf({ elapsed: 359, halfLife: hl }).key, "rush");
  assert.equal(factionOf({ elapsed: 360, halfLife: hl }).key, "hoot");
  assert.equal(factionOf({ elapsed: 959, halfLife: hl }).key, "hoot");
});

test("归零/免费领取恒为 Lazlo", () => {
  const hl = 120;
  assert.equal(factionOf({ elapsed: 960, halfLife: hl }).key, "lazlo");
  assert.equal(factionOf({ elapsed: 500, halfLife: hl, channel: "free" }).key, "lazlo");
});

test("factionCounts 批量统计", () => {
  const trades = [
    { elapsed: 10 },   // bolt
    { elapsed: 10 },   // bolt
    { elapsed: 200 },  // rush
    { elapsed: 500 },  // hoot
    { elapsed: 0, channel: "free" }, // lazlo
  ];
  assert.deepEqual(factionCounts(trades, 120), { bolt: 2, rush: 1, hoot: 1, lazlo: 1 });
});

test("每个阵营都有现成台词", () => {
  for (const key of ["bolt", "rush", "hoot", "lazlo"]) {
    const f = factionOf({ elapsed: 0, halfLife: 120, channel: key === "lazlo" ? "free" : undefined });
    assert.ok(f.line.length > 0);
    assert.ok(f.colorVar.startsWith("--c-"));
  }
});
