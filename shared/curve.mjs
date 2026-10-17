// 价格曲线 —— 与 AlphaClock.sol 的 priceAt() 逐位一致（PRD §5.1）。
// 前端、mock、后端共用这一份；改这里必须同步改合约，反之亦然。
// 所有金额都是 micro-USDC 的 BigInt，时间是秒（Number）。

export const STEPS_PER_HALF = 32;
export const OPEN_HALVINGS = 8;
const WAD = 10n ** 18n;

// 2^(-i/32) × 1e18，与合约 _fracTable() 相同
export const FRAC = [
  1000000000000000000n, 978572062087700096n, 957603280698573696n, 937083817055149952n,
  917004043204671232n, 897354537501553536n, 878126080186649728n, 859309649061238912n,
  840896415253714560n, 822877739076982528n, 805245165974627200n, 787990422553943296n,
  771105412703970432n, 754582213796711424n, 738413072969749632n, 722590403488523264n,
  707106781186547584n, 691954940981916032n, 677127773468446336n, 662618321579870720n,
  648419777325504768n, 634525478595866624n, 620928906036742016n, 607623679990234496n,
  594603557501360512n, 581862429388788736n, 569394317378345792n, 557193371297946240n,
  545253866332628864n, 533570200338411840n, 522136891213706880n, 510948574327058304n,
];

/**
 * @param {{publishedAt:number, basePrice:bigint, floorPrice:bigint, halfLife:number, forcedOpen?:boolean}} sig
 * @param {number} nowSec 秒级时间戳（会向下取整，与 block.timestamp 一致）
 * @returns {bigint} micro-USDC
 */
export function priceAt(sig, nowSec) {
  if (sig.forcedOpen) return 0n;
  const t = Math.floor(nowSec);
  if (t <= sig.publishedAt) return sig.basePrice;
  const steps = Math.floor(((t - sig.publishedAt) * STEPS_PER_HALF) / sig.halfLife);
  if (steps >= OPEN_HALVINGS * STEPS_PER_HALF) return 0n;
  const p = ((sig.basePrice >> BigInt(Math.floor(steps / STEPS_PER_HALF))) * FRAC[steps % STEPS_PER_HALF]) / WAD;
  return p < sig.floorPrice ? sig.floorPrice : p;
}

export const freeAt = (sig) => sig.publishedAt + sig.halfLife * OPEN_HALVINGS;

/** 距离价格下一次变化的秒数，以及那一刻的价格（"再等 N 秒省 X"） */
export function nextDrop(sig, nowSec) {
  const t = Math.max(0, Math.floor(nowSec) - sig.publishedAt);
  const steps = Math.floor((t * STEPS_PER_HALF) / sig.halfLife);
  const nextT = Math.ceil(((steps + 1) * sig.halfLife) / STEPS_PER_HALF);
  const now = priceAt(sig, nowSec);
  const next = priceAt(sig, sig.publishedAt + nextT);
  return { inSec: nextT - t, amount: now - next };
}

/** 采样整条曲线，给图表用 */
export function sampleCurve(sig, samples = 120) {
  const span = sig.halfLife * OPEN_HALVINGS;
  const times = [], prices = [];
  for (let i = 0; i <= samples; i++) {
    const dt = Math.floor((span * i) / samples);
    times.push(dt);
    prices.push(priceAt({ ...sig, forcedOpen: false }, sig.publishedAt + dt));
  }
  return { times, prices };
}

/** micro-USDC → "7.071068" */
export function fmtUsdc(micro) {
  const m = BigInt(micro);
  return `${m / 1_000_000n}.${(m % 1_000_000n).toString().padStart(6, "0")}`;
}

/** "7.071068" → 7071068n */
export function parseUsdc(s) {
  const [i, f = ""] = String(s).split(".");
  return BigInt(i) * 1_000_000n + BigInt((f + "000000").slice(0, 6));
}
