/**
 * 真实 stdio e2e：McpClientManager spawn 本地测试 server → listTools → callTool 全链路。
 * command 用裸名 "node"：Windows 下会走 cmd.exe /c shim 路径（spike 坑 #1），
 * POSIX 下直接 spawn，两条路径都被覆盖。
 */
import { describe, it, expect } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { McpClientManager } from "../../../src/tools/mcp/client-manager.js";
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
    expect(manager.getTools()).toEqual([]);
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
