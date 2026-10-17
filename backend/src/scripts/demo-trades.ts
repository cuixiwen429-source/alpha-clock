/**
 * 两笔真实成交，给演示片当证据。
 *
 *   npx tsx src/scripts/demo-trades.ts <signalId> <buyerB-privateKey>
 *
 * buyerB 是一个新钱包：先从部署钱包转 1 MON 手续费 + 5 USDC，再由它自己 approve + buy。
 * 两笔都在链上，收据页读的是 /api/signals/:id/receipt 的真实记录。
 * 第二笔故意晚买：同一句话、同一个合约，价格差多少由时间决定。
 */
import { createPublicClient, createWalletClient, defineChain, http, parseUnits, type Address, type Hex } from "viem";
import { mnemonicToAccount, privateKeyToAccount } from "viem/accounts";
import { config as dotenv } from "dotenv";
import { ALPHA_ABI, ERC20_ABI, getDeployments, getNetwork, money, sleep, usdc } from "../config.js";

const TRANSFER_ABI = [{
  type: "function", name: "transfer", stateMutability: "nonpayable",
  inputs: [{ name: "to", type: "address" }, { name: "amount", type: "uint256" }],
  outputs: [{ name: "", type: "bool" }],
}] as const;

dotenv();

const net = getNetwork();
const dep = getDeployments();
const chain = defineChain({
  id: net.chainId,
  name: net.key,
  nativeCurrency: { name: "MON", symbol: "MON", decimals: 18 },
  rpcUrls: { default: { http: [net.rpcUrl] } },
});
const pub = createPublicClient({ chain, transport: http(net.rpcUrl) });

const signalId = BigInt(process.argv[2] || 1);
const buyerKey = process.argv[3] as Hex;
if (!buyerKey) throw new Error("需要第二个买家的私钥");

const funder = privateKeyToAccount(process.env.PRIVATE_KEY as Hex);
const buyer = privateKeyToAccount(buyerKey);
const funderWallet = createWalletClient({ account: funder, chain, transport: http(net.rpcUrl) });
const buyerWallet = createWalletClient({ account: buyer, chain, transport: http(net.rpcUrl) });

async function balanceOf(who: Address) {
  const [mon, token] = await Promise.all([
    pub.getBalance({ address: who }),
    pub.readContract({ address: dep.usdc, abi: ERC20_ABI, functionName: "balanceOf", args: [who] }),
  ]);
  return { mon, token: token as bigint };
}

async function buy(who: Address, wallet: typeof funderWallet, label: string) {
  const price = (await pub.readContract({
    address: dep.alphaClock, abi: ALPHA_ABI, functionName: "currentPrice", args: [signalId],
  })) as bigint;
  if (price === 0n) throw new Error("价格已经归零，这一笔没有意义");

  const approve = await wallet.writeContract({
    address: dep.usdc, abi: ERC20_ABI, functionName: "approve", args: [dep.alphaClock, usdc(1_000_000)],
  });
  await pub.waitForTransactionReceipt({ hash: approve });
  const hash = await wallet.writeContract({
    address: dep.alphaClock, abi: ALPHA_ABI, functionName: "buy", args: [signalId],
  });
  const rc = await pub.waitForTransactionReceipt({ hash });
  const access = (await pub.readContract({
    address: dep.alphaClock, abi: ALPHA_ABI, functionName: "accessOf", args: [signalId, who],
  })) as { at: bigint; price: bigint };
  console.log(`  ${label} ${who} 此刻报价 ${money(price)} → 成交 ${money(access.price)}  block ${rc.blockNumber}`);
  return access.price;
}

async function main() {
  const before = await balanceOf(buyer.address);
  if (before.mon < parseUnits("0.05", 18) || before.token < usdc(5)) {
    // 手续费 + 够买 5 USDC 以内的正文；转多了会浪费，转少了要重来
    const gas = await funderWallet.sendTransaction({ to: buyer.address, value: parseUnits("1", 18) });
    await pub.waitForTransactionReceipt({ hash: gas });
    const token = await funderWallet.writeContract({
      address: dep.usdc, abi: TRANSFER_ABI, functionName: "transfer", args: [buyer.address, usdc(5)],
    });
    await pub.waitForTransactionReceipt({ hash: token });
    console.log(`  给 ${buyer.address} 打了 1 MON + 5 USDC`);
  }

  console.log(`信号 #${signalId}`);
  await buy(funder.address, funderWallet, "第一笔（部署钱包）");
  const wait = Number(process.argv[4] || 20);
  console.log(`  等 ${wait}s 再买第二笔…`);
  await sleep(wait * 1000);
  await buy(buyer.address, buyerWallet, "第二笔（新钱包）");
  console.log(`  两个地址：${funder.address} / ${buyer.address}`);
}

void main();
