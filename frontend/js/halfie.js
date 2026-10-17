// Halfie —— 主角 IP 的"掉像素"渲染器。
//
// 产品的价格档位（8 个半衰期 × 32 档 = 256 档）正好对应一张 16×16 网格的格数。
// 不管 sprite 是占位图还是 AI 出的真图（1024×1024 等任意分辨率），都统一按 16×16
// 网格切块采样，只画"还活着"的格子——这样换真图不用改任何动画逻辑：
//   - 价格从 basePrice 降到 0，对应 Halfie 从完整 256 格逐格碎裂到 0
//   - 归零瞬间，整只切换成 halfie-free（青绿重生态）
//   - 碎落的格子会飞散出去，模拟"火星飞向买家"
//
// 用法（配合 curve.mjs）：
//   import { mountHalfie } from "./halfie.js";
//   const h = mountHalfie(document.getElementById("halfie-canvas"), { size: 256 });
//   h.render(stepsRemaining);   // 0–256，每帧传当前剩余档位即可，内部自己做差值动画
//   h.burstTo(0);               // 归零时调一次，触发像素飞散 + 切换成免费态

import { loadSprite } from "./sprites.js";

const TOTAL_STEPS = 256; // STEPS_PER_HALF(32) × OPEN_HALVINGS(8)，与 curve.mjs 一致
const GRID = 16;

// AI 出的真图是 1024×1024 的方形画布，但 Halfie 本体是竖长的水滴形，左右两侧
// 有大片透明留白（参考 docs/IP-ART-BRIEF.md 的构图）。如果直接按整张画布切 16×16
// 网格，边缘格子会切到大片透明/半透明像素，渐染出来是松散的噪点而不是有形体的火焰。
// 所以每张真图第一次加载时先检测一次非透明像素的 bounding box，之后网格只在这个
// 框内切分——这一步只在图片加载完成时跑一次（不在每帧 drawFrame 里跑），用
// getImageData 扫一遍 alpha 通道，256×256 以内的图几毫秒内就能跑完。
const bboxCache = new WeakMap();
function getBBox(img) {
  if (bboxCache.has(img)) return bboxCache.get(img);
  const c = document.createElement("canvas");
  c.width = img.width; c.height = img.height;
  const cx = c.getContext("2d", { willReadFrequently: true });
  cx.drawImage(img, 0, 0);
  const { data } = cx.getImageData(0, 0, img.width, img.height);
  let minX = img.width, minY = img.height, maxX = 0, maxY = 0;
  const ALPHA_THRESHOLD = 24; // 忽略几乎透明的边缘羽化像素，避免框被反锯齿像素撑大
  for (let y = 0; y < img.height; y++) {
    for (let x = 0; x < img.width; x++) {
      if (data[(y * img.width + x) * 4 + 3] <= ALPHA_THRESHOLD) continue;
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
    }
  }
  const box = maxX >= minX ? { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 } : { x: 0, y: 0, w: img.width, h: img.height };
  bboxCache.set(img, box);
  return box;
}

/**
 * 按"离中心的欧氏距离 + 随机扰动"给 256 个格子排一个掉落顺序。
 * 边缘先碎、核心最后散——视觉上像燃烧，不是机械地从上到下擦除。
 */
function buildDropOrder() {
  const cells = [];
  for (let y = 0; y < GRID; y++)
    for (let x = 0; x < GRID; x++) {
      const dist = Math.hypot(x - 7.5, y - 7.5);
      cells.push({ x, y, score: dist + (Math.random() - 0.5) * 1.6 }); // 扰动让掉落不是整环同时消失
    }
  cells.sort((a, b) => b.score - a.score); // 远（外圈）在前，先掉
  return cells;
}

export function mountHalfie(canvasEl, { size = 256 } = {}) {
  canvasEl.width = canvasEl.height = size;
  const ctx = canvasEl.getContext("2d");
  ctx.imageSmoothingEnabled = false;
  const cell = size / GRID;

  const dropOrder = buildDropOrder();
  let sprite = null, spriteFree = null;
  let particles = []; // 正在飞散的像素：{x,y,vx,vy,life}
  let lastStepsAlive = TOTAL_STEPS;
  let isFree = false;
  let raf = null;

  // sprite 加载是异步的，调用方很可能在图片到位前就先 render() 了一次（这次会画出空白）。
  // 图一加载完必须主动补一次 drawFrame()，否则画面会一直停在那次空白结果上，
  // 直到调用方碰巧再调一次 render()/burstTo()。
  loadSprite("halfie").then((img) => { sprite = img; drawFrame(); });
  loadSprite("halfie-free").then((img) => { spriteFree = img; drawFrame(); });

  function spawnParticles(cells) {
    for (const { x, y } of cells) {
      particles.push({
        x: x * cell + cell / 2,
        y: y * cell + cell / 2,
        vx: (x - 7.5) * 0.6 + (Math.random() - 0.5) * 2,
        vy: (y - 7.5) * 0.6 - 1 - Math.random(), // 整体略向上飘，像火星飞起
        life: 1,
      });
    }
  }

  function drawFrame() {
    ctx.clearRect(0, 0, size, size);
    const img = isFree ? spriteFree : sprite;

    if (img) {
      // 真图和占位图统一走"马赛克溶解"：把图像内容的 bounding box（不是整张画布）
      // 按 16×16 网格切块采样，只画 dropOrder 里还"活着"的格子——这样左右两侧的
      // 透明留白不会被切进格子里，渐染出来才是有形体的火焰而不是噪点。
      const box = img.dataset?.placeholder ? { x: 0, y: 0, w: img.width, h: img.height } : getBBox(img);
      const aliveSet = new Set(dropOrder.slice(0, lastStepsAlive).map((c) => `${c.x},${c.y}`));
      const srcCellW = box.w / GRID, srcCellH = box.h / GRID;
      for (let y = 0; y < GRID; y++)
        for (let x = 0; x < GRID; x++) {
          if (!aliveSet.has(`${x},${y}`)) continue;
          ctx.drawImage(
            img,
            box.x + x * srcCellW, box.y + y * srcCellH, srcCellW, srcCellH,
            x * cell, y * cell, cell, cell,
          );
        }
    }

    // 飞散的像素
    particles = particles.filter((p) => p.life > 0);
    for (const p of particles) {
      p.x += p.vx; p.y += p.vy; p.vy += 0.15; p.life -= 0.03;
      ctx.globalAlpha = Math.max(0, p.life);
      ctx.fillStyle = isFree ? "#3DDC97" : "#FFC53D";
      ctx.fillRect(p.x - 2, p.y - 2, 4, 4);
    }
    ctx.globalAlpha = 1;

    if (particles.length) raf = requestAnimationFrame(drawFrame);
    else raf = null;
  }

  function ensureAnimating() {
    if (!raf) raf = requestAnimationFrame(drawFrame);
  }

  return {
    /**
     * @param stepsRemaining 0–256，通常传 `256 - Math.floor(priceAt 对应的已消耗档位)`
     *   更直接的算法：priceAt 用的是 steps = floor(elapsed*32/halfLife)，stepsRemaining = 256 - steps
     */
    render(stepsRemaining) {
      const next = Math.max(0, Math.min(TOTAL_STEPS, Math.round(stepsRemaining)));
      if (next < lastStepsAlive) {
        const dropped = dropOrder.slice(next, lastStepsAlive);
        spawnParticles(dropped);
      }
      lastStepsAlive = next;
      drawFrame();
      ensureAnimating();
    },
    /**
     * 归零瞬间调用：热态的剩余像素全部炸开飞散，紧接着整只切换成完整的 halfie-free
     * （免费态是"重生"，不是"剩多少格"，所以 lastStepsAlive 要满格，不能继续用来遮罩）。
     */
    burstTo(stepsRemaining = 0) {
      const dropped = dropOrder.slice(stepsRemaining, lastStepsAlive);
      spawnParticles(dropped);
      isFree = stepsRemaining === 0;
      lastStepsAlive = isFree ? TOTAL_STEPS : stepsRemaining;
      drawFrame();
      ensureAnimating();
    },
    destroy() {
      if (raf) cancelAnimationFrame(raf);
    },
  };
}

/** sig 来自 toCurveSig()（见 api.js），nowSec 用 serverNow() */
export function stepsRemainingFor(sig, nowSec) {
  if (sig.forcedOpen) return 0;
  const t = Math.floor(nowSec);
  if (t <= sig.publishedAt) return TOTAL_STEPS;
  const steps = Math.floor(((t - sig.publishedAt) * 32) / sig.halfLife);
  return Math.max(0, TOTAL_STEPS - steps);
}
