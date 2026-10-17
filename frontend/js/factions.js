// 阵营归属 —— 按买入时机把买家分到四个神话角色阵营之一（docs/IP-ART-BRIEF.md）。
//
// 这是展示层的叙事判断，不是业务规则：阵营完全由"第几个半衰期买入"这个
// 已有数据（Trade.elapsed / sig.halfLife）推算，不需要后端/合约记录任何新字段。
//
//   Bolt  第 1 个半衰期内    —— 雷霆碎片，唯一亲眼看见火被偷的东西
//   Rush  第 1–3 个半衰期    —— 抓不住的狐狸，嗅到风声就出手
//   Hoot  第 3–8 个半衰期    —— 雅典娜的猫头鹰，算好了才买
//   Lazlo 归零后免费领取      —— 厄庇米修斯家的树懒，反正最后都是大家的
//
// 用法：
//   import { factionOf, FACTIONS } from "./factions.js";
//   const f = factionOf({ elapsed, halfLife, channel });   // → FACTIONS.bolt 等
//   el.textContent = f.line;                                // 现成的角色台词

export const FACTIONS = {
  bolt: {
    key: "bolt",
    name: "Bolt",
    sprite: "bolt",
    colorVar: "--c-bolt",
    line: "我比你们早。",
  },
  rush: {
    key: "rush",
    name: "Rush",
    sprite: "rush",
    colorVar: "--c-rush",
    line: "早一点就够了，不用最早。",
  },
  hoot: {
    key: "hoot",
    name: "Hoot",
    sprite: "hoot",
    colorVar: "--c-hoot",
    line: "我不是慢，我是算完了。",
  },
  lazlo: {
    key: "lazlo",
    name: "Lazlo",
    sprite: "lazlo",
    colorVar: "--c-lazlo",
    line: "反正最后都是大家的。",
  },
};

/**
 * @param {{elapsed:number, halfLife:number, channel?:string}} t
 *   elapsed  —— 买入时距发布过去的秒数（Trade.elapsed / 购买时的 t-publishedAt）
 *   halfLife —— 该信号的半衰期（秒）
 *   channel  —— 可选，"free" 表示免费领取（归零后），优先判定为 Lazlo
 * @returns {typeof FACTIONS[keyof typeof FACTIONS]}
 */
export function factionOf({ elapsed, halfLife, channel }) {
  if (channel === "free" || elapsed >= halfLife * 8) return FACTIONS.lazlo;
  const halvings = elapsed / halfLife;
  if (halvings < 1) return FACTIONS.bolt;
  if (halvings < 3) return FACTIONS.rush;
  return FACTIONS.hoot;
}

/**
 * 批量统计一组成交记录的阵营分布，供大屏阵营面板使用。
 * @param {Array<{elapsed:number, channel?:string}>} trades
 * @param {number} halfLife
 * @returns {{bolt:number, rush:number, hoot:number, lazlo:number}}
 */
export function factionCounts(trades, halfLife) {
  const counts = { bolt: 0, rush: 0, hoot: 0, lazlo: 0 };
  for (const t of trades) counts[factionOf({ ...t, halfLife }).key]++;
  return counts;
}
