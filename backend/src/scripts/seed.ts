/**
 * 在链上发布几条信号，并把正文写进 content.json。
 *
 *   npx tsx src/scripts/seed.ts
 *
 * 价格参数是刻意设计的：
 *   #1 突发消息  $10 起，半衰期 120s，8 个半衰期后免费（16 分钟）
 *   #2 快讯      $1  起，半衰期 45s（6 分钟）
 *   #3 深度研究  $50 起，半衰期 900s（2 小时）
 */
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { createPublicClient, createWalletClient, defineChain, http, keccak256, toBytes } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { config as dotenv } from "dotenv";
import { ALPHA_ABI, ROOT, getDeployments, getNetwork, usdc } from "../config.js";

dotenv();

const net = getNetwork();
const dep = getDeployments();

const chain = defineChain({
  id: net.chainId,
  name: net.key,
  nativeCurrency: { name: "MON", symbol: "MON", decimals: 18 },
  rpcUrls: { default: { http: [net.rpcUrl] } },
});

const pk = (process.env.PRIVATE_KEY || "") as `0x${string}`;
if (!pk) {
  console.error("缺少 PRIVATE_KEY");
  process.exit(1);
}
const account = privateKeyToAccount(pk);
const pub = createPublicClient({ chain, transport: http(net.rpcUrl) });
const wallet = createWalletClient({ account, chain, transport: http(net.rpcUrl) });

const SEEDS = [
  {
    title: "某港股上市公司将被要约收购",
    preview: "标的已停牌；要约方为产业资本，报价较停牌前溢价 30%+。全文含标的代码、报价区间与时间表。",
    body: [
      "标的：XX 控股（港股主板，市值约 HK$86 亿）",
      "要约方：某产业资本联合体，已完成尽调进入最后阶段",
      "报价：较停牌前收盘价溢价 32%（隐含 EV/EBITDA 11.4x）",
      "时间表：本周内递交正式要约文件，预计 3 周内复牌",
      "风险：仍需通过商务部反垄断审查；若价格谈崩，标的复牌后可能跌回停牌前",
      "—— 以上为演示数据，不构成投资建议。",
    ].join("\n"),
    basePrice: 10,
    halfLife: 120,
    floorPrice: 0.01,
  },
  {
    title: "某交易所将在 24 小时内上线新币",
    preview: "上币公告尚未发布，内部排期已确认。全文含币种、上线时间与开盘预期。",
    body: [
      "币种：XXX",
      "上线时间：明日 14:00 (UTC+8) 开放充值，16:00 开放交易",
      "开盘预期：场外报价已较 IDO 价溢价 4.2x",
      "做市：已确认两家做市商承接，初始流动性约 $200 万",
      "—— 以上为演示数据。",
    ].join("\n"),
    basePrice: 1,
    halfLife: 45,
    floorPrice: 0.005,
  },
  {
    title: "某百亿私募季度持仓变动拆解",
    preview: "13F 之外的高频持仓变化：本季度新建仓 7 只、清仓 4 只，风格从成长切向高股息。",
    body: [
      "新建仓：7 只，集中在电力、运营商、煤炭",
      "清仓：4 只，均为高估值成长股",
      "仓位：权益仓位从 62% 提升至 78%",
      "平均持股周期：从 3.1 个季度缩短到 1.8 个季度",
      "结论：这家管理人正在做一次明确的风格切换，而不是调仓",
      "—— 以上为演示数据。",
    ].join("\n"),
    basePrice: 50,
    halfLife: 900,
    floorPrice: 0.5,
  },
];

async function main() {
  console.log(`\n  AlphaClock 发布 / ${net.key} / ${dep.alphaClock}\n`);

  const existing = await pub.readContract({
    address: dep.alphaClock,
    abi: ALPHA_ABI,
    functionName: "signalCount",
  });
  console.log(`  合约已有 ${existing} 条信号`);

  const out = [];
  for (const s of SEEDS) {
    const contentHash = keccak256(toBytes(s.body));
    const hash = await wallet.writeContract({
      address: dep.alphaClock,
      abi: ALPHA_ABI,
      functionName: "publish",
      args: [
        s.title,
        s.preview,
        contentHash,
        usdc(s.basePrice),
        usdc(s.floorPrice),
        s.halfLife,
      ],
    });
    await pub.waitForTransactionReceipt({ hash });
    const count = await pub.readContract({
      address: dep.alphaClock,
      abi: ALPHA_ABI,
      functionName: "signalCount",
    });
    const id = Number(count);
    out.push({
      id,
      title: s.title,
      previewText: s.preview,
      body: s.body,
      contentHash,
      source: "demo",
      attestPublicSource: true,
    });
    console.log(`  ✔ #${id}  ${s.title}  $${s.basePrice} 起 / 半衰期 ${s.halfLife}s  tx=${hash.slice(0, 10)}`);
  }

  const p = resolve(ROOT, "content.json");
  writeFileSync(p, JSON.stringify(out, null, 2), "utf8");
  console.log(`\n  正文已写入 ${p}（${out.length} 条）\n`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
