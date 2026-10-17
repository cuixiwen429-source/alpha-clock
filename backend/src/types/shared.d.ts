declare module "*shared/curve.mjs" {
  export const STEPS_PER_HALF: number;
  export const OPEN_HALVINGS: number;
  export function priceAt(
    signal: {
      publishedAt: number;
      basePrice: bigint;
      floorPrice: bigint;
      halfLife: number;
      forcedOpen?: boolean;
    },
    nowSec: number,
  ): bigint;
  export function freeAt(signal: { publishedAt: number; halfLife: number }): number;
  export function nextDrop(
    signal: {
      publishedAt: number;
      basePrice: bigint;
      floorPrice: bigint;
      halfLife: number;
      forcedOpen?: boolean;
    },
    nowSec: number,
  ): { inSec: number; amount: bigint };
  export function sampleCurve(
    signal: {
      publishedAt: number;
      basePrice: bigint;
      floorPrice: bigint;
      halfLife: number;
      forcedOpen?: boolean;
    },
    samples?: number,
  ): { times: number[]; prices: bigint[] };
  export function fmtUsdc(micro: bigint | number | string): string;
  export function parseUsdc(value: string): bigint;
}

declare module "*shared/contract.mjs" {
  export const CONTRACT_VERSION: string;
}
