import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { z } from "zod";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { listFilesTool } from "../../src/tools/builtin/list_files.js";
import type { ToolContext } from "../../src/tools/types.js";

type EntryType = "directory" | "symlink" | "file" | "other";

function makeCtx(workspaceDir: string, projectRoot?: string): ToolContext {
  return {
    agentId: "test-agent",
    workspaceDir,
    approve: async () => true,
    projectRoot,
  };
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
    const entries = (result.output as { entries: Array<{ name: string; type: EntryType }> }).entries;
    expect(entries).toEqual(
      expect.arrayContaining([
        { name: "README.md", type: "file" },
        { name: "src", type: "directory" },
      ]),
    );
    expect(entries.length).toBe(2);
  });

  it("returns an empty list for an empty directory", async () => {
    const emptyDir = path.join(projectRoot, "empty");
    fs.mkdirSync(emptyDir);
    const ctx = makeCtx(workspaceDir, projectRoot);
    const result = await listFilesTool.execute(ctx, { path: "empty" });
    expect(result.success).toBe(true);
    const entries = (result.output as { entries: Array<{ name: string; type: EntryType }> }).entries;
    expect(entries).toEqual([]);
  });

  it("identifies symbolic links as symlink", async () => {
    const linkPath = path.join(projectRoot, "readme-link");
    try {
      fs.symlinkSync(path.join(projectRoot, "README.md"), linkPath);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "EPERM") {
        // Creating symbolic links on Windows requires elevated privileges.
        return;
      }
      throw err;
    }

    const ctx = makeCtx(workspaceDir, projectRoot);
    const result = await listFilesTool.execute(ctx, { path: "." });
    expect(result.success).toBe(true);
    const entries = (result.output as { entries: Array<{ name: string; type: EntryType }> }).entries;
    expect(entries).toEqual(
      expect.arrayContaining([{ name: "readme-link", type: "symlink" }]),
    );
  });

  it("identifies non-regular file types as other on unix-like systems", async () => {
    if (process.platform === "win32") {
      // Windows does not support FIFO creation via mkfifo.
      return;
    }

    const fifoPath = path.join(projectRoot, "fifo");
    try {
      // Use a short synchronous shell command to create a named pipe.
      const { execSync } = await import("node:child_process");
      execSync(`mkfifo "${fifoPath}"`);
    } catch {
      return;
    }

    const ctx = makeCtx(workspaceDir, projectRoot);
    const result = await listFilesTool.execute(ctx, { path: "." });
    expect(result.success).toBe(true);
    const entries = (result.output as { entries: Array<{ name: string; type: EntryType }> }).entries;
    expect(entries).toEqual(expect.arrayContaining([{ name: "fifo", type: "other" }]));
  });

  it("returns an error for invalid parameters", async () => {
    const ctx = makeCtx(workspaceDir, projectRoot);
    const result = await listFilesTool.execute(ctx, { path: 123 });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/Expected string, received number/);
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

  it("falls back to workspaceDir when projectRoot is not configured", async () => {
    fs.writeFileSync(path.join(workspaceDir, "note.txt"), "hi");
    const ctx = makeCtx(workspaceDir);
    const result = await listFilesTool.execute(ctx, { path: "." });
    expect(result.success).toBe(true);
    const entries = (result.output as { entries: Array<{ name: string; type: EntryType }> }).entries;
    expect(entries).toEqual([{ name: "note.txt", type: "file" }]);
  });

  it("returns an error when the target path does not exist", async () => {
    const ctx = makeCtx(workspaceDir, projectRoot);
    const result = await listFilesTool.execute(ctx, { path: "missing" });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/(ENOENT|no such file)/i);
  });

  it("no longer exposes the recursive stub parameter (M17)", async () => {
    // recursive 桩已从 schema 摘除，不再对 LLM 公开
    const shape = (listFilesTool.parameters as z.ZodObject<Record<string, z.ZodTypeAny>>).shape;
    expect("recursive" in shape).toBe(false);

    // 旧调用方残留传 recursive 时按未知键剥离，行为等同普通单层列举
    const ctx = makeCtx(workspaceDir, projectRoot);
    const result = await listFilesTool.execute(ctx, { path: ".", recursive: true });
    expect(result.success).toBe(true);
    const entries = (result.output as { entries: Array<{ name: string; type: EntryType }> }).entries;
    expect(entries.length).toBe(2);
  });
});
