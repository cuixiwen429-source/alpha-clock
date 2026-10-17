// Halfie & Friends —— 像素 IP 资源注册表。
//
// 图片资源放 frontend/assets/sprites/<name>.png（透明背景，AI 出图后直接丢进来，文件名对上就行）。
// 图还没到位时，每个角色有一个程序生成的占位 sprite（纯色块 + 描边），接口和真图完全一致，
// 所以 halfie.js / 大屏 / 购买页可以先对着占位图开发，图一到位换文件名不用改任何调用代码。
//
// 用法：
//   import { loadSprite, SPRITES } from "./sprites.js";
//   const img = await loadSprite("halfie");          // HTMLImageElement 或 HTMLCanvasElement
//   ctx.drawImage(img, x, y, size, size);

export const SPRITES = {
  halfie: { file: "halfie.png", outline: "#8B5CF6", fallback: "flame" },
  "halfie-free": { file: "halfie-free.png", outline: "#3DDC97", fallback: "flame-free" },
  bolt: { file: "bolt.png", outline: "#FFC53D", fallback: "shard" },
  rush: { file: "rush.png", outline: "#0A0B0C", fallback: "fox" },
  hoot: { file: "hoot.png", outline: "#0A0B0C", fallback: "owl" },
  lazlo: { file: "lazlo.png", outline: "#0A0B0C", fallback: "sloth" },
};

const ASSET_BASE = new URL("../assets/sprites/", import.meta.url);
const cache = new Map();

function probeImage(url) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = url;
  });
}

/**
 * 加载一个角色的 sprite。真图存在就用真图；404 就返回程序生成的占位图（16×16 放大到 256×256 canvas）。
 * 结果会缓存，重复调用不重复加载/生成。
 */
export async function loadSprite(name) {
  if (cache.has(name)) return cache.get(name);
  const def = SPRITES[name];
  if (!def) throw new Error(`未知 sprite: ${name}（在 sprites.js 的 SPRITES 里注册）`);

  const promise = (async () => {
    const real = await probeImage(new URL(def.file, ASSET_BASE).href);
    return real || drawPlaceholder(def.fallback, def.outline);
  })();

  cache.set(name, promise);
  return promise;
}

/** 预加载全部角色，大屏/购买页启动时调一次，避免首次用到时才发请求造成闪烁 */
export const preloadAll = () => Promise.all(Object.keys(SPRITES).map(loadSprite));

// ── 占位图：16×16 逐格描述 → 256×256 canvas ──────────────────
// 0 = 透明；其余是 tokens.css 里的真实颜色，保证占位图配色和最终真图在同一色板里，
// 换图前后界面不会"跳色"。

const T = { amber: "#FFC53D", gold: "#D9A63C", cool: "#8E939C", dead: "#6E747E", free: "#3DDC97", fg: "#F2F3F5", dark: "#16181B", bg: "#08090A" };

const G = 16; // grid

function circleMask(cx, cy, r) {
  const m = Array.from({ length: G }, () => Array(G).fill(0));
  for (let y = 0; y < G; y++)
    for (let x = 0; x < G; x++)
      if (Math.hypot(x - cx, y - cy) <= r) m[y][x] = 1;
  return m;
}

const PLACEHOLDERS = {
  // Halfie（火热态）：同心圆分层模拟"失温的火"，核心留两个白色像素当眼睛
  flame: (px) => {
    for (let y = 0; y < G; y++)
      for (let x = 0; x < G; x++) {
        const d = Math.hypot(x - 7.5, y - 8.5);
        if (d > 7.2) continue;
        px[y][x] = d > 5.5 ? T.amber : d > 3.8 ? T.gold : d > 2.2 ? T.cool : T.dead;
      }
    px[6][6] = T.fg; px[6][9] = T.fg; // 眼睛，最后消失
  },
  // Halfie（免费态）：同样轮廓，整体青绿，核心更亮
  "flame-free": (px) => {
    for (let y = 0; y < G; y++)
      for (let x = 0; x < G; x++) {
        const d = Math.hypot(x - 7.5, y - 8.5);
        if (d > 6) continue;
        px[y][x] = T.free;
      }
    px[6][6] = T.bg; px[6][9] = T.bg;
  },
  // Bolt：非生物碎石，无面部
  shard: (px) => {
    const rows = ["...XX...", "..XXXX..", ".XXXXXX.", "XXX..XXX", "XXXX.XXX", ".XXXXXX.", "..XX.XX.", "...XX..."];
    rows.forEach((row, y) => {
      [...row].forEach((c, x) => {
        if (c !== "X") return;
        px[y + 3][x + 4] = (x + y) % 3 === 0 ? T.bg : T.fg; // 之字裂缝用深色点缀
      });
    });
  },
  // Rush：狐狸简化剪影
  fox: (px) => {
    const m = circleMask(8, 9, 4);
    for (let y = 0; y < G; y++) for (let x = 0; x < G; x++) if (m[y][x]) px[y][x] = T.gold;
    [[3, 4], [4, 3], [11, 4], [12, 3]].forEach(([x, y]) => (px[y][x] = T.gold)); // 耳朵
    [[3, 11], [4, 12], [2, 10]].forEach(([x, y]) => (px[y][x] = T.dark)); // 尾巴
    px[8][6] = T.fg; // 眼
  },
  // Hoot：圆胖身体 + 大眼睛
  owl: (px) => {
    const m = circleMask(7.5, 9, 5.5);
    for (let y = 0; y < G; y++) for (let x = 0; x < G; x++) if (m[y][x]) px[y][x] = T.cool;
    for (const [x, y] of circleMask(5, 7, 1.8).flatMap((row, y) => row.map((v, x) => (v ? [x, y] : null)).filter(Boolean)))
      px[y][x] = T.dark;
    for (const [x, y] of circleMask(10, 7, 1.8).flatMap((row, y) => row.map((v, x) => (v ? [x, y] : null)).filter(Boolean)))
      px[y][x] = T.dark;
    px[7][5] = T.bg; px[7][10] = T.bg; // 瞳孔
    px[9][7] = T.amber; px[9][8] = T.amber; // 喙
  },
  // Lazlo：软圆身体 + 眯眼
  sloth: (px) => {
    const m = circleMask(8, 9, 5.5);
    for (let y = 0; y < G; y++) for (let x = 0; x < G; x++) if (m[y][x]) px[y][x] = T.free;
    for (let x = 5; x <= 7; x++) px[8][x] = T.dark; // 左眯眼
    for (let x = 9; x <= 11; x++) px[8][x] = T.dark; // 右眯眼
    px[11][7] = T.dark; px[11][8] = T.dark; // 嘴
  },
};

function drawPlaceholder(key, outline) {
  const px = Array.from({ length: G }, () => Array(G).fill(null));
  (PLACEHOLDERS[key] || PLACEHOLDERS.flame)(px);

  const scale = 16; // 16×16 → 256×256
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = G * scale;
  const ctx = canvas.getContext("2d");
  ctx.imageSmoothingEnabled = false;

  for (let y = 0; y < G; y++)
    for (let x = 0; x < G; x++)
      if (px[y][x]) { ctx.fillStyle = px[y][x]; ctx.fillRect(x * scale, y * scale, scale, scale); }

  // 简易外描边：给每个有色格子里"相邻为空"的边画一条描边线
  ctx.strokeStyle = outline;
  ctx.lineWidth = 2;
  for (let y = 0; y < G; y++)
    for (let x = 0; x < G; x++) {
      if (!px[y][x]) continue;
      const edges = [[0, -1], [0, 1], [-1, 0], [1, 0]].filter(([dx, dy]) => !px[y + dy]?.[x + dx]);
      for (const [dx, dy] of edges) {
        ctx.beginPath();
        const x0 = x * scale + (dx === 1 ? scale : 0), x1 = dx === -1 ? x * scale : x0;
        const y0 = y * scale + (dy === 1 ? scale : 0), y1 = dy === -1 ? y * scale : y0;
        if (dx !== 0) { ctx.moveTo(x0, y * scale); ctx.lineTo(x0, y * scale + scale); }
        else { ctx.moveTo(x * scale, y0); ctx.lineTo(x * scale + scale, y0); }
        ctx.stroke();
      }
    }

  canvas.dataset.placeholder = "true"; // halfie.js 据此判断要不要做"逐像素碎裂"特效
  return canvas;
}
