import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { editFileTool } from "../../src/tools/builtin/edit_file.js";
import type { ToolContext } from "../../src/tools/types.js";

function makeCtx(workspaceDir: string, projectRoot?: string): ToolContext {
  return {
    agentId: "test-agent",
    workspaceDir,
    requiresApproval: async () => true,
    ...(projectRoot ? { projectRoot } : {}),
  } as ToolContext;
}

describe("editFileTool", () => {
  let workspaceDir: string;
  let projectRoot: string;

  beforeEach(() => {
    workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), "engine-edit-"));
    projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "engine-project-edit-"));
  });

  afterEach(() => {
    fs.rmSync(workspaceDir, { recursive: true, force: true });
    fs.rmSync(projectRoot, { recursive: true, force: true });
  });

  it("replaces a unique oldString", async () => {
    const filePath = path.join(projectRoot, "sample.txt");
    fs.writeFileSync(filePath, "hello world");

    const ctx = makeCtx(workspaceDir, projectRoot);
    const result = await editFileTool.execute(ctx, {
      path: "sample.txt",
      oldString: "hello",
      newString: "hi",
    });

    expect(result.success).toBe(true);
    expect(fs.readFileSync(filePath, "utf-8")).toBe("hi world");
  });

  it("fails when oldString is not found", async () => {
    const filePath = path.join(projectRoot, "sample.txt");
    fs.writeFileSync(filePath, "hello world");

    const ctx = makeCtx(workspaceDir, projectRoot);
    const result = await editFileTool.execute(ctx, {
      path: "sample.txt",
      oldString: "missing",
      newString: "replacement",
    });

    expect(result.success).toBe(false);
    expect(result.error).toBe("oldString not found in sample.txt");
  });

  it("fails when oldString is not unique", async () => {
    const filePath = path.join(projectRoot, "sample.txt");
    fs.writeFileSync(filePath, "foo bar foo");

    const ctx = makeCtx(workspaceDir, projectRoot);
    const result = await editFileTool.execute(ctx, {
      path: "sample.txt",
      oldString: "foo",
      newString: "baz",
    });

    expect(result.success).toBe(false);
    expect(result.error).toBe("oldString is not unique in sample.txt (2 occurrences)");
  });

  it("rejects path traversal", async () => {
    const ctx = makeCtx(workspaceDir, projectRoot);
    const result = await editFileTool.execute(ctx, {
      path: "../escape.txt",
      oldString: "x",
      newString: "y",
    });

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/path traversal detected/);
  });

  it("fails when projectRoot is not configured", async () => {
    const ctx = makeCtx(workspaceDir);
    const result = await editFileTool.execute(ctx, {
      path: "sample.txt",
      oldString: "x",
      newString: "y",
    });

    expect(result.success).toBe(false);
    expect(result.error).toBe("No project root configured");
  });
});
