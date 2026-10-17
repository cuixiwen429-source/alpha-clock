#!/usr/bin/env node
/**
 * 新部署 = 新的链状态，本地这些文件全部作废（信号 id 会从 1 重新开始）：
 *
 *   content.json            信号 id → 正文。旧正文会挂到新链的新信号 id 上，
 *                           与链上 contentHash 对不上时 withStoredHash() 会 502；
 *                           对得上更糟 —— 那是"另一个信号"的正文。
 *   .runtime/free-claims.ndjson  免费领取记录。带过去会把上一条链的领取
 *                           算到新链的 #1 头上，白送访问权。
 *   .runtime/quotes.json    报价。amount 和 payTo 都是旧合约、旧发布者的。
 *   events.ndjson           发布审计日志，同理。
 *
 *   node scripts/reset-state.mjs
 */
import { existsSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const BACKEND = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const targets = ["content.json", "events.ndjson", ".runtime"];
let removed = 0;

for (const target of targets) {
  const path = resolve(BACKEND, target);
  if (!existsSync(path)) continue;
  rmSync(path, { recursive: true, force: true });
  console.log(`  清理 ${target}`);
  removed += 1;
}

console.log(removed ? "本地状态已重置（部署后请重新 npm run seed）" : "本地状态本来就是干净的");
