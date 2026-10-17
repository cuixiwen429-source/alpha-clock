/**
 * 一个买家买一条信号。
 *
 *   npx tsx src/scripts/buy.ts <signalId> [buyerIndex]
 *
 * buyerIndex 取 anvil 默认助记词的第 N 个账户（0 = 部署者，1..9 = 买家）。
 * 现场演示时开 5 个终端各跑一次，就能看到价格被一笔一笔打下来。
 */
import { createPublicClient, createWalletClient, defineChain, http, type Address } from "viem";
import { mnemonicToAccount } from "viem/accounts";
import { config as dotenv } from "dotenv";
import { ALPHA_ABI, ERC20_ABI, getDeployments, getNetwork, money, sleep, usdc } from "../config.js";

dotenv();

const net = getNetwork();
const dep = getDeployments();

const chain = defineChain({
  id: net.chainId,
  name: net.key,
  nativeCurrency: { name: "MON", symbol: "MON", decimals: 18 },
  rpcUrls: { default: { http: [net.rpcUrl] } },
});

const ANVIL_MNEMONIC = "test test test test test test test test test test test junk";

async function main() {
  const signalId = Number(process.argv[2] || 1);
  const idx = Number(process.argv[3] || 1);

  const account = process.env.PRIVATE_KEY && idx === 0
    ? (await import("viem/accounts")).privateKeyToAccount(process.env.PRIVATE_KEY as `0x${string}`)
    : mnemonicToAccount(ANVIL_MNEMONIC, { addressIndex: idx });

  const pub = createPublicClient({ chain, transport: http(net.rpcUrl) });
  const wallet = createWalletClient({ account, chain, transport: http(net.rpcUrl) });

  const who = account.address as Address;

  const already = await pub.readContract({
    address: dep.alphaClock,
    abi: ALPHA_ABI,
    functionName: "hasAccess",
    args: [BigInt(signalId), who],
  });
  if (already) {
    console.log(`  你已经买过 #${signalId} 了`);
    return;
  }

  const price = await pub.readContract({
    address: dep.alphaClock,
    abi: ALPHA_ABI,
    functionName: "currentPrice",
    args: [BigInt(signalId)],
  });

  if (price === 0n) {
    console.log(`  #${signalId} 已经免费公开了，不用买`);
    return;
  }

  const bal = await pub.readContract({
    address: dep.usdc,
    abi: ERC20_ABI,
    functionName: "balanceOf",
    args: [who],
  });
  if (bal < price) {
    console.error(`  USDC 不够：有 ${money(bal)}，要 ${money(price)}`);
    process.exit(1);
  }

  console.log(`  ${who.slice(0, 10)}… 要买 #${signalId}，此刻价格 ${money(price)}`);

  // approve（只做一次，够用就行）
  const allowance = await pub.readContract({
    address: dep.usdc,
    abi: ERC20_ABI,
    functionName: "balanceOf",
    args: [who],
  });
  void allowance;

  const approveHash = await wallet.writeContract({
    address: dep.usdc,
    abi: ERC20_ABI,
    functionName: "approve",
    args: [dep.alphaClock, usdc(1_000_000)],
  });
  await pub.waitForTransactionReceipt({ hash: approveHash });

  const t0 = Date.now();
  const hash = await wallet.writeContract({
    address: dep.alphaClock,
    abi: ALPHA_ABI,
    functionName: "buy",
    args: [BigInt(signalId)],
  });
  const rc = await pub.waitForTransactionReceipt({ hash });
  const ms = Date.now() - t0;

  const paid = await pub.readContract({
    address: dep.alphaClock,
    abi: ALPHA_ABI,
    functionName: "paidPrice",
    args: [BigInt(signalId), who],
  });
  const buyCount = await pub.readContract({
    address: dep.alphaClock,
    abi: ALPHA_ABI,
    functionName: "accessCount",
    args: [BigInt(signalId)],
  });

  console.log(`  ✔ 成交  ${money(paid)}  第 ${buyCount} 个买家  确认 ${ms}ms  tx=${hash.slice(0, 12)}`);
  console.log(`     链上确认区块 ${rc.blockNumber} —— 这一笔就是"你比别人早看到了多久"的价格`);
  await sleep(10);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
