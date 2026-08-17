/**
 * bash 工具 M15 回归：
 * - 输出超 1MB 被杀属异常终止，必须 success:false（截断内容留 output），不得报成功；
 * - 超时按失败返回，且整进程组 SIGKILL（detached 进程组，孙进程一并收掉）。
 * 截断/超时用例依赖 POSIX cat/sh，Windows（cmd 无 cat）跳过。
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { bashTool } from "../../src/tools/builtin/bash.js";
import type { ToolContext } from "../../src/tools/types.js";

function makeCtx(workspaceDir: string): ToolContext {
  return { agentId: "test-agent", workspaceDir, approve: async () => true };
}

describe("bashTool", () => {
  let workspaceDir: string;

  beforeEach(() => {
    workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), "engine-bash-"));
  });

  afterEach(() => {
    fs.rmSync(workspaceDir, { recursive: true, force: true });
  });

  it("executes an allowed command successfully", async () => {
    const result = await bashTool.execute(makeCtx(workspaceDir), { command: "echo hello" });
    expect(result.success).toBe(true);
    expect(String(result.output)).toContain("hello");
  });

  it("rejects commands outside the allowlist", async () => {
    const result = await bashTool.execute(makeCtx(workspaceDir), { command: "rm x" });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/not in allowlist/);
  });

  it("reports failure when output exceeds 1MB and the process is killed", async () => {
    if (process.platform === "win32") return;
    // 2MB 文件触发边收边杀：结果必须 success:false，output 截断到上限内
    fs.writeFileSync(path.join(workspaceDir, "big.txt"), "x".repeat(2 * 1024 * 1024));

    const result = await bashTool.execute(makeCtx(workspaceDir), { command: "cat big.txt" });

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/exceeded 1048576 bytes/);
    expect(typeof result.output).toBe("string");
    expect((result.output as string).length).toBeLessThanOrEqual(1024 * 1024);
  }, 20_000);

  it("times out a hanging command with failure semantics", async () => {
    if (process.platform === "win32") return;
    // 裸 cat 阻塞读 stdin（spawn 管道无人写入），走到 30s 超时杀进程组路径
    const result = await bashTool.execute(makeCtx(workspaceDir), { command: "cat" });

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/timed out after 30000ms/);
  }, 40_000);
});
