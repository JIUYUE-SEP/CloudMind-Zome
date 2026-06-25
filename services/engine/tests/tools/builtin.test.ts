import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readTool } from "../../src/tools/builtin/read.js";
import { writeTool } from "../../src/tools/builtin/write.js";
import { bashTool } from "../../src/tools/builtin/bash.js";
import type { ToolContext } from "../../src/tools/types.js";

function makeCtx(workspaceDir: string): ToolContext {
  return {
    agentId: "test-agent",
    workspaceDir,
    requiresApproval: async () => true,
  };
}

describe("readTool", () => {
  let workspaceDir: string;
  let ctx: ToolContext;

  beforeEach(() => {
    workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), "engine-read-"));
    ctx = makeCtx(workspaceDir);
  });

  afterEach(() => {
    fs.rmSync(workspaceDir, { recursive: true, force: true });
  });

  it("rejects absolute paths", async () => {
    const result = await readTool.execute(ctx, { path: "/etc/passwd" });
    expect(result.success).toBe(false);
    expect(result.error).toContain("absolute paths are not allowed");
  });

  it("rejects path traversal", async () => {
    const result = await readTool.execute(ctx, { path: "../outside.txt" });
    expect(result.success).toBe(false);
    expect(result.error).toContain("path traversal detected");
  });

  it("reads files inside the workspace", async () => {
    fs.writeFileSync(path.join(workspaceDir, "inside.txt"), "hello");
    const result = await readTool.execute(ctx, { path: "inside.txt" });
    expect(result.success).toBe(true);
    expect(result.output).toBe("hello");
  });
});

describe("writeTool", () => {
  let workspaceDir: string;
  let ctx: ToolContext;

  beforeEach(() => {
    workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), "engine-write-"));
    ctx = makeCtx(workspaceDir);
  });

  afterEach(() => {
    fs.rmSync(workspaceDir, { recursive: true, force: true });
  });

  it("rejects absolute paths", async () => {
    const result = await writeTool.execute(ctx, { path: "/tmp/evil.txt", content: "x" });
    expect(result.success).toBe(false);
    expect(result.error).toContain("absolute paths are not allowed");
  });

  it("rejects path traversal", async () => {
    const result = await writeTool.execute(ctx, { path: "../outside.txt", content: "x" });
    expect(result.success).toBe(false);
    expect(result.error).toContain("path traversal detected");
  });

  it("writes files inside the workspace", async () => {
    const result = await writeTool.execute(ctx, { path: "inside.txt", content: "hello" });
    expect(result.success).toBe(true);
    expect(fs.readFileSync(path.join(workspaceDir, "inside.txt"), "utf-8")).toBe("hello");
  });
});

describe("bashTool", () => {
  const ctx: ToolContext = {
    agentId: "test-agent",
    workspaceDir: os.tmpdir(),
    requiresApproval: async () => true,
  };

  it("rejects complex shell constructs", async () => {
    const result = await bashTool.execute(ctx, { command: "echo a; echo b" });
    expect(result.success).toBe(false);
    expect(result.error).toContain("not allowed");
  });

  it("rejects absolute paths", async () => {
    const absoluteCommand = path.join(os.tmpdir(), "evil.exe");
    const result = await bashTool.execute(ctx, { command: absoluteCommand });
    expect(result.success).toBe(false);
    expect(result.error).toContain("not allowed");
  });

  it("rejects commands containing /", async () => {
    const result = await bashTool.execute(ctx, { command: "cat /etc/passwd" });
    expect(result.success).toBe(false);
    expect(result.error).toContain("not allowed");
  });

  it("allows simple commands", async () => {
    const result = await bashTool.execute(ctx, { command: "echo hello" });
    expect(result.success).toBe(true);
    expect((result.output as string).trim()).toBe("hello");
  });
});
