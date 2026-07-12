import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { listFilesTool } from "../../src/tools/builtin/list_files.js";
import type { ToolContext } from "../../src/tools/types.js";

function makeCtx(workspaceDir: string, projectRoot?: string): ToolContext {
  return {
    agentId: "test-agent",
    workspaceDir,
    requiresApproval: async () => true,
    ...(projectRoot ? { projectRoot } : {}),
  } as ToolContext;
}

describe("listFilesTool", () => {
  let workspaceDir: string;
  let projectRoot: string;

  beforeEach(() => {
    workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), "engine-list-"));
    projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "engine-project-"));
    fs.writeFileSync(path.join(projectRoot, "README.md"), "# project");
    fs.mkdirSync(path.join(projectRoot, "src"));
  });

  afterEach(() => {
    fs.rmSync(workspaceDir, { recursive: true, force: true });
    fs.rmSync(projectRoot, { recursive: true, force: true });
  });

  it("lists files and directories at the project root", async () => {
    const ctx = makeCtx(workspaceDir, projectRoot);
    const result = await listFilesTool.execute(ctx, { path: "." });
    expect(result.success).toBe(true);
    const entries = (result.output as { entries: Array<{ name: string; type: "file" | "directory" }> }).entries;
    expect(entries).toEqual(
      expect.arrayContaining([
        { name: "README.md", type: "file" },
        { name: "src", type: "directory" },
      ]),
    );
    expect(entries.length).toBe(2);
  });

  it("rejects path traversal with ../", async () => {
    const ctx = makeCtx(workspaceDir, projectRoot);
    const result = await listFilesTool.execute(ctx, { path: "../escape" });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/path traversal detected/);
  });

  it("rejects absolute paths", async () => {
    const ctx = makeCtx(workspaceDir, projectRoot);
    const result = await listFilesTool.execute(ctx, { path: "/etc/passwd" });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/absolute paths are not allowed/);
  });

  it("returns an error when projectRoot is not configured", async () => {
    const ctx = makeCtx(workspaceDir);
    const result = await listFilesTool.execute(ctx, { path: "." });
    expect(result.success).toBe(false);
    expect(result.error).toBe("No project root configured");
  });

  it("returns an error when the target path does not exist", async () => {
    const ctx = makeCtx(workspaceDir, projectRoot);
    const result = await listFilesTool.execute(ctx, { path: "missing" });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/(ENOENT|no such file)/i);
  });

  it("returns not implemented for recursive listings", async () => {
    const ctx = makeCtx(workspaceDir, projectRoot);
    const result = await listFilesTool.execute(ctx, { path: ".", recursive: true });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/not implemented/i);
  });
});
