/**
 * M18 回归：
 * - listAllTools 游标分页双封顶（页数 / 总条数），防恶意 server 无限翻页耗尽内存；
 * - withTimeout 竞速结束后清理输家定时器（fake timers 验证无驻留泄漏）。
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { Tool as McpTool } from "@modelcontextprotocol/sdk/types.js";
import {
  listAllTools,
  withTimeout,
  MAX_TOOLS_LIST_PAGES,
  MAX_TOOLS_PER_SERVER,
} from "../../../src/tools/mcp/client-manager.js";

function fakeClient(
  handler: (params?: { cursor?: string }) => Promise<{ tools: McpTool[]; nextCursor?: string }>,
): { client: Client; listTools: ReturnType<typeof vi.fn> } {
  const listTools = vi.fn(handler);
  return { client: { listTools } as unknown as Client, listTools };
}

function mcpTool(name: string): McpTool {
  return { name, inputSchema: { type: "object" } };
}

describe("listAllTools 分页封顶（M18）", () => {
  it("正常分页聚齐全量，游标耗尽即停", async () => {
    const pages = [["a", "b"], ["c"]];
    let i = 0;
    const { client, listTools } = fakeClient(async () => {
      const tools = pages[i].map(mcpTool);
      i += 1;
      return { tools, nextCursor: i < pages.length ? `p${i}` : undefined };
    });

    const tools = await listAllTools(client);
    expect(tools.map((t) => t.name)).toEqual(["a", "b", "c"]);
    expect(listTools).toHaveBeenCalledTimes(2);
    // 第二页起必须携带游标
    expect(listTools.mock.calls[1]?.[0]).toEqual({ cursor: "p1" });
  });

  it("恶意 server 无限翻页：页数封顶截断", async () => {
    const { client, listTools } = fakeClient(async () => ({
      tools: [mcpTool("t")],
      nextCursor: "forever",
    }));

    const tools = await listAllTools(client);
    expect(listTools).toHaveBeenCalledTimes(MAX_TOOLS_LIST_PAGES);
    expect(tools.length).toBe(MAX_TOOLS_LIST_PAGES);
  });

  it("单页条数巨大：总条数封顶截断", async () => {
    const page = Array.from({ length: 600 }, (_, i) => mcpTool(`t${i}`));
    const { client, listTools } = fakeClient(async () => ({
      tools: page,
      nextCursor: "more",
    }));

    const tools = await listAllTools(client);
    // 第二页后累计 1200 条 ≥ MAX_TOOLS_PER_SERVER，不再翻第三页
    expect(listTools).toHaveBeenCalledTimes(2);
    expect(tools.length).toBe(1200);
    expect(tools.length).toBeGreaterThanOrEqual(MAX_TOOLS_PER_SERVER);
  });
});

describe("withTimeout 定时器清理（M18）", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("正常完成：返回值且定时器已清理", async () => {
    vi.useFakeTimers();
    const p = new Promise<string>((resolve) => setTimeout(() => resolve("ok"), 50));
    const wrapped = withTimeout(p, 1_000, "测试");

    await vi.advanceTimersByTimeAsync(50);
    await expect(wrapped).resolves.toBe("ok");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("超时：按 label 报错且定时器已清理", async () => {
    vi.useFakeTimers();
    const wrapped = withTimeout(new Promise(() => {}), 100, "[mcp] s 连接");
    const assertion = expect(wrapped).rejects.toThrow("[mcp] s 连接 超时（100ms）");

    await vi.advanceTimersByTimeAsync(100);
    await assertion;
    expect(vi.getTimerCount()).toBe(0);
  });
});
