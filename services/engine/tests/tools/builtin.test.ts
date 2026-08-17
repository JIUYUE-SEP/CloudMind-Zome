import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readTool } from "../../src/tools/builtin/read.js";
import { writeTool } from "../../src/tools/builtin/write.js";
import { bashTool } from "../../src/tools/builtin/bash.js";
import type { ToolContext } from "../../src/tools/types.js";

function makeCtx(workspaceDir: string, projectRoot?: string): ToolContext {
  return {
    agentId: "test-agent",
    workspaceDir,
    projectRoot,
    approve: async () => true,
  };
}

describe("readTool", () => {
  let workspaceDir: string;
  let projectRoot: string;

  beforeEach(() => {
    workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), "engine-read-"));
    projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "engine-project-"));
  });

  afterEach(() => {
    fs.rmSync(workspaceDir, { recursive: true, force: true });
    fs.rmSync(projectRoot, { recursive: true, force: true });
  });

  it("rejects absolute paths", async () => {
    const result = await readTool.execute(makeCtx(workspaceDir), { path: "/etc/passwd" });
    expect(result.success).toBe(false);
    expect(result.error).toContain("absolute paths are not allowed");
  });

  it("rejects path traversal", async () => {
    const result = await readTool.execute(makeCtx(workspaceDir), { path: "../outside.txt" });
    expect(result.success).toBe(false);
    expect(result.error).toContain("path traversal detected");
  });

  it("reads files inside the workspace", async () => {
    fs.writeFileSync(path.join(workspaceDir, "inside.txt"), "hello");
    const result = await readTool.execute(makeCtx(workspaceDir), { path: "inside.txt" });
    expect(result.success).toBe(true);
    expect(result.output).toBe("hello");
  });

  it("reads files inside the project root", async () => {
    fs.writeFileSync(path.join(projectRoot, "main.ts"), "export const x = 1;");
    const result = await readTool.execute(makeCtx(workspaceDir, projectRoot), { path: "main.ts" });
    expect(result.success).toBe(true);
    expect(result.output).toBe("export const x = 1;");
  });

  it("rejects path traversal from the project root", async () => {
    const result = await readTool.execute(makeCtx(workspaceDir, projectRoot), { path: "../outside.txt" });
    expect(result.success).toBe(false);
    expect(result.error).toContain("path traversal detected");
  });
});

describe("writeTool", () => {
  let workspaceDir: string;
  let projectRoot: string;

  beforeEach(() => {
    workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), "engine-write-"));
    projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "engine-project-"));
  });

  afterEach(() => {
    fs.rmSync(workspaceDir, { recursive: true, force: true });
    fs.rmSync(projectRoot, { recursive: true, force: true });
  });

  it("rejects absolute paths", async () => {
    const result = await writeTool.execute(makeCtx(workspaceDir), { path: "/tmp/evil.txt", content: "x" });
    expect(result.success).toBe(false);
    expect(result.error).toContain("absolute paths are not allowed");
  });

  it("rejects path traversal", async () => {
    const result = await writeTool.execute(makeCtx(workspaceDir), { path: "../outside.txt", content: "x" });
    expect(result.success).toBe(false);
    expect(result.error).toContain("path traversal detected");
  });

  it("rejects traversal to protected agent.json", async () => {
    const result = await writeTool.execute(makeCtx(workspaceDir), { path: "../agent.json", content: "x" });
    expect(result.success).toBe(false);
    expect(result.error).toContain("cannot write protected file");
  });

  it("rejects protected messages.jsonl", async () => {
    const result = await writeTool.execute(makeCtx(workspaceDir), { path: "messages.jsonl", content: "x" });
    expect(result.success).toBe(false);
    expect(result.error).toContain("cannot write protected file");
  });

  it("rejects deep path traversal", async () => {
    const result = await writeTool.execute(makeCtx(workspaceDir), { path: "../../etc/passwd", content: "x" });
    expect(result.success).toBe(false);
    expect(result.error).toContain("path traversal detected");
  });

  it("writes files inside the workspace files subdirectory", async () => {
    const result = await writeTool.execute(makeCtx(workspaceDir), { path: "files/notes.md", content: "hello" });
    expect(result.success).toBe(true);
    expect(fs.readFileSync(path.join(workspaceDir, "files", "files", "notes.md"), "utf-8")).toBe("hello");
  });

  it("ignores projectRoot and still writes under workspace files/ (M16)", async () => {
    // projectRoot 分支已删除：即便注入，写路径也恒走 workspaceDir/files/ 限制
    const result = await writeTool.execute(makeCtx(workspaceDir, projectRoot), { path: "src/main.ts", content: "export const x = 1;" });
    expect(result.success).toBe(true);
    expect(fs.readFileSync(path.join(workspaceDir, "files", "src", "main.ts"), "utf-8")).toBe("export const x = 1;");
    expect(fs.existsSync(path.join(projectRoot, "src", "main.ts"))).toBe(false);
  });

  it("rejects path traversal from the project root", async () => {
    const result = await writeTool.execute(makeCtx(workspaceDir, projectRoot), { path: "../outside.txt", content: "x" });
    expect(result.success).toBe(false);
    expect(result.error).toContain("path traversal detected");
  });

  it("rejects protected files inside the project root too", async () => {
    const result = await writeTool.execute(makeCtx(workspaceDir, projectRoot), { path: "config.json", content: "x" });
    expect(result.success).toBe(false);
    expect(result.error).toContain("cannot write protected file");
  });
});

describe("无 projectRoot（默认）fallback 路径安全（P2-1）", () => {
  let workspaceDir: string;
  let outsideDir: string;

  beforeEach(() => {
    workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), "engine-fallback-ws-"));
    outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), "engine-fallback-out-"));
  });

  afterEach(() => {
    fs.rmSync(workspaceDir, { recursive: true, force: true });
    fs.rmSync(outsideDir, { recursive: true, force: true });
  });

  it("read：fallback 下 junction 逃逸被拒绝", async () => {
    fs.writeFileSync(path.join(outsideDir, "secret.txt"), "boundary-outside");
    // junction（Windows 无需管理员）；POSIX 下 type 被忽略即普通 dir symlink
    fs.symlinkSync(outsideDir, path.join(workspaceDir, "evil"), "junction");

    const result = await readTool.execute(makeCtx(workspaceDir), { path: "evil/secret.txt" });
    expect(result.success).toBe(false);
    expect(result.error).toContain("path traversal detected");
  });

  it("write：fallback 下 junction 写穿被拒绝，边界外不产生文件", async () => {
    fs.mkdirSync(path.join(workspaceDir, "files"), { recursive: true });
    fs.symlinkSync(outsideDir, path.join(workspaceDir, "files", "evil"), "junction");

    const result = await writeTool.execute(makeCtx(workspaceDir), { path: "evil/x.txt", content: "x" });
    expect(result.success).toBe(false);
    expect(result.error).toContain("path traversal detected");
    expect(fs.existsSync(path.join(outsideDir, "x.txt"))).toBe(false);
  });

  it("read：workspace 内的 junction 指向 workspace 内目录仍可读（不误伤）", async () => {
    // 文件 symlink 在 Windows 需管理员/开发者模式，目录 junction 不需要
    fs.mkdirSync(path.join(workspaceDir, "real-dir"), { recursive: true });
    fs.writeFileSync(path.join(workspaceDir, "real-dir", "a.txt"), "inside");
    fs.symlinkSync(path.join(workspaceDir, "real-dir"), path.join(workspaceDir, "link-dir"), "junction");

    const result = await readTool.execute(makeCtx(workspaceDir), { path: "link-dir/a.txt" });
    expect(result.success).toBe(true);
    expect(result.output).toBe("inside");
  });

  it("write：files/ 下新建多级目录的新文件正常写入（realpathNearest 祖先回溯）", async () => {
    const result = await writeTool.execute(makeCtx(workspaceDir), { path: "sub/dir/new.txt", content: "hello" });
    expect(result.success).toBe(true);
    expect(fs.readFileSync(path.join(workspaceDir, "files", "sub", "dir", "new.txt"), "utf-8")).toBe("hello");
  });

  it("read：正常 files/ 读不受影响", async () => {
    fs.mkdirSync(path.join(workspaceDir, "files"), { recursive: true });
    fs.writeFileSync(path.join(workspaceDir, "files", "notes.md"), "notes");
    const result = await readTool.execute(makeCtx(workspaceDir), { path: "files/notes.md" });
    expect(result.success).toBe(true);
    expect(result.output).toBe("notes");
  });

  it("Windows 保留名被拒绝（CON/NUL/PRN，含扩展名与小写）", async () => {
    const isWin = process.platform === "win32";
    for (const name of ["CON", "nul.txt", "PRN", "com1", "LPT9.md"]) {
      const w = await writeTool.execute(makeCtx(workspaceDir), { path: name, content: "x" });
      const r = await readTool.execute(makeCtx(workspaceDir), { path: name });
      if (isWin) {
        expect(w.success).toBe(false);
        expect(w.error).toContain("reserved device name");
        expect(r.success).toBe(false);
        expect(r.error).toContain("reserved device name");
      } else {
        // POSIX 无设备保留名语义：按普通文件写入，可读回（fallback 写 root 为 files/）
        expect(w.success).toBe(true);
        const rr = await readTool.execute(makeCtx(workspaceDir), { path: `files/${name}` });
        expect(rr.success).toBe(true);
        expect(rr.output).toBe("x");
      }
    }
  });
});

describe("bashTool", () => {
  const ctx: ToolContext = {
    agentId: "test-agent",
    workspaceDir: os.tmpdir(),
    approve: async () => true,
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

  it("rejects relative executable paths starting with ./", async () => {
    // ./ 通道曾是逃逸口：write_file 写脚本 + bash ./ 执行即可绕过白名单
    const result = await bashTool.execute(ctx, { command: "./scripts/build.sh" });
    expect(result.success).toBe(false);
    expect(result.error).toContain("Command rejected");
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

  it("rejects simple relative script ./valid.sh", async () => {
    const result = await bashTool.execute(ctx, { command: "./valid.sh" });
    expect(result.success).toBe(false);
    expect(result.error).toContain("Command rejected");
  });

  it("rejects relative script with safe-looking arguments ./script.sh arg1", async () => {
    const result = await bashTool.execute(ctx, { command: "./script.sh arg1" });
    expect(result.success).toBe(false);
    expect(result.error).toContain("Command rejected");
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
