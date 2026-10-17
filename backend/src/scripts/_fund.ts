import { createPublicClient, createWalletClient, defineChain, http, formatUnits, parseUnits, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { config as dotenv } from "dotenv";
dotenv();
const chain = defineChain({ id: 10143, name: "monad", nativeCurrency: { name: "MON", symbol: "MON", decimals: 18 }, rpcUrls: { default: { http: ["https://testnet-rpc.monad.xyz"] } } });
const pub = createPublicClient({ chain, transport: http("https://testnet-rpc.monad.xyz") });
const acct = privateKeyToAccount(process.env.PRIVATE_KEY as Hex);
const b = privateKeyToAccount("0x50648ebe02f0f4d8c5ca8d08471bc65a176d1198723139ebac72053658970ce9");
const ABI = [{ type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ name: "a", type: "address" }], outputs: [{ type: "uint256" }] }, { type: "function", name: "transfer", stateMutability: "nonpayable", inputs: [{ name: "t", type: "address" }, { name: "v", type: "uint256" }], outputs: [{ type: "bool" }] }] as const;
const usdc = "0xc64b5C61B5c11859b72c7fc69D69b0bc15155e48" as const;
const [m1, u1, m2, u2] = await Promise.all([pub.getBalance({ address: acct.address }), pub.readContract({ address: usdc, abi: ABI, functionName: "balanceOf", args: [acct.address] }), pub.getBalance({ address: b.address }), pub.readContract({ address: usdc, abi: ABI, functionName: "balanceOf", args: [b.address] })]);
console.log("deployer MON", formatUnits(m1, 18), "USDC", formatUnits(u1, 6), "| buyer MON", formatUnits(m2, 18), "USDC", formatUnits(u2, 6));
const wallet = createWalletClient({ account: acct, chain, transport: http("https://testnet-rpc.monad.xyz") });
if (u2 < parseUnits("6", 6)) {
  const h = await wallet.writeContract({ address: usdc, abi: ABI, functionName: "transfer", args: [b.address, parseUnits("6", 6)] });
  await pub.waitForTransactionReceipt({ hash: h });
  console.log("sent 6 USDC", h);
}
if (m2 < parseUnits("0.3", 18)) {
  const h = await wallet.sendTransaction({ to: b.address, value: parseUnits("0.5", 18) });
  await pub.waitForTransactionReceipt({ hash: h });
  console.log("sent 0.5 MON", h);
}
