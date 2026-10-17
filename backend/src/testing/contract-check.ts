import { spawn } from "node:child_process";

const port = 4398;
const fixture = spawn(process.execPath, ["--import", "tsx", "src/testing/fixture-api.ts"], {
  cwd: process.cwd(),
  env: { ...process.env, PORT: String(port), X402_ENABLED: "false" },
  stdio: ["ignore", "pipe", "inherit"],
});

// 冷启动要现编译 tsx 依赖图，实测 macOS/CI 首跑需要 10–20s，5s 会误判超时。
const START_TIMEOUT_MS = Number(process.env.CONTRACT_START_TIMEOUT_MS ?? 30_000);

await new Promise<void>((resolve, reject) => {
  const timer = setTimeout(
    () => reject(new Error(`fixture backend 启动超时（${START_TIMEOUT_MS}ms）`)),
    START_TIMEOUT_MS,
  );
  fixture.stdout?.on("data", (chunk) => {
    if (String(chunk).includes("fixture backend ready")) {
      clearTimeout(timer);
      resolve();
    }
  });
  fixture.once("exit", (code) => reject(new Error(`fixture backend 提前退出: ${code}`)));
});

const check = spawn(process.execPath, ["../shared/check-contract.mjs", `http://127.0.0.1:${port}`], {
  cwd: process.cwd(),
  stdio: "inherit",
});
const code = await new Promise<number>((resolve) => check.once("exit", (value) => resolve(value ?? 1)));
fixture.kill("SIGTERM");
await new Promise((resolve) => fixture.once("exit", resolve));
process.exit(code);
