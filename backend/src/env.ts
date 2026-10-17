/**
 * 载入 backend/.env。
 *
 * 必须在任何读取 process.env 的模块（config.ts 在 import 时就会算 NETWORKS、
 * FACILITATOR_URL）之前执行，所以只能做成一个「第一个 import 的副作用模块」，
 * 不能写成入口文件里晚于 import 的语句。
 *
 * dotenv 默认不覆盖已存在的环境变量，所以测试里用 PORT=4398 之类的临时值
 * 仍然优先于 .env。
 */
import { config as dotenv } from "dotenv";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

dotenv({ path: resolve(dirname(fileURLToPath(import.meta.url)), "../.env") });
