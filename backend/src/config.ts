/**
 * AlphaClock 全局配置。
 *
 * 网络口径与 Monad 官方保持一致：
 *   monad-testnet  eip155:10143  真 USDC + 官方 facilitator（比赛正路）
 *   monad-mainnet  eip155:143
 *   local-anvil    eip155:31337  MockUSDC，走自建 facilitator（断网 Plan B）
 */
import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export interface NetConfig {
  key: "monad-testnet" | "monad-mainnet" | "local-anvil";
  chainId: number;
  network: `${string}:${string}`;
  rpcUrl: string;
  usdc: `0x${string}`;
  explorer: string;
  faucet?: string;
  facilitatorSupported: boolean;
}

export const FACILITATOR_URL =
  process.env.FACILITATOR_URL || "https://x402-facilitator.molandak.org";

export const NETWORKS: Record<string, NetConfig> = {
  "monad-testnet": {
    key: "monad-testnet",
    chainId: 10143,
    network: "eip155:10143",
    rpcUrl: process.env.MONAD_RPC_URL || "https://testnet-rpc.monad.xyz",
    usdc: "0x534b2f3A21130d7a60830c2Df862319e593943A3",
    explorer: "https://testnet.monadvision.com",
    faucet: "https://faucet.monad.xyz",
    facilitatorSupported: true,
  },
  "monad-mainnet": {
    key: "monad-mainnet",
    chainId: 143,
    network: "eip155:143",
    rpcUrl: process.env.MONAD_RPC_URL || "https://rpc.monad.xyz",
    usdc: "0x754704Bc059F8C67012fEd69BC8A327a5aafb603",
    explorer: "https://monadvision.com",
    facilitatorSupported: true,
  },
  "local-anvil": {
    key: "local-anvil",
    chainId: 31337,
    network: "eip155:31337",
    rpcUrl: process.env.MONAD_RPC_URL || "http://127.0.0.1:8545",
    usdc: "0x0000000000000000000000000000000000000000",
    explorer: "",
    facilitatorSupported: false,
  },
};

export function getNetwork(): NetConfig {
  const key = process.env.NETWORK || "monad-testnet";
  const net = NETWORKS[key];
  if (!net) throw new Error(`未知 NETWORK="${key}"，可选：${Object.keys(NETWORKS).join(" / ")}`);
  return net;
}

export interface Deployments {
  chainId: number;
  deploymentBlock?: number;
  usdc: `0x${string}`;
  isMockUSDC: boolean;
  alphaClock: `0x${string}`;
  verifier: `0x${string}`;
  treasury: `0x${string}`;
}

let _d: Deployments | null = null;

export function getDeployments(): Deployments {
  if (_d) return _d;
  const p = resolve(ROOT, "contracts/deployments.json");
  if (!existsSync(p)) {
    throw new Error("找不到 contracts/deployments.json，请先 forge script script/Deploy.s.sol");
  }
  _d = JSON.parse(readFileSync(p, "utf8")) as Deployments;
  return _d;
}

export function resolveUsdc(net: NetConfig): `0x${string}` {
  try {
    const d = getDeployments();
    if (net.key === "local-anvil") return d.usdc;
  } catch {
    /* 未部署时回落到网络默认 */
  }
  return net.usdc;
}

// ──────────────────────────── ABI ────────────────────────────

/** PRD v1 / shared API v1 对应的合约 ABI。 */
export const ALPHA_ABI = [
  {
    type: "function",
    name: "publish",
    stateMutability: "nonpayable",
    inputs: [
      { name: "title", type: "string" },
      { name: "previewURI", type: "string" },
      { name: "contentHash", type: "bytes32" },
      { name: "basePrice", type: "uint128" },
      { name: "floorPrice", type: "uint128" },
      { name: "halfLife", type: "uint32" },
    ],
    outputs: [{ name: "id", type: "uint256" }],
  },
  {
    type: "function",
    name: "buy",
    stateMutability: "nonpayable",
    inputs: [{ name: "id", type: "uint256" }],
    outputs: [{ name: "paid", type: "uint128" }],
  },
  {
    type: "function",
    name: "claimFree",
    stateMutability: "nonpayable",
    inputs: [{ name: "id", type: "uint256" }],
    outputs: [],
  },
  {
    type: "function",
    name: "recordX402",
    stateMutability: "nonpayable",
    inputs: [
      { name: "id", type: "uint256" },
      { name: "buyer", type: "address" },
      { name: "price", type: "uint128" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "openNow",
    stateMutability: "nonpayable",
    inputs: [{ name: "id", type: "uint256" }],
    outputs: [],
  },
  {
    type: "function",
    name: "currentPrice",
    stateMutability: "view",
    inputs: [{ name: "id", type: "uint256" }],
    outputs: [{ name: "", type: "uint128" }],
  },
  {
    type: "function",
    name: "priceAt",
    stateMutability: "view",
    inputs: [
      { name: "id", type: "uint256" },
      { name: "t", type: "uint64" },
    ],
    outputs: [{ name: "", type: "uint128" }],
  },
  {
    type: "function",
    name: "timeToFree",
    stateMutability: "view",
    inputs: [{ name: "id", type: "uint256" }],
    outputs: [{ name: "", type: "uint64" }],
  },
  {
    type: "function",
    name: "isFree",
    stateMutability: "view",
    inputs: [{ name: "id", type: "uint256" }],
    outputs: [{ name: "", type: "bool" }],
  },
  {
    type: "function",
    name: "accessOf",
    stateMutability: "view",
    inputs: [
      { name: "id", type: "uint256" },
      { name: "buyer", type: "address" },
    ],
    outputs: [
      {
        name: "access",
        type: "tuple",
        components: [
          { name: "at", type: "uint64" },
          { name: "price", type: "uint128" },
        ],
      },
    ],
  },
  {
    type: "function",
    name: "signalCount",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "getSignal",
    stateMutability: "view",
    inputs: [{ name: "id", type: "uint256" }],
    outputs: [
      {
        name: "v",
        type: "tuple",
        components: [
          { name: "publisher", type: "address" },
          { name: "publishedAt", type: "uint64" },
          { name: "basePrice", type: "uint128" },
          { name: "floorPrice", type: "uint128" },
          { name: "halfLife", type: "uint32" },
          { name: "forcedOpen", type: "bool" },
          { name: "contentHash", type: "bytes32" },
          { name: "title", type: "string" },
          { name: "previewURI", type: "string" },
          { name: "price", type: "uint128" },
          { name: "freeNow", type: "bool" },
        ],
      },
    ],
  },
  {
    type: "event",
    name: "Published",
    inputs: [
      { name: "id", type: "uint256", indexed: true },
      { name: "publisher", type: "address", indexed: true },
      { name: "title", type: "string", indexed: false },
      { name: "basePrice", type: "uint128", indexed: false },
      { name: "floorPrice", type: "uint128", indexed: false },
      { name: "halfLife", type: "uint32", indexed: false },
      { name: "contentHash", type: "bytes32", indexed: false },
      { name: "at", type: "uint64", indexed: false },
    ],
  },
  {
    type: "event",
    name: "Bought",
    inputs: [
      { name: "id", type: "uint256", indexed: true },
      { name: "buyer", type: "address", indexed: true },
      { name: "price", type: "uint128", indexed: false },
      { name: "elapsed", type: "uint64", indexed: false },
      { name: "viaX402", type: "bool", indexed: false },
    ],
  },
  {
    type: "event",
    name: "Claimed",
    inputs: [
      { name: "id", type: "uint256", indexed: true },
      { name: "buyer", type: "address", indexed: true },
      { name: "elapsed", type: "uint64", indexed: false },
    ],
  },
  {
    type: "event",
    name: "Opened",
    inputs: [
      { name: "id", type: "uint256", indexed: true },
      { name: "by", type: "address", indexed: true },
      { name: "at", type: "uint64", indexed: false },
    ],
  },
] as const;

/** 仅用于开发期兼容仓库当前旧合约；新部署一律使用 ALPHA_ABI。 */
export const ALPHA_LEGACY_ABI = [
  {
    type: "function",
    name: "publish",
    stateMutability: "nonpayable",
    inputs: [
      { name: "title", type: "string" },
      { name: "previewURI", type: "string" },
      { name: "contentURI", type: "string" },
      { name: "basePrice", type: "uint128" },
      { name: "floorPrice", type: "uint128" },
      { name: "halfLife", type: "uint32" },
    ],
    outputs: [{ name: "id", type: "uint256" }],
  },
  {
    type: "function",
    name: "buy",
    stateMutability: "nonpayable",
    inputs: [{ name: "id", type: "uint256" }],
    outputs: [{ name: "paid", type: "uint128" }],
  },
  {
    type: "function",
    name: "recordX402",
    stateMutability: "nonpayable",
    inputs: [
      { name: "id", type: "uint256" },
      { name: "buyer", type: "address" },
      { name: "price", type: "uint128" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "openNow",
    stateMutability: "nonpayable",
    inputs: [{ name: "id", type: "uint256" }],
    outputs: [],
  },
  {
    type: "function",
    name: "currentPrice",
    stateMutability: "view",
    inputs: [{ name: "id", type: "uint256" }],
    outputs: [{ name: "", type: "uint128" }],
  },
  {
    type: "function",
    name: "priceAt",
    stateMutability: "view",
    inputs: [
      { name: "id", type: "uint256" },
      { name: "t", type: "uint64" },
    ],
    outputs: [{ name: "", type: "uint128" }],
  },
  {
    type: "function",
    name: "timeToFree",
    stateMutability: "view",
    inputs: [{ name: "id", type: "uint256" }],
    outputs: [{ name: "", type: "uint64" }],
  },
  {
    type: "function",
    name: "isFree",
    stateMutability: "view",
    inputs: [{ name: "id", type: "uint256" }],
    outputs: [{ name: "", type: "bool" }],
  },
  {
    type: "function",
    name: "halvingsElapsed",
    stateMutability: "view",
    inputs: [{ name: "id", type: "uint256" }],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "hasAccess",
    stateMutability: "view",
    inputs: [
      { name: "", type: "uint256" },
      { name: "", type: "address" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
  {
    type: "function",
    name: "paidPrice",
    stateMutability: "view",
    inputs: [
      { name: "", type: "uint256" },
      { name: "", type: "address" },
    ],
    outputs: [{ name: "", type: "uint128" }],
  },
  {
    type: "function",
    name: "accessCount",
    stateMutability: "view",
    inputs: [{ name: "id", type: "uint256" }],
    outputs: [{ name: "", type: "uint32" }],
  },
  {
    type: "function",
    name: "signalCount",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "STEPS_PER_HALF",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "OPEN_HALVINGS",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint32" }],
  },
  {
    type: "function",
    name: "getSignal",
    stateMutability: "view",
    inputs: [{ name: "id", type: "uint256" }],
    outputs: [
      {
        name: "v",
        type: "tuple",
        components: [
          { name: "publisher", type: "address" },
          { name: "title", type: "string" },
          { name: "previewURI", type: "string" },
          { name: "contentURI", type: "string" },
          { name: "publishedAt", type: "uint64" },
          { name: "basePrice", type: "uint128" },
          { name: "floorPrice", type: "uint128" },
          { name: "halfLife", type: "uint32" },
          { name: "buyCount", type: "uint32" },
          { name: "revenue", type: "uint128" },
          { name: "price", type: "uint128" },
          { name: "freeNow", type: "bool" },
        ],
      },
    ],
  },
  {
    type: "function",
    name: "curve",
    stateMutability: "view",
    inputs: [
      { name: "id", type: "uint256" },
      { name: "samples", type: "uint32" },
    ],
    outputs: [
      { name: "prices", type: "uint128[]" },
      { name: "times", type: "uint64[]" },
    ],
  },
  {
    type: "event",
    name: "Published",
    inputs: [
      { name: "id", type: "uint256", indexed: true },
      { name: "publisher", type: "address", indexed: true },
      { name: "title", type: "string", indexed: false },
      { name: "basePrice", type: "uint128", indexed: false },
      { name: "floorPrice", type: "uint128", indexed: false },
      { name: "halfLife", type: "uint32", indexed: false },
    ],
  },
  {
    type: "event",
    name: "Bought",
    inputs: [
      { name: "id", type: "uint256", indexed: true },
      { name: "buyer", type: "address", indexed: true },
      { name: "price", type: "uint128", indexed: false },
      { name: "buyCount", type: "uint32", indexed: false },
      { name: "elapsed", type: "uint64", indexed: false },
      { name: "viaX402", type: "bool", indexed: false },
    ],
  },
  {
    type: "event",
    name: "Opened",
    inputs: [
      { name: "id", type: "uint256", indexed: true },
      { name: "at", type: "uint64", indexed: false },
      { name: "buyCount", type: "uint32", indexed: false },
      { name: "revenue", type: "uint128", indexed: false },
    ],
  },
] as const;

export const ERC20_ABI = [
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "approve",
    stateMutability: "nonpayable",
    inputs: [
      { name: "spender", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
  {
    type: "function",
    name: "faucet",
    stateMutability: "nonpayable",
    inputs: [
      { name: "to", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [],
  },
] as const;

// ──────────────────────────── 小工具 ────────────────────────────

/** $1.23 → 1_230_000n */
export const usdc = (n: number | string) => BigInt(Math.round(Number(n) * 1e6));

/** 1_230_000n → "1.230000" */
export const fmtUsdc = (units: bigint | number) => (Number(units) / 1e6).toFixed(6);

/** 1_230_000n → "$1.23"（用于展示，自动选择小数位） */
export function money(units: bigint | number): string {
  const v = Number(units) / 1e6;
  if (v === 0) return "$0";
  if (v >= 1) return `$${v.toFixed(2)}`;
  if (v >= 0.01) return `$${v.toFixed(3)}`;
  return `$${v.toFixed(6).replace(/0+$/, "")}`;
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
