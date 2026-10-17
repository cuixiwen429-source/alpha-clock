// 身份与购买。页面只调 identity() / buy() / claim()，不关心当前连的是 mock 还是真链。
//
// 真后端：浏览器钱包 → approve USDC → AlphaClock.buy(id) → 凭链上访问权取正文
// mock：  调 /__mock/buy 模拟"链上 buy 成功"，其余流程一模一样

import { api } from "./api.js";

const VIEM = "https://esm.sh/viem@2.57.7"; // 仅真链模式才加载，断网演示不受影响
const BURNER_KEY = "alpha.burner";
const WALLET_KEY = "alpha.wallet";

const ERC20_ABI = [
  { type: "function", name: "approve", stateMutability: "nonpayable", inputs: [{ name: "s", type: "address" }, { name: "a", type: "uint256" }], outputs: [{ type: "bool" }] },
  { type: "function", name: "allowance", stateMutability: "view", inputs: [{ name: "o", type: "address" }, { name: "s", type: "address" }], outputs: [{ type: "uint256" }] },
];
const ALPHA_ABI = [{ type: "function", name: "buy", stateMutability: "nonpayable", inputs: [{ name: "id", type: "uint256" }], outputs: [{ type: "uint128" }] }];

let connected = null; // 钱包地址

/** 免费领取 / mock 购买用的本地身份；连过钱包就认那个地址，刷新也不退回 burner */
export function identity() {
  if (connected) return connected;
  const saved = localStorage.getItem(WALLET_KEY);
  if (saved) return saved;
  let a = localStorage.getItem(BURNER_KEY);
  if (!a) {
    a = "0x" + [...crypto.getRandomValues(new Uint8Array(20))].map((b) => b.toString(16).padStart(2, "0")).join("");
    localStorage.setItem(BURNER_KEY, a);
  }
  return a;
}

export const hasWallet = () => typeof window.ethereum !== "undefined";

/** 已授权的钱包静默恢复。eth_accounts 不弹窗。 */
export async function restoreIdentity() {
  if (!window.ethereum) return connected;
  try {
    const [addr] = await window.ethereum.request({ method: "eth_accounts" });
    if (addr) {
      connected = addr;
      localStorage.setItem(WALLET_KEY, addr);
    }
  } catch { /* 没装钱包或用户拒绝过，收据仍走 localStorage 里的地址 */ }
  return connected;
}

export async function connectWallet() {
  const cfg = await api.config();
  const [addr] = await window.ethereum.request({ method: "eth_requestAccounts" });
  const hexId = "0x" + cfg.chainId.toString(16);
  const chainParams = {
    chainId: hexId,
    chainName: cfg.chainId === 31337 ? "Anvil" : "Monad Testnet",
    nativeCurrency: { name: "MON", symbol: "MON", decimals: 18 },
    rpcUrls: [cfg.rpcUrl],
  };
  // 本地 anvil 的 explorer 是空串，塞进 blockExplorerUrls 会被钱包拒绝
  if (cfg.explorer) chainParams.blockExplorerUrls = [cfg.explorer];
  try {
    await window.ethereum.request({ method: "wallet_switchEthereumChain", params: [{ chainId: hexId }] });
  } catch (e) {
    if (e.code !== 4902) throw e;
    await window.ethereum.request({ method: "wallet_addEthereumChain", params: [chainParams] });
  }
  connected = addr;
  localStorage.setItem(WALLET_KEY, addr);
  return addr;
}

/**
 * 按报价购买，返回正文（Content）。
 * onStep(text) 用来给按钮显示进度："授权 USDC…" / "确认购买…" / "等待上链…"
 */
export async function buy(signalId, quote, onStep = () => {}) {
  const cfg = await api.config();

  if (cfg.mock) {
    onStep("模拟上链…");
    const address = identity();
    await api.mockBuy(signalId, address, quote.quoteId);
    return api.content(signalId, address);
  }

  if (!connected) await connectWallet();
  const { createWalletClient, createPublicClient, custom, http } = await import(VIEM);
  const chain = { id: cfg.chainId, name: "Monad", nativeCurrency: { name: "MON", symbol: "MON", decimals: 18 }, rpcUrls: { default: { http: [cfg.rpcUrl] } } };
  const wallet = createWalletClient({ account: connected, chain, transport: custom(window.ethereum) });
  const pub = createPublicClient({ chain, transport: http(cfg.rpcUrl) });

  // 价格单调递减，链上实扣 ≤ 报价，所以按报价额度授权就够
  const amount = BigInt(quote.amountMicro);
  const allowance = await pub.readContract({ address: cfg.usdc, abi: ERC20_ABI, functionName: "allowance", args: [connected, cfg.contract] });
  if (allowance < amount) {
    onStep("授权 USDC…");
    const h = await wallet.writeContract({ address: cfg.usdc, abi: ERC20_ABI, functionName: "approve", args: [cfg.contract, amount] });
    await pub.waitForTransactionReceipt({ hash: h });
  }
  onStep("确认购买…");
  const hash = await wallet.writeContract({ address: cfg.contract, abi: ALPHA_ABI, functionName: "buy", args: [BigInt(signalId)] });
  onStep("等待上链…");
  await pub.waitForTransactionReceipt({ hash });

  // 索引器最多晚 1s，给它几次机会
  for (let i = 0; i < 6; i++) {
    try { return await api.content(signalId, connected); }
    catch (e) { if (e.status !== 402) throw e; await new Promise((r) => setTimeout(r, 500)); }
  }
  throw new Error("链上已购买，但后端还没索引到，请稍后刷新");
}

export const claim = (signalId) => api.claim(signalId, identity());
