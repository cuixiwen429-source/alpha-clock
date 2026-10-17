// 价格的显示与"逐位跳动" —— 视觉层唯一需要的新逻辑。
// 数字本身来自 shared/curve.mjs（与合约逐位一致），这里只负责"怎么长得好看"。

/**
 * micro-USDC → 人看的字符串。规则：
 *   ≥ $0.01  → 两位小数（$8.23 / $0.22）
 *   < $0.01  → 四位小数（$0.0087）
 *   归零     → "0.00"
 * 为什么不用 6 位：大屏 148px 下 6 位会撑破版式，而且末两位每秒都在跳，
 * 观众读不出信息，只会觉得"数字在乱抖"。
 */
export function fmtPrice(micro) {
  const m = BigInt(micro);
  if (m <= 0n) return "0.00";
  if (m >= 10_000n) {
    const cents = (m + 5_000n) / 10_000n;           // 四舍五入到 0.01
    return `${cents / 100n}.${(cents % 100n).toString().padStart(2, "0")}`;
  }
  const frac = m.toString().padStart(6, "0").slice(0, 4); // 0.00xx
  return `0.${frac}`;
}

/**
 * 把字符串逐字符写进元素，只给"变了的位"加 .chg（-3px / 120ms）。
 * 全部重写会整块闪；逐位对比才叫"数字在走"。
 * @param {HTMLElement} el 目标（建议是 .price 里的子 span，不含货币符号）
 * @param {string} str 新值
 */
export function paintDigits(el, str) {
  const prev = el.dataset.prev ?? "";
  if (prev === str) return;
  let html = "";
  for (let i = 0; i < str.length; i++) {
    const ch = str[i];
    const changed = prev[i] !== undefined && prev[i] !== ch && ch !== "." && ch !== " ";
    html += `<span class="d${changed ? " chg" : ""}${ch === "0" ? "" : ""}">${ch}</span>`;
  }
  el.dataset.prev = str;
  el.innerHTML = html;
  // 抖动是一次性的：130ms 后把 .chg 摘掉（transition 会把它平滑放回去），
  // 否则字符会一直悬在上方，看起来像排版错位
  el.querySelectorAll(".chg").forEach((n) => setTimeout(() => n.classList.remove("chg"), 130));
}

/** 零值显示：归零后不再跳动，直接换成这个词 */
export const FREE_LABEL = "免费";
