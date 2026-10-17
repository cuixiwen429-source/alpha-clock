#!/usr/bin/env bash
# AlphaClock 本地全链路 Demo —— 一条命令从零到「5 个人用 5 个价格买走同一条消息」
#
#   bash scripts/demo-local.sh [买家数] [每人间隔秒数]
#   bash scripts/demo-local.sh 5 8            # 8 秒一档，跑得快一点
#
# 跑完会留下一条正在跑的 API（默认 4030），前端静态页用 ?api=http://127.0.0.1:4030 接。

set -uo pipefail

BACKEND="$(cd "$(dirname "$0")/.." && pwd)"
cd "$BACKEND"

BUYERS="${1:-5}"
GAP="${2:-12}"
PORT="${PORT:-4030}"
RPC="${MONAD_RPC_URL:-http://127.0.0.1:8545}"

# Foundry 默认装在 ~/.foundry/bin；不在 PATH 里时补上（forge 子命令走 scripts/foundry.mjs）
export PATH="${PATH}:$HOME/.foundry/bin"

say() { printf "\n\033[1;36m▸ %s\033[0m\n" "$*"; }
ok()  { printf "\033[1;32m  ✔ %s\033[0m\n" "$*"; }
die() { printf "\033[1;31m  ✘ %s\033[0m\n" "$*"; exit 1; }

rpc_alive() {
  curl -s -X POST "$RPC" -H 'content-type: application/json' \
    --data '{"jsonrpc":"2.0","id":1,"method":"eth_blockNumber","params":[]}' 2>/dev/null | grep -q result
}

command -v anvil >/dev/null || die "找不到 anvil，请先安装 Foundry：curl -L https://foundry.paradigm.xyz | bash"
command -v npx >/dev/null || die "找不到 npx，请先装 Node.js 22"

# ──────────────────────────── 0. 清场 ────────────────────────────
say "清理旧进程"
pkill -f "[a]nvil --block-time" 2>/dev/null || true
pkill -f "[a]lpha-api" 2>/dev/null || true
pkill -f "[s]hared/mock/server.mjs" 2>/dev/null || true
sleep 1
rm -f contracts/deployments.json content.json events.ndjson /tmp/alpha-anvil.log /tmp/alpha-api.log
# 免费领取记录和报价是跨链持久化的；不删会把上一条链的领取算到新信号的 #1 头上
rm -rf .runtime
ok "干净"

# ──────────────────────────── 1. anvil ────────────────────────────
say "启动 anvil（每 1 秒出块，模拟 Monad 的连续时间）"
anvil --block-time 1 --host 127.0.0.1 --port 8545 > /tmp/alpha-anvil.log 2>&1 &
for _ in $(seq 1 40); do rpc_alive && break; sleep 0.5; done
rpc_alive || { tail -20 /tmp/alpha-anvil.log; die "anvil 没起来"; }
ok "anvil 就绪"

# ──────────────────────────── 2. 部署 ────────────────────────────
say "部署 AlphaClock（deployments.json 会带上 deploymentBlock）"
node scripts/foundry.mjs script script/Deploy.s.sol:Deploy \
  --rpc-url "$RPC" --broadcast > /tmp/alpha-deploy.log 2>&1 || {
    tail -30 /tmp/alpha-deploy.log; die "部署失败"; }
[ -f contracts/deployments.json ] || die "没有 deployments.json"
ALPHA=$(node -p "require('./contracts/deployments.json').alphaClock")
USDC=$(node -p "require('./contracts/deployments.json').usdc")
ok "AlphaClock $ALPHA"
ok "USDC       $USDC"

# ──────────────────────────── 3. seed ────────────────────────────
say "在链上发布 3 条信号"
npx tsx src/scripts/seed.ts > /tmp/alpha-seed.log 2>&1 || { tail -20 /tmp/alpha-seed.log; die "seed 失败"; }
grep -E "✔ #" /tmp/alpha-seed.log | sed 's/^/  /'
ok "正文写进 content.json"

# ──────────────────────────── 4. 服务器 ────────────────────────────
say "启动 API 服务器"
X402_ENABLED=false HOST=127.0.0.1 PORT="$PORT" npx tsx src/server/alpha-api.ts > /tmp/alpha-api.log 2>&1 &
# 冷启动要现编译整张 tsx 依赖图，机器忙的时候实测能到 40s+，别用 30s 窗口
for _ in $(seq 1 180); do
  curl -s "http://127.0.0.1:$PORT/health" 2>/dev/null | grep -q '"ok"' && break
  sleep 0.5
done
curl -s "http://127.0.0.1:$PORT/health" 2>/dev/null | grep -q '"ok"' || { tail -20 /tmp/alpha-api.log; die "服务器没起来"; }

# /health 谁都会答「ok」。真正的判据是：答话的那个后端，合约地址必须是刚部署的这个。
# （同端口上如果跑着前端用的 mock，它也会答 ok，但合约地址是 0x…a1c0）
CONFIG=$(curl -s "http://127.0.0.1:$PORT/api/config")
echo "$CONFIG" | grep -q '"mock"' && die "端口 ${PORT} 上是 mock 后端，先停掉 npm run mock（它和真后端抢同一个端口）"
echo "$CONFIG" | grep -qi "$ALPHA" || { echo "$CONFIG"; die "端口 ${PORT} 上的后端不是刚部署的合约，可能被别的进程占了"; }
ok "API      http://127.0.0.1:${PORT}"
ok "大屏/购买页：静态服务加 ?api=http://127.0.0.1:${PORT}（如 live.html?id=1&api=…）"

# ──────────────────────────── 5. 买家登场 ────────────────────────────
say "开始抢购 —— 每 ${GAP} 秒一个人"
printf "\n  \033[2m%-8s %-10s %-8s %s\033[0m\n" "时刻" "成交价" "累计买家" "数据来自"
printf "  ────────────────────────────────────────────\n"

for i in $(seq 1 "$BUYERS"); do
  OUT=$(npx tsx src/scripts/buy.ts 1 "$i" 2>&1)
  PRICE=$(echo "$OUT" | sed -n 's/.*✔ 成交  \$\([0-9.]*\).*/\1/p' | head -1)
  [ -z "$PRICE" ] && PRICE="—"
  # 等索引器把 Bought 事件收进去再报数
  sleep 2
  STAT=$(curl -s "http://127.0.0.1:$PORT/api/signals/1")
  BUYERS_NOW=$(echo "$STAT" | node -p "JSON.parse(require('fs').readFileSync(0,'utf8')).buyers" 2>/dev/null || echo "?")
  printf "  %-8s %-10s %-11s %s\n" "+$(( (i-1)*GAP ))s" "\$$PRICE" "$BUYERS_NOW" "链上 Bought → 索引器"
  [ "$i" -lt "$BUYERS" ] && sleep "$GAP"
done

# ──────────────────────────── 6. 战报 ────────────────────────────
say "战报"
curl -s "http://127.0.0.1:$PORT/api/live/1" | node -e '
let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{
  const j=JSON.parse(s);
  console.log("");
  console.log("  标题      " + j.title);
  console.log("  现价      $" + j.price + "   （" + j.timeToFree + " 秒后免费）");
  console.log("  买家数    " + j.buyers + "   免费领取 " + j.claims);
  console.log("  总收入    $" + j.revenue);
  console.log("  价差      " + (j.spread === null ? "—" : j.spread + "x") + "（最高成交 / 最低成交）");
  console.log("  状态      " + j.status + "   区块 " + (j.blockNumber ?? "—"));
  console.log("");
});'

printf "  \033[1;33m服务器还在跑：\033[0m http://127.0.0.1:%s\n" "$PORT"
printf "  \033[2m停止：pkill -f alpha-api && pkill -f anvil\033[0m\n\n"
