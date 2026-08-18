/**
 * F4 启动期重试测试 fixture：由环境变量驱动的「前 N 次启动必败」server。
 * - FLAKY_COUNTER_FILE：每次启动追加一行 `<次数>:<epoch-ms>`（退避间隔断言用）；
 * - FLAKY_FAIL_TIMES：前 N 次启动立即 exit(1)（模拟启动失败，connect 快速
 *   拒绝而非走 15s 超时），第 N+1 次起裁掉自身 argv 后 import echo-server
 *   （与 stdio e2e 同一 server 行为）。
 * 各次启动是顺序的独立进程（上一次失败落定才排下一次重试），计数文件无并发写。
 */
import fs from "node:fs";

const counterFile = process.env.FLAKY_COUNTER_FILE;
const failTimes = Number(process.env.FLAKY_FAIL_TIMES ?? "0");

let count = 0;
if (counterFile) {
  try {
    const last = fs.readFileSync(counterFile, "utf-8").trim().split("\n").at(-1);
    count = Number(last?.split(":")[0] ?? "0");
  } catch {
    /* 首次启动：计数文件尚不存在 */
  }
  fs.appendFileSync(counterFile, `${count + 1}:${Date.now()}\n`);
}

if (count < failTimes) process.exit(1);

// echo-server 按 argv[2] 写 pidfile——裁掉本 fixture 的参数，避免误写计数文件
process.argv = process.argv.slice(0, 2);
await import("./echo-server.js");
