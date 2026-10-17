#!/usr/bin/env node
/**
 * Alpha Clock · UI 漂移检查器
 *
 * 用途：Opus（或任何人）改完前端后跑一遍，把"泛 AI 审美"和"绕过 token"两类漂移
 *       当场抓出来。规则不是审美偏好，每一条都对应一次实际踩过的坑。
 *
 * 用法：node shared/check-ui.mjs [目录，默认 frontend]
 * 退出码：0 = 通过（可能有 warning）；1 = 有 error
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, basename, extname } from "node:path";

const ROOT = process.argv[2] ?? new URL("../frontend/", import.meta.url).pathname;
const SKIP = new Set(["node_modules", ".git", "dist", "out"]);
const DESIGN_FILE = "tokens.css";
// 参照页 / 设计样张 / 历史遗留：允许内联 <style>、允许自持色板
// （它们本身就是"色板"的展示物，不该被"不许写 hex"的规则约束）
const EXEMPT_INLINE = new Set(["kit.html", "style-ref.html", "legacy-live.html"]);

const files = [];
(function walk(dir) {
  for (const name of readdirSync(dir)) {
    if (SKIP.has(name)) continue;
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(p);
    // 只查"长得出来的东西"：HTML 与 CSS。逻辑文件（js/mjs）不参与视觉规则
    else if ([".html", ".css"].includes(extname(p))) files.push(p);
  }
})(ROOT);

const findings = [];
const add = (sev, file, line, rule, detail, snippet) =>
  findings.push({ sev, file: relative(ROOT, file), line, rule, detail, snippet: (snippet ?? "").trim().slice(0, 80) });

/* ── 规则表 ───────────────────────────────────────────────── */
const RULES = [
  {
    id: "no-hex-outside-tokens",
    sev: "error",
    detail: "十六进制颜色只能出现在 tokens.css；其余文件必须用 var(--*)",
    // 只在"CSS 值的上下文"里查（冒号紧跟 # 或逗号紧跟 #），
    // 这样 <div>--bg #08090A</div> 这种色卡文字说明不会被误伤
    test: (line, file) => basename(file) !== DESIGN_FILE
      && !EXEMPT_INLINE.has(basename(file))
      && /[:,(]\s*#[0-9a-fA-F]{3,8}\b/.test(line)
      && !/\/\*|\*\/|^\s*\/\//.test(line),
  },
  {
    id: "no-generic-font",
    sev: "error",
    detail: "禁用 Inter / Roboto / Arial 作为字体族（Anthropic 文档点名的 AI slop 首位特征）",
    test: (line) => /font-family\s*:[^;]*\b(Inter|Roboto|Arial|Helvetica)\b/i.test(line),
  },
  {
    id: "no-heavy-weight",
    sev: "error",
    detail: "字重上限 600；700/800/900 会破坏细字重的终端气质",
    test: (line) => /font-weight\s*:\s*(700|800|900|bold)\b/i.test(line),
  },
  {
    id: "no-radius",
    sev: "error",
    detail: "圆角只允许 0 / 50%（状态点）/ var(--r-cta)（移动端主 CTA 10px）",
    test: (line) => {
      const m = line.match(/border-radius\s*:\s*([^;]+);/);
      if (!m) return false;
      const v = m[1].trim();
      if (/^(0|10px|50%|999px|var\(--r-(none|cta)\))$/.test(v)) return false;
      if (/^0\s+0\s+0\s+0$/.test(v)) return false;
      if (/^var\(--r-/.test(v)) return false;
      return true;
    },
  },
  {
    id: "no-slop-gradient",
    sev: "error",
    detail: "禁止紫/蓝渐变（#7c3aed #8b5cf6 #6366f1 #3b82f6 一类）与渐变文字",
    test: (line) => /(background(-image)?\s*:\s*linear-gradient|background-clip\s*:\s*text)/i.test(line)
      || /#(7c3aed|8b5cf6|a855f7|6366f1|3b82f6|4f46e5)\b/i.test(line),
  },
  {
    id: "no-emoji",
    sev: "error",
    detail: "禁止用 emoji 当图标或状态标记（现场投影会糊，且一眼 AI 味）",
    test: (line) => /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u.test(line),
  },
  {
    id: "temp-transition-too-slow",
    sev: "error",
    detail: "价格变色过渡必须 < 400ms，否则颜色追不上 400ms 一次的跳动（实测踩过）",
    test: (line) => {
      if (!/transition/.test(line) || !/color/i.test(line)) return false;
      const m = line.match(/([\d.]+)\s*(ms|s)\b/);
      if (!m) return false;
      const ms = m[2] === "s" ? parseFloat(m[1]) * 1000 : parseFloat(m[1]);
      return ms >= 400;
    },
  },
  {
    id: "price-needs-tabular",
    sev: "error",
    detail: ".price 规则块必须带 font-variant-numeric: tabular-nums，否则每秒跳动时宽度会抖",
    test: (line, file, src, idx) => {
      if (!/^\.price\s*\{/.test(line.trim())) return false;
      const block = src.slice(idx, idx + 800);
      const end = block.indexOf("}");
      return !/tabular-nums/.test(block.slice(0, end > 0 ? end : 400));
    },
  },
  {
    id: "inline-style-block",
    sev: "warn",
    detail: "页面内联 <style> 会让 token 失效、样式重复；除参照页外请写进 theme.css",
    test: (line, file) => /<style[\s>]/i.test(line) && !EXEMPT_INLINE.has(basename(file)),
  },
  {
    id: "hardcoded-font-size",
    sev: "warn",
    detail: "font-size 建议用 var(--t-*)；写死像素容易脱离字阶",
    // 只查 HTML 内联样式；theme.css 允许用固定像素表达"具体组件的具体尺寸"
    test: (line, file) => basename(file).endsWith(".html")
      && !EXEMPT_INLINE.has(basename(file))
      && /font-size\s*:\s*[1-9]\d*px/.test(line)
      && !/^\s*--/.test(line),
  },
];

/* ── 逐文件扫描 ───────────────────────────────────────────── */
for (const file of files) {
  const src = readFileSync(file, "utf8");
  const lines = src.split("\n");
  let offset = 0;
  lines.forEach((line, i) => {
    for (const rule of RULES) {
      if (rule.test(line, file, src, offset)) add(rule.sev, file, i + 1, rule.id, rule.detail, line);
    }
    offset += line.length + 1;
  });
}

/* ── 结构检查：页面必须引同一套样式 ───────────────────────── */
for (const file of files.filter((f) => f.endsWith(".html"))) {
  const src = readFileSync(file, "utf8");
  const isLegacy = basename(file).startsWith("legacy-");
  if (!/css\/(base|theme)\.css/.test(src) && !EXEMPT_INLINE.has(basename(file)) && !isLegacy) {
    add("error", file, 1, "missing-stylesheet", "页面没有引用 css/base.css（或 theme.css），视觉会完全失效", "");
  }
}

/* ── 输出 ─────────────────────────────────────────────────── */
const errs = findings.filter((f) => f.sev === "error");
const warns = findings.filter((f) => f.sev === "warn");

const C = { r: "\x1b[31m", y: "\x1b[33m", d: "\x1b[2m", b: "\x1b[1m", g: "\x1b[32m", x: "\x1b[0m" };

console.log(`\n${C.b}Alpha Clock · UI 漂移检查${C.x}  ${C.d}${files.length} 个文件${C.x}\n`);

if (!findings.length) {
  console.log(`${C.g}✔ 无漂移。${C.x}\n`);
} else {
  const byRule = new Map();
  for (const f of findings) {
    if (!byRule.has(f.rule)) byRule.set(f.rule, []);
    byRule.get(f.rule).push(f);
  }
  for (const [rule, list] of byRule) {
    const color = list[0].sev === "error" ? C.r : C.y;
    console.log(`${color}${list[0].sev === "error" ? "✕" : "!"} ${rule}${C.x}  ${C.d}(${list.length})${C.x}`);
    console.log(`${C.d}  ${list[0].detail}${C.x}`);
    for (const f of list.slice(0, 6)) {
      console.log(`  ${C.d}${f.file}:${f.line}${C.x}  ${f.snippet}`);
    }
    if (list.length > 6) console.log(`  ${C.d}… 另有 ${list.length - 6} 处${C.x}`);
    console.log();
  }
}

console.log(
  `${errs.length ? C.r : C.g}${errs.length} error${C.x} · ` +
  `${warns.length ? C.y : C.g}${warns.length} warning${C.x}\n`
);

process.exit(errs.length ? 1 : 0);
