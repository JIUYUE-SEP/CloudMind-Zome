/**
 * write_file M16 回归：projectRoot 分支已删除——即便装配点注入 ctx.projectRoot，
 * 写路径也恒限制在 workspaceDir/files/ 下；PROTECTED_FILES 拦截不变。
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { writeTool } from "../../src/tools/builtin/write.js";
import type { ToolContext } from "../../src/tools/types.js";

function makeCtx(workspaceDir: string, projectRoot?: string): ToolContext {
  return { agentId: "test-agent", workspaceDir, projectRoot, approve: async () => true };
}

describe("writeTool", () => {
  let workspaceDir: string;
  let projectRoot: string;

  beforeEach(() => {
    workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), "engine-write-"));
    projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "engine-project-write-"));
  });

  afterEach(() => {
    fs.rmSync(workspaceDir, { recursive: true, force: true });
    fs.rmSync(projectRoot, { recursive: true, force: true });
  });

  it("confines writes to workspaceDir/files even when projectRoot is injected", async () => {
    const result = await writeTool.execute(makeCtx(workspaceDir, projectRoot), {
      path: "note.txt",
      content: "hi",
    });

    expect(result.success).toBe(true);
    expect(fs.readFileSync(path.join(workspaceDir, "files", "note.txt"), "utf-8")).toBe("hi");
    expect(fs.existsSync(path.join(projectRoot, "note.txt"))).toBe(false);
  });

  it("rejects protected files", async () => {
    const result = await writeTool.execute(makeCtx(workspaceDir), {
      path: "agent.json",
      content: "{}",
    });

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/cannot write protected file/);
  });
});
