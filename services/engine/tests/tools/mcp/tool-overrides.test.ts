/**
 * toolOverrides 审批覆盖 / allowRemember / callTimeoutMs 测试：
 * - 优先级三态：override 免审批（false，本地显式信任）、override 强制审批（true）、
 *   无 override 回落 annotations 映射（fail-closed）
 * - isRememberAllowed：allowRemember:true 放行，默认/显式 false 禁止
 * - callTimeoutMs：透传进 caller；超时以失败返回且不触发自愈重试
 * - 关停期：manager close() 后 reconnect 一律 false（不再发起重连）
 */
import { describe, it, expect } from "vitest";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { CallToolResult, Tool as McpTool } from "@modelcontextprotocol/sdk/types.js";
import { McpClientManager } from "../../../src/tools/mcp/client-manager.js";
import {
  DEFAULT_MCP_CALL_TIMEOUT_MS,
  mcpToolToEngine,
  type McpToolCaller,
} from "../../../src/tools/mcp/wrapper.js";
import type { ToolContext } from "../../../src/tools/types.js";

const ctx: ToolContext = { agentId: "test-agent", workspaceDir: ".", approve: async () => true };

const OK_RESULT: CallToolResult = { content: [{ type: "text", text: "ok" }] };
const noopCaller: McpToolCaller = {
  callTool: () => Promise.resolve(OK_RESULT),
  ping: () => Promise.resolve({}),
};

function mcpTool(annotations?: McpTool["annotations"]): McpTool {
  return { name: "t", inputSchema: { type: "object" }, annotations };
}

describe("toolOverrides 优先级三态", () => {
  it("override requiresApproval:false 覆盖 annotations 需审批（本地显式信任）", () => {
    const tool = mcpToolToEngine("s", mcpTool({ readOnlyHint: false, destructiveHint: true }), noopCaller, {
      override: { requiresApproval: false },
    });
    expect(tool.requiresApproval).toBe(false);
    expect(tool.accesses[0]?.action).toBe("read");
  });

  it("override requiresApproval:true 覆盖 readOnlyHint（强制更严）", () => {
    const tool = mcpToolToEngine("s", mcpTool({ readOnlyHint: true }), noopCaller, {
      override: { requiresApproval: true },
    });
    expect(tool.requiresApproval).toBe(true);
    expect(tool.accesses[0]?.action).toBe("write");
  });

  it("无 override：回落 annotations 映射（与包 1 完全一致）", () => {
    expect(mcpToolToEngine("s", mcpTool({ readOnlyHint: true }), noopCaller).requiresApproval).toBe(false);
    expect(mcpToolToEngine("s", mcpTool({ readOnlyHint: false }), noopCaller).requiresApproval).toBe(true);
    expect(mcpToolToEngine("s", mcpTool(undefined), noopCaller).requiresApproval).toBe(true);
  });
});

describe("McpClientManager.isRememberAllowed", () => {
  it("allowRemember:true 放行；无 override / 显式 false 一律禁止", () => {
    const manager = new McpClientManager([
      {
        name: "demo",
        command: "node",
        toolOverrides: {
          "mcp__demo__safe": { allowRemember: true },
          "mcp__demo__explicit_deny": { allowRemember: false },
        },
      },
    ]);
    expect(manager.isRememberAllowed("mcp__demo__safe")).toBe(true);
    expect(manager.isRememberAllowed("mcp__demo__explicit_deny")).toBe(false);
    expect(manager.isRememberAllowed("mcp__demo__other")).toBe(false);
  });
});

describe("McpClientManager 关停期不重连", () => {
  it("close() 后 reconnect 一律 false", async () => {
    const manager = new McpClientManager([{ name: "demo", command: "node" }]);
    await manager.close();
    expect(await manager.reconnect("demo")).toBe(false);
  });

  it("未知 server reconnect 返回 false", async () => {
    const manager = new McpClientManager([]);
    expect(await manager.reconnect("ghost")).toBe(false);
  });
});

describe("McpClientManager server 名去重", () => {
  it("sanitize 后同形的 server 跳过后一个，前者的 override 不被后者误放", () => {
    // "a b" 与 "a_b" sanitize 后同为 a_b：若不去重，后者（带 allowRemember）的
    // override 会按限定名误放前者工具（review 建议修复点）
    const manager = new McpClientManager([
      { name: "a b", command: "node" },
      {
        name: "a_b",
        command: "node",
        toolOverrides: { "mcp__a_b__x": { allowRemember: true } },
      },
    ]);
    expect(manager.isRememberAllowed("mcp__a_b__x")).toBe(false);
  });
});

describe("callTimeoutMs", () => {
  it("透传进 caller（默认 60s，可配）", async () => {
    const seen: Array<number | undefined> = [];
    const recording: McpToolCaller = {
      callTool: (_name, _args, opts) => {
        seen.push(opts?.timeoutMs);
        return Promise.resolve(OK_RESULT);
      },
      ping: () => Promise.resolve({}),
    };
    await mcpToolToEngine("s", mcpTool(), recording, { callTimeoutMs: 1234 }).execute(ctx, {});
    await mcpToolToEngine("s", mcpTool(), recording).execute(ctx, {});
    expect(seen).toEqual([1234, DEFAULT_MCP_CALL_TIMEOUT_MS]);
  });

  it("超时以失败返回（RequestTimeout 属服务器已应答，不触发自愈重试）", async () => {
    // InMemory server 挂起工具：永不应答，等 client 侧 RequestOptions.timeout 兜底
    const server = new McpServer({ name: "hang", version: "0.0.1" });
    server.registerTool("hang", { inputSchema: { msg: z.string().optional() } }, () => {
      return new Promise(() => {});
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new Client({ name: "test-client", version: "0.0.1" }, { capabilities: {} });
    await client.connect(clientTransport);

    let pings = 0;
    let reconnects = 0;
    const caller: McpToolCaller = {
      callTool: (name, args, opts) =>
        client.callTool({ name, arguments: args }, undefined, { timeout: opts?.timeoutMs }) as Promise<CallToolResult>,
      ping: () => {
        pings++;
        return Promise.resolve({});
      },
    };
    const { tools: listed } = await client.listTools();
    const hang = listed.find((t) => t.name === "hang")!;
    const tool = mcpToolToEngine("hang", hang, caller, {
      callTimeoutMs: 100,
      hooks: {
        reconnect: () => {
          reconnects++;
          return Promise.resolve(undefined);
        },
      },
    });

    const result = await tool.execute(ctx, {});
    expect(result.success).toBe(false);
    expect(result.error).toBeTruthy();
    // 调用超时是 McpError(RequestTimeout)：服务器已应答路径，不探活不重连
    expect(pings).toBe(0);
    expect(reconnects).toBe(0);

    await client.close();
    await server.close();
  }, 15_000);
});
