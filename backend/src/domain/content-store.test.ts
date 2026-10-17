import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ContentStore, hashContent } from "./content-store.js";

test("兼容旧 content.json 并自动生成 keccak256", () => {
  const dir = mkdtempSync(join(tmpdir(), "alpha-clock-content-"));
  try {
    const path = join(dir, "content.json");
    writeFileSync(path, JSON.stringify([{ id: 1, title: "标题", preview: "摘要", body: "正文" }]));
    const store = new ContentStore(path);
    assert.equal(store.get(1)?.previewText, "摘要");
    assert.equal(store.get(1)?.contentHash, hashContent("正文"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("拒绝正文与 contentHash 不一致，并可原子落盘恢复", () => {
  const dir = mkdtempSync(join(tmpdir(), "alpha-clock-content-"));
  try {
    const path = join(dir, "content.json");
    const store = new ContentStore(path);
    assert.throws(() => store.put({
      id: 1,
      title: "标题",
      previewText: "摘要",
      body: "正文",
      contentHash: hashContent("别的正文"),
    }), /contentHash/);
    const contentHash = hashContent("正文");
    store.put({ id: 1, title: "标题", previewText: "摘要", body: "正文", contentHash });
    assert.equal(new ContentStore(path).get(1)?.contentHash, contentHash);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("启动时拒绝正文与已记录 contentHash 不一致的文件", () => {
  const dir = mkdtempSync(join(tmpdir(), "alpha-clock-content-"));
  try {
    const path = join(dir, "content.json");
    writeFileSync(path, JSON.stringify([{
      id: 9,
      title: "被篡改",
      previewText: "摘要",
      body: "实际正文",
      contentHash: hashContent("另一份正文"),
    }]));
    assert.throws(() => new ContentStore(path), /contentHash 不一致/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
