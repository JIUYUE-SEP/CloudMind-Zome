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
    expect(result.error).toContain("path is outside allowed workspace");
  });

  it("rejects traversal to protected agent.json", async () => {
    const result = await writeTool.execute(ctx, { path: "../agent.json", content: "x" });
    expect(result.success).toBe(false);
    expect(result.error).toContain("cannot write protected file");
  });

  it("rejects protected messages.jsonl", async () => {
    const result = await writeTool.execute(ctx, { path: "messages.jsonl", content: "x" });
    expect(result.success).toBe(false);
    expect(result.error).toContain("cannot write protected file");
  });

  it("rejects deep path traversal", async () => {
    const result = await writeTool.execute(ctx, { path: "../../etc/passwd", content: "x" });
    expect(result.success).toBe(false);
    expect(result.error).toContain("path is outside allowed workspace");
  });

  it("writes files inside the workspace files subdirectory", async () => {
    const result = await writeTool.execute(ctx, { path: "files/notes.md", content: "hello" });
    expect(result.success).toBe(true);
    expect(fs.readFileSync(path.join(workspaceDir, "files", "files", "notes.md"), "utf-8")).toBe("hello");
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

  it("rejects backslash bypass", async () => {
    const result = await bashTool.execute(ctx, { command: "..\\external.exe" });
    expect(result.success).toBe(false);
    expect(result.error).toContain("not allowed");
  });

  it("rejects &", async () => {
    const result = await bashTool.execute(ctx, { command: "echo a & echo b" });
    expect(result.success).toBe(false);
    expect(result.error).toContain("not allowed");
  });

  it("rejects newlines", async () => {
    const result = await bashTool.execute(ctx, { command: "echo a\necho b" });
    expect(result.success).toBe(false);
    expect(result.error).toContain("not allowed");
  });

  it("rejects commands outside allowlist", async () => {
    const result = await bashTool.execute(ctx, { command: "curl example.com" });
    expect(result.success).toBe(false);
    expect(result.error).toContain("not in allowlist");
  });

  it("allows relative executable paths starting with ./", async () => {
    const result = await bashTool.execute(ctx, { command: "./scripts/build.sh" });
    expect(result.error).not.toContain("Command rejected");
  });

  it("rejects relative script path traversal ./../evil.sh", async () => {
    const result = await bashTool.execute(ctx, { command: "./../evil.sh" });
    expect(result.success).toBe(false);
    expect(result.error).toContain("Command rejected");
  });

  it("rejects relative script path traversal ./scripts/../../../evil.sh", async () => {
    const result = await bashTool.execute(ctx, { command: "./scripts/../../../evil.sh" });
    expect(result.success).toBe(false);
    expect(result.error).toContain("Command rejected");
  });

  it("rejects relative script with backslash .\\evil.sh", async () => {
    const result = await bashTool.execute(ctx, { command: ".\\evil.sh" });
    expect(result.success).toBe(false);
    expect(result.error).toContain("Command rejected");
  });

  it("allows simple relative script ./valid.sh", async () => {
    const result = await bashTool.execute(ctx, { command: "./valid.sh" });
    expect(result.error).not.toContain("Command rejected");
  });

  it("allows relative script with safe arguments ./script.sh arg1", async () => {
    const result = await bashTool.execute(ctx, { command: "./script.sh arg1" });
    expect(result.error).not.toContain("Command rejected");
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

  it("rejects Windows environment variable expansion %PATH%", async () => {
    const result = await bashTool.execute(ctx, { command: "echo %PATH%" });
    expect(result.success).toBe(false);
    expect(result.error).toContain("not allowed");
  });

  it("rejects Windows environment variable expansion %OPENAI_API_KEY%", async () => {
    const result = await bashTool.execute(ctx, { command: "echo %OPENAI_API_KEY%" });
    expect(result.success).toBe(false);
    expect(result.error).toContain("not allowed");
  });
});
