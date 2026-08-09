import { execSync } from "node:child_process";

/**
 * 当前进程代码版本（git 短哈希，S1）：写入启动 banner 与 EADDRINUSE/收编提示，
 * 便于真机排障时判别新旧构建。运行时没有 git（打包分发）或命令失败时返回
 * undefined——调用方省略该字段，绝不让启动/报错路径崩溃。
 */
export function getGitShortHash(): string | undefined {
  try {
    const out = execSync("git rev-parse --short HEAD", {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return out.length > 0 ? out : undefined;
  } catch {
    return undefined;
  }
}
