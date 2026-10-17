// CI 用：起 mock → 跑契约验收 → 关 mock。保证契约文件、mock、验收脚本三者始终一致。
import { spawn } from "node:child_process";

const port = 4399;
const mock = spawn(process.execPath, ["shared/mock/server.mjs"], { env: { ...process.env, PORT: String(port) }, stdio: "ignore" });
await new Promise((r) => setTimeout(r, 800));
const check = spawn(process.execPath, ["shared/check-contract.mjs", `http://127.0.0.1:${port}`], { stdio: "inherit" });
const code = await new Promise((r) => check.on("exit", r));
mock.kill();
process.exit(code);
