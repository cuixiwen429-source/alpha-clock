#!/usr/bin/env node
/**
 * Foundry 的统一入口。三件事：
 *
 *   1. 读 backend/.env —— forge script 里第一行就是 vm.envUint("PRIVATE_KEY")，
 *      而 `npm run deploy:local` 原本没人负责把 .env 塞进环境，新克隆的仓库
 *      跑一次就挂在 "environment variable PRIVATE_KEY not found"。
 *   2. 补 PATH —— Foundry 装在 ~/.foundry/bin 时，npm script 里的 `forge`
 *      在 GUI / IDE 终端里常常找不到。
 *   3. 固定工作目录到 contracts/，deployments.json 才写在 config.ts 读的位置。
 *
 *   node scripts/foundry.mjs test -vv
 *   node scripts/foundry.mjs script script/Deploy.s.sol:Deploy --rpc-url ... --broadcast
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { config as dotenv } from "dotenv";

const BACKEND = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const envPath = resolve(BACKEND, ".env");
if (existsSync(envPath)) dotenv({ path: envPath, quiet: true });

const localBin = resolve(homedir(), ".foundry/bin");
const PATH = existsSync(localBin) ? `${localBin}:${process.env.PATH ?? ""}` : (process.env.PATH ?? "");

const args = process.argv.slice(2);
if (args.length === 0) {
  console.error("用法: node scripts/foundry.mjs <forge 子命令> [...参数]");
  process.exit(2);
}

const child = spawn("forge", args, {
  cwd: resolve(BACKEND, "contracts"),
  stdio: "inherit",
  env: { ...process.env, PATH },
});

child.on("error", (error) => {
  console.error(`无法执行 forge：${error.message}`);
  console.error("安装 Foundry：curl -L https://foundry.paradigm.xyz | bash && foundryup");
  process.exit(127);
});
child.on("exit", (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
