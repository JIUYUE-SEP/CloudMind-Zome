/**
 * InMemoryTransport 集成测试：client-server 直连（不依赖子进程），
 * 验证工具发现、mcp__ 命名前缀、annotations→审批映射、callTool 转发。
 */
import { describe, it, expect, afterEach } from "vitest";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { mcpToolToEngine, wrapMcpTools, isMcpToolName } from "../../../src/tools/mcp/wrapper.js";
import type { McpToolCaller } from "../../../src/tools/mcp/wrapper.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { ToolContext } from "../../../src/tools/types.js";

const ctx: ToolContext = {
  agentId: "test-agent",
  workspaceDir: ".",
  approve: async () => true,
};

function clientCaller(client: Client): McpToolCaller {
  return {
    callTool: (name, args) => client.callTool({ name, arguments: args }) as Promise<CallToolResult>,
    ping: (timeoutMs) => client.ping({ timeout: timeoutMs }),
  };
}

async function setup() {
  const server = new McpServer({ name: "Test Server", version: "0.0.1" });
  server.registerTool(
    "ping",
    {
      description: "只读探活",
      inputSchema: { msg: z.string() },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    async ({ msg }) => ({ content: [{ type: "text", text: `pong:${msg}` }] }),
  );
  server.registerTool(
    "mutate",
    {
      description: "写操作（无 readOnlyHint）",
      inputSchema: { key: z.string() },
      annotations: { readOnlyHint: false, destructiveHint: true },
    },
    async ({ key }) => ({ content: [{ type: "text", text: `mutated:${key}` }] }),
  );
  server.registerTool(
    "fail",
    {
      description: "总是失败",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () => ({ content: [{ type: "text", text: "boom" }], isError: true }),
  );

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "test-client", version: "0.0.1" }, { capabilities: {} });
  await client.connect(clientTransport);
  return { server, client };
}

describe("mcpToolToEngine（InMemoryTransport 集成）", () => {
  let cleanup: (() => Promise<void>) | undefined;
  afterEach(async () => {
    await cleanup?.();
    cleanup = undefined;
  });

  it("工具发现 + 命名前缀 + sanitize server 名", async () => {
    const { server, client } = await setup();
    cleanup = async () => {
      await client.close();
      await server.close();
    };

    const { tools } = await client.listTools();
    const wrapped = tools.map((t) => mcpToolToEngine("Test Server", t, clientCaller(client)));

    // kimi tool-naming 语义：白名单字符 + 下划线折叠，保留大小写
    const names = wrapped.map((t) => t.name);
    expect(names).toContain("mcp__Test_Server__ping");
    expect(names).toContain("mcp__Test_Server__mutate");
    for (const n of names) expect(isMcpToolName(n)).toBe(true);
  });

  it("审批映射：readOnlyHint=true 免审批，其余需审批", async () => {
    const { server, client } = await setup();
    cleanup = async () => {
      await client.close();
      await server.close();
    };

    const { tools } = await client.listTools();
    const byName = new Map(
      tools.map((t) => [t.name, mcpToolToEngine("s", t, clientCaller(client))]),
    );
    expect(byName.get("ping")?.requiresApproval).toBe(false);
    expect(byName.get("mutate")?.requiresApproval).toBe(true);
    // fail 只有 readOnlyHint:true → 免审批
    expect(byName.get("fail")?.requiresApproval).toBe(false);
  });

  it("execute 转发 callTool 并返回真实结果；isError 映射为 success:false", async () => {
    const { server, client } = await setup();
    cleanup = async () => {
      await client.close();
      await server.close();
    };

    const { tools } = await client.listTools();
    const byName = new Map(tools.map((t) => [t.name, mcpToolToEngine("s", t, clientCaller(client))]));

    const ping = byName.get("ping")!;
    const ok = await ping.execute(ctx, { msg: "hi" });
    expect(ok).toEqual({ success: true, output: "pong:hi" });

    const fail = byName.get("fail")!;
    const bad = await fail.execute(ctx, {});
    expect(bad.success).toBe(false);
    expect(bad.error).toContain("boom");
  });

  it("包装后的 parameters 可执行 zod 校验（preflight 契约）", async () => {
    const { server, client } = await setup();
    cleanup = async () => {
      await client.close();
      await server.close();
    };

    const { tools } = await client.listTools();
    const ping = tools.find((t) => t.name === "ping")!;
    const wrapped = mcpToolToEngine("s", ping, clientCaller(client));
    expect(wrapped.parameters.safeParse({ msg: "x" }).success).toBe(true);
    expect(wrapped.parameters.safeParse({}).success).toBe(false);
  });
});

describe("wrapMcpTools 过滤（M20 task 化工具）", () => {
  const noopCaller: McpToolCaller = {
    callTool: () => Promise.resolve({ content: [] } as CallToolResult),
    ping: () => Promise.resolve({}),
  };
  const wrap = (tools: Parameters<typeof wrapMcpTools>[1]) =>
    wrapMcpTools("s", tools, noopCaller, () => ({}));

  it("taskSupport=required 的工具不注册（不对 LLM 可见），其余保留", () => {
    const wrapped = wrap([
      { name: "normal", inputSchema: { type: "object" } },
      { name: "tasky", inputSchema: { type: "object" }, execution: { taskSupport: "required" } },
      { name: "maybe", inputSchema: { type: "object" }, execution: { taskSupport: "optional" } },
      { name: "never", inputSchema: { type: "object" }, execution: { taskSupport: "forbidden" } },
    ]);

    const names = wrapped.map((t) => t.name);
    expect(names).toContain("mcp__s__normal");
    expect(names).toContain("mcp__s__maybe");
    expect(names).toContain("mcp__s__never");
    expect(names).not.toContain("mcp__s__tasky");
  });
});
