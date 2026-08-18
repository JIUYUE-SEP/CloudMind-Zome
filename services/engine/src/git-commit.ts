import { execSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * engine 源码目录：git 短哈希固定以该目录为 cwd 向上找仓库，不随进程启动目录漂移。
 * esbuild CJS bundle（prepare-engine.mjs）下 import.meta.url 为空、fileURLToPath
 * 抛 ERR_INVALID_ARG_TYPE——打包分发环境本就没有 git 仓库，兜底 process.cwd()
 * 让 git rev-parse 走正常失败路径返回 undefined（"无 git 不崩"语义不变）
 */
const ENGINE_SRC_DIR = (() => {
  try {
    return path.dirname(fileURLToPath(import.meta.url));
  } catch {
    return process.cwd();
  }
})();

/**
 * 当前进程代码版本（git 短哈希，S1）：写入启动 banner 与 EADDRINUSE/收编提示，
 * 便于真机排障时判别新旧构建。运行时没有 git（打包分发）或命令失败时返回
 * undefined——调用方省略该字段，绝不让启动/报错路径崩溃。
 */
export function getGitShortHash(): string | undefined {
  try {
    const out = execSync("git rev-parse --short HEAD", {
      // F4：固定源码目录 cwd；2s 超时防大仓库/网络盘挂起阻塞启动；windowsHide 防 GUI 启动闪控制台
      cwd: ENGINE_SRC_DIR,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 2000,
      windowsHide: true,
    }).trim();
    return out.length > 0 ? out : undefined;
  } catch {
    return undefined;
  }
}
