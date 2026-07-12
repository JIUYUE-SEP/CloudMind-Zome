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

  it("fails when oldString is empty", async () => {
    const filePath = path.join(projectRoot, "sample.txt");
    fs.writeFileSync(filePath, "hello world");

    const ctx = makeCtx(workspaceDir, projectRoot);
    const result = await editFileTool.execute(ctx, {
      path: "sample.txt",
      oldString: "",
      newString: "replacement",
    });

    expect(result.success).toBe(false);
    expect(result.error).toBe("oldString must not be empty");
    expect(fs.readFileSync(filePath, "utf-8")).toBe("hello world");
  });

  it("does not interpret $ in newString as a replacement pattern", async () => {
    const filePath = path.join(projectRoot, "sample.ts");
    fs.writeFileSync(filePath, "function count() { return 1; }");

    const ctx = makeCtx(workspaceDir, projectRoot);
    const result = await editFileTool.execute(ctx, {
      path: "sample.ts",
      oldString: "return 1;",
      newString: "return $$count;",
    });

    expect(result.success).toBe(true);
    expect(fs.readFileSync(filePath, "utf-8")).toBe(
      "function count() { return $$count; }",
    );
  });

  it("replaces only the first matching occurrence", async () => {
    const filePath = path.join(projectRoot, "sample.txt");
    fs.writeFileSync(filePath, "foo bar foo");

    const ctx = makeCtx(workspaceDir, projectRoot);
    const result = await editFileTool.execute(ctx, {
      path: "sample.txt",
      oldString: "foo bar",
      newString: "baz",
    });

    expect(result.success).toBe(true);
    expect(fs.readFileSync(filePath, "utf-8")).toBe("baz foo");
  });

  it("rejects absolute paths", async () => {
    const filePath = path.join(projectRoot, "sample.txt");
    fs.writeFileSync(filePath, "hello world");

    const ctx = makeCtx(workspaceDir, projectRoot);
    const result = await editFileTool.execute(ctx, {
      path: filePath,
      oldString: "hello",
      newString: "hi",
    });

    expect(result.success).toBe(false);
    expect(result.error).toBe("absolute paths are not allowed");
  });

  it("fails on invalid arguments", async () => {
    const ctx = makeCtx(workspaceDir, projectRoot);
    const result = await editFileTool.execute(ctx, {
      path: 123,
      oldString: "x",
      newString: "y",
    });

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/Expected string, received number/);
  });

  it("does not modify files outside project root via path traversal", async () => {
    const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), "engine-outside-"));
    const outsideFile = path.join(outsideDir, "secret.txt");
    fs.writeFileSync(outsideFile, "secret");

    const relativeToProject = path.relative(projectRoot, outsideFile);

    const ctx = makeCtx(workspaceDir, projectRoot);
    const result = await editFileTool.execute(ctx, {
      path: relativeToProject,
      oldString: "secret",
      newString: "hacked",
    });

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/path traversal detected|absolute paths are not allowed/);
    expect(fs.readFileSync(outsideFile, "utf-8")).toBe("secret");

    fs.rmSync(outsideDir, { recursive: true, force: true });
  });
});
