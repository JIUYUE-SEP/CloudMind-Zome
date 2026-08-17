/**
 * 真实 stdio e2e：McpClientManager spawn 本地测试 server → listTools → callTool 全链路。
 * command 用裸名 "node"：Windows 下会走 cmd.exe /c shim 路径（spike 坑 #1），
 * POSIX 下直接 spawn，两条路径都被覆盖。
 */
import { describe, it, expect, vi } from "vitest";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { McpClientManager } from "../../../src/tools/mcp/client-manager.js";
import { logger } from "../../../src/logger.js";
import type { ToolContext } from "../../../src/tools/types.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixture = path.join(__dirname, "fixtures", "echo-server.ts");

const ctx: ToolContext = {
  agentId: "test-agent",
  workspaceDir: ".",
  approve: async () => true,
};

describe("McpClientManager stdio e2e", () => {
  it("spawn → listTools → callTool 全链路，审批映射正确，close 干净退出", async () => {
    const manager = new McpClientManager([
      {
        name: "Fixture Server",
        command: "node",
        args: ["--import", "tsx", fixture],
      },
    ]);
    await manager.connectAll();

    const tools = manager.getTools();
    const byName = new Map(tools.map((t) => [t.name, t]));

    // 工具发现 + mcp__ 前缀 + server 名 sanitize（kimi tool-naming 语义，保留大小写）
    const echo = byName.get("mcp__Fixture_Server__echo");
    const touch = byName.get("mcp__Fixture_Server__touch");
    expect(echo).toBeDefined();
    expect(touch).toBeDefined();

    // 审批映射：只读免审批，写类需审批
    expect(echo!.requiresApproval).toBe(false);
    expect(touch!.requiresApproval).toBe(true);

    // 真实调用只读工具
    const ok = await echo!.execute(ctx, { message: "hello mcp" });
    expect(ok).toEqual({ success: true, output: "echo:hello mcp" });

    // 写工具也真实转发（调用本身不需要审批通道，审批在执行前的 approve 门）
    const ok2 = await touch!.execute(ctx, { path: "a.txt" });
    expect(ok2).toEqual({ success: true, output: "touched:a.txt" });

    await manager.close();
    // 断线保注册（H5）：close 置 unavailable 但工具快照不摘除，仍在注入列表；
    // 调用路径对无连接有明确错误（caller 拒绝「当前无可用连接」）
    const snapshot = manager.getTools();
    const deadEcho = snapshot.find((t) => t.name === "mcp__Fixture_Server__echo");
    expect(deadEcho).toBeDefined();
    const dead = await deadEcho!.execute(ctx, { message: "x" });
    expect(dead.success).toBe(false);
    expect(dead.error).toContain("当前无可用连接");
  }, 30_000);

  it("断线保注册：server 崩溃后工具快照不消失，调用触发自愈重连成功", async () => {
    const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "mcp-crash-"));
    try {
      const pidfile = path.join(tmpDir, "echo.pid");
      const manager = new McpClientManager([
        { name: "crashy", command: "node", args: ["--import", "tsx", fixture, pidfile] },
      ]);
      await manager.connectAll();
      expect(manager.getTools().map((t) => t.name)).toContain("mcp__crashy__echo");

      // 模拟崩溃：杀子进程，等 onclose 把 entry 置 unavailable
      const warn = vi.spyOn(logger, "warn");
      process.kill(Number(fs.readFileSync(pidfile, "utf-8")));
      await vi.waitFor(() => {
        expect(warn.mock.calls.some((c) => String(c.at(-1)).includes("连接已断开"))).toBe(true);
      });

      // H5：status 非 ok 不摘除——工具快照仍在注入列表（旧过滤行为下此处为空）
      const echo = manager.getTools().find((t) => t.name === "mcp__crashy__echo");
      expect(echo).toBeDefined();

      // 调用落回既有自愈：ConnectionClosed → 重连（重 spawn）→ 重试成功
      const ok = await echo!.execute(ctx, { message: "back" });
      expect(ok).toEqual({ success: true, output: "echo:back" });

      warn.mockRestore();
      await manager.close();
    } finally {
      await fsp.rm(tmpDir, { recursive: true, force: true });
    }
  }, 30_000);

  it("单个 server 连接失败按不可用降级，不影响其他 server", async () => {
    const manager = new McpClientManager([
      { name: "bad", command: "definitely-not-exists-cmz.exe", args: [] },
      { name: "good", command: "node", args: ["--import", "tsx", fixture] },
    ]);
    await manager.connectAll();

    const names = manager.getTools().map((t) => t.name);
    expect(names.some((n) => n.startsWith("mcp__bad__"))).toBe(false);
    expect(names).toContain("mcp__good__echo");

    await manager.close();
  }, 30_000);
});
