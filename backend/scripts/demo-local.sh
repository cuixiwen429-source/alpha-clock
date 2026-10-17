#!/usr/bin/env bash
# AlphaClock 本地全链路 Demo
#
#   bash scripts/demo-local.sh [买家数]
#
# 跑完会看到：一条信息的价格从 $10 一路掉到 $5，5 个买家分别在 5 个价格成交。

set -uo pipefail

cd "$(dirname "$0")/.."
export PATH="$HOME/.foundry/bin:/Users/a1-6/.workbuddy/binaries/node/versions/22.22.2-6/bin:$PATH"

BUYERS="${1:-5}"
RPC="http://127.0.0.1:8545"
ANVIL_KEY="0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"

# anvil 前 10 个地址
ANVIL_ADDRS=(
  0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266
  0x70997970C51812dc3A010C7d01b50e0d17dc79C8
  0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC
  0x90F79bf6EB2c4f870365E785982E1f101E93b906
  0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65
  0x9965507D1a55bcC2695C58ba16FB37d819B0A4dc
  0x976EA74026E726554dB657fA54763abd0C3a0aa9
  0x14dC79964da2C08b23698B3D3cc7Ca32193d9955
  0x23618e81E3f5cdF7f54C3d65f7FBc0aBf5B21E8f
  0xa0Ee7A142d267C1f36714E4a8F75612F20a79720
)

say() { printf "\n\033[1;36m▸ %s\033[0m\n" "$*"; }
ok()  { printf "\033[1;32m  ✔ %s\033[0m\n" "$*"; }
die() { printf "\033[1;31m  ✘ %s\033[0m\n" "$*"; exit 1; }

rpc_alive() { curl -s -X POST "$RPC" -H 'content-type: application/json' \
  --data '{"jsonrpc":"2.0","id":1,"method":"eth_blockNumber","params":[]}' 2>/dev/null | grep -q result; }

wait_for_file() { for _ in $(seq 1 60); do [ -f "$1" ] && return 0; sleep 0.5; done; return 1; }

# ──────────────────────────── 0. 清场 ────────────────────────────
say "清理旧进程"
pkill -f "[a]nvil --block-time" 2>/dev/null || true
pkill -f "[a]lpha-api" 2>/dev/null || true
pkill -f "[l]ocal-facilitator" 2>/dev/null || true
sleep 1
rm -f contracts/deployments.json content.json /tmp/asg-anvil.log /tmp/alpha-api.log
ok "干净"

# ──────────────────────────── 1. anvil ────────────────────────────
say "启动 anvil（每 1 秒出块，模拟 Monad 的连续时间）"
anvil --block-time 1 --host 127.0.0.1 --port 8545 > /tmp/asg-anvil.log 2>&1 &
for _ in $(seq 1 40); do rpc_alive && break; sleep 0.5; done
rpc_alive || die "anvil 没起来"
ok "anvil 就绪"

# ──────────────────────────── 2. 部署 ────────────────────────────
say "部署 AlphaClock"
cd contracts
PRIVATE_KEY="$ANVIL_KEY" forge script script/Deploy.s.sol \
  --rpc-url "$RPC" --broadcast > /tmp/alpha-deploy.log 2>&1 || {
    tail -30 /tmp/alpha-deploy.log; die "部署失败"; }
cd ..
[ -f contracts/deployments.json ] || die "没有 deployments.json"
ALPHA=$(node -e "console.log(require('./contracts/deployments.json').alphaClock)")
USDC=$(node -e "console.log(require('./contracts/deployments.json').usdc)")
ok "AlphaClock $ALPHA"
ok "USDC       $USDC"

# ──────────────────────────── 3. 给买家发 USDC ────────────────────────────
say "给 8 个买家各发 1000 USDC"
for i in 1 2 3 4 5 6 7 8; do
  ADDR="${ANVIL_ADDRS[$i]}"
  cast send "$USDC" "faucet(address,uint256)" "$ADDR" 1000000000 \
    --rpc-url "$RPC" --private-key "$ANVIL_KEY" > /dev/null 2>&1 || true
done
ok "发完了"

# ──────────────────────────── 4. seed ────────────────────────────
say "在链上发布 3 条信号"
PRIVATE_KEY="$ANVIL_KEY" NETWORK=local-anvil npx tsx src/scripts/seed.ts || die "seed 失败"
ok "3 条信号已上链"

# ──────────────────────────── 5. 服务器 ────────────────────────────
say "启动 API 服务器"
export PRIVATE_KEY="$ANVIL_KEY"
export NETWORK=local-anvil
export PORT=4030
export X402_ENABLED=false
export VERIFIER_PRIVATE_KEY="$ANVIL_KEY"
npx tsx src/server/alpha-api.ts > /tmp/alpha-api.log 2>&1 &
for _ in $(seq 1 60); do
  curl -s "http://127.0.0.1:$PORT/health" 2>/dev/null | grep -q '"ok"' && break
  sleep 0.5
done
curl -s "http://127.0.0.1:$PORT/health" | grep -q '"ok"' || { tail -20 /tmp/alpha-api.log; die "服务器没起来"; }
ok "API http://127.0.0.1:$PORT"
ok "投屏页面 http://127.0.0.1:$PORT/web/  ← 浏览器打开这个"

# ──────────────────────────── 6. 买家登场 ────────────────────────────
say "开始抢购 —— 每 12 秒一个人（价格每 12 秒掉一档）"
printf "\n"
printf "  \033[2m%-6s %-8s %-10s %-8s %s\033[0m\n" "时刻" "买家" "成交价" "已买" "占起始价比"
printf "  ────────────────────────────────────────────────\n"

for i in $(seq 1 "$BUYERS"); do
  OUT=$(NETWORK=local-anvil npx tsx src/scripts/buy.ts 1 "$i" 2>&1)
  PRICE=$(echo "$OUT" | grep -o '✔ 成交  \$[0-9.]*' | grep -o '\$[0-9.]*' | head -1)
  CNT=$(echo "$OUT" | grep -o '第 [0-9]* 个买家' | grep -o '[0-9]*' | head -1)
  [ -z "$PRICE" ] && PRICE="—"
  printf "  +%-5ss %-8s %-10s %-8s\n" "$(( (i-1)*12 ))" "#$i" "$PRICE" "${CNT:-?}"
  sleep 12
done

# ──────────────────────────── 7. 战报 ────────────────────────────
say "战报"
curl -s "http://127.0.0.1:$PORT/api/signal/1" | node -e '
let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{
  const j=JSON.parse(s);
  console.log(`\n  标题      ${j.title}`);
  console.log(`  起始价    $${j.basePrice}`);
  console.log(`  现在价    ${j.priceLabel}`);
  console.log(`  买家数    ${j.buyCount}`);
  console.log(`  总收入    $${j.revenue.toFixed(4)}`);
  console.log(`  距免费    ${Math.floor(j.timeToFree/60)} 分 ${j.timeToFree%60} 秒\n`);
});'

printf "  \033[1;33m服务器还在跑。打开 http://127.0.0.1:%s/web/ 投屏。\033[0m\n" "$PORT"
printf "  \033[2m停止：pkill -f alpha-api && pkill -f anvil\033[0m\n\n"
