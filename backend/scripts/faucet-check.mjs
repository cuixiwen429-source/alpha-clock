#!/usr/bin/env node
/**
 * 水龙头到账检查器 —— 领完币跑一次，看够不够开工。
 *
 *   node scripts/faucet-check.mjs          查一次
 *   node scripts/faucet-check.mjs --watch  每 8 秒刷一次，到账自动提示
 *
 * 只读：不签名、不发交易、不碰私钥。
 */
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// ── 从 .env 读地址（只读 ADDRESS 推导，不打印私钥）────────────────
function loadEnv() {
  const out = {};
  try {
    for (const line of readFileSync(resolve(ROOT, ".env"), "utf8").split("\n")) {
      const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*)\s*$/);
      if (m && !line.trim().startsWith("#")) out[m[1]] = m[2].trim();
    }
  } catch {}
  return out;
}

// keccak 太麻烦，用 foundry 的 cast 反推地址（本机已装）
async function addrFromPk(pk) {
  const { execSync } = await import("node:child_process");
  const cast = `${process.env.HOME}/.foundry/bin/cast`;
  return execSync(`${cast} wallet address --private-key ${pk}`, { encoding: "utf8" }).trim();
}

const env = loadEnv();
const RPC = env.MONAD_RPC_URL || "https://testnet-rpc.monad.xyz";
const USDC = env.USDC_ADDRESS || "0x534b2f3A21130d7a60830c2Df862319e593943A3";

let ADDR = process.env.ADDR || "";
if (!ADDR && env.PRIVATE_KEY) ADDR = await addrFromPk(env.PRIVATE_KEY);
if (!ADDR) {
  console.error("没找到地址：请在 .env 里填 PRIVATE_KEY，或用 ADDR=0x... node scripts/faucet-check.mjs");
  process.exit(1);
}

async function rpc(method, params) {
  const r = await fetch(RPC, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const j = await r.json();
  if (j.error) throw new Error(j.error.message);
  return j.result;
}

const fmt = (wei, d = 4) => (Number(BigInt(wei)) / 1e18).toFixed(d);

// 门槛：部署 AlphaClock 实测 ≈ 0.19 MON；够跑一场 100 笔演示 ≈ +2.5 MON
const NEED_DEPLOY = 0.19;
const NEED_DEMO = 2.5;

async function probe() {
  const [balHex, usdcHex, gasHex, blockHex] = await Promise.all([
    rpc("eth_getBalance", [ADDR, "latest"]),
    rpc("eth_call", [{ to: USDC, data: "0x70a08231" + ADDR.slice(2).padStart(64, "0") }, "latest"]),
    rpc("eth_gasPrice", []),
    rpc("eth_blockNumber", []),
  ]);
  const mon = Number(BigInt(balHex)) / 1e18;
  const usdc = Number(BigInt(usdcHex)) / 1e6;
  const gasPrice = Number(BigInt(gasHex)) / 1e9; // gwei
  // 一笔转账 ≈ 21000 gas，一笔购买 ≈ 250000 gas
  const perTx = (21000 * gasPrice * 1e-9).toFixed(6);
  const perBuy = (250000 * gasPrice * 1e-9).toFixed(4);
  return { mon, usdc, gasPrice, perTx, perBuy, block: Number(BigInt(blockHex)) };
}

function render({ mon, usdc, gasPrice, perTx, perBuy, block }) {
  const bar = (v, need) => {
    const n = 12;
    const k = Math.min(n, Math.round((v / need) * n));
    return "█".repeat(k) + "░".repeat(n - k);
  };
  const line = [];
  line.push("");
  line.push(`  地址      ${ADDR}`);
  line.push(`  区块      #${block}   gas ${gasPrice} gwei   单笔转账 ≈ ${perTx} MON   单笔购买 ≈ ${perBuy} MON`);
  line.push("");
  line.push(`  MON       ${mon.toFixed(4)}   ${bar(mon, NEED_DEPLOY)}  部署门槛 ${NEED_DEPLOY}`);
  line.push(`                                  ${bar(mon, NEED_DEMO)}  整场演示 ${NEED_DEMO}`);
  line.push(`  USDC      ${usdc.toFixed(2)}`);
  line.push("");
  if (mon === 0) {
    line.push("  ❌ 还没到账。去 https://faucet.monad.xyz 领，领完再跑一次。");
  } else if (mon < NEED_DEPLOY) {
    line.push(`  ⚠️  能收钱不能开工：部署要 ${NEED_DEPLOY} MON，还差 ${(NEED_DEPLOY - mon).toFixed(4)}。`);
    line.push(`     再领 ${Math.ceil((NEED_DEPLOY - mon) / 0.05)} 次（按 0.05/次算），或换 Alchemy 领 1 MON。`);
  } else if (mon < NEED_DEMO) {
    line.push(`  ✅ 够部署。但演示跑 100 笔购买要 ${NEED_DEMO} MON，建议再领 ${Math.ceil((NEED_DEMO - mon) / 1)} 次 Alchemy（1 MON/次）。`);
  } else {
    line.push("  ✅ 充足。可以部署 + 完整演示，不怕 gas 打光。");
  }
  if (usdc === 0) {
    line.push("  ⚠️  USDC 为 0 —— AlphaClock 定价收的是 USDC，买家钱包必须先有 USDC 才能付款。");
  }
  line.push("");
  return line.join("\n");
}

const watch = process.argv.includes("--watch");
if (!watch) {
  console.log(render(await probe()));
  process.exit(0);
}

let last = -1;
console.log(`  盯着 ${ADDR} …（Ctrl+C 退出）`);
while (true) {
  try {
    const d = await probe();
    if (d.mon !== last) {
      console.clear?.();
      console.log(render(d));
      last = d.mon;
      if (d.mon > 0) console.log(`  🔔 ${new Date().toLocaleTimeString("zh-CN")} 到账了！\n`);
    }
  } catch (e) {
    console.log(`  … RPC 抖动（${e.message.slice(0, 40)}），稍后重试`);
  }
  await new Promise((r) => setTimeout(r, 8000));
}
