import type { Address, Hex } from "viem";

export interface ChainSignal {
  id: number;
  publisher: Address;
  publishedAt: number;
  basePrice: bigint;
  floorPrice: bigint;
  halfLife: number;
  forcedOpen: boolean;
  contentHash: Hex;
  title: string;
  previewURI: string;
}

export interface Trade {
  rank: number;
  buyer: Address;
  label: string;
  priceMicro: bigint;
  elapsed: number;
  at: number;
  channel: "onchain" | "x402" | "free";
  txHash: Hex | null;
  blockNumber: number | null;
}

export interface SignalStats {
  buyers: number;
  claims: number;
  revenue: bigint;
  maxPaid: bigint | null;
  minPaid: bigint | null;
  spread: number | null;
  recent: Trade[];
  trades: Trade[];
  openedAt: number | null;
  blockNumber: number | null;
}

export interface AccessRecord {
  at: number;
  price: bigint;
}
