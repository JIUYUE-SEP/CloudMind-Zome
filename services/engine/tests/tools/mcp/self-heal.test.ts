/**
 * 调用侧自愈单测（kimi retryAfterReconnect 等价语义，fake caller 无真实 server）：
 * ConnectionClosed→重连重试、歧义错误→探活分流、封顶一次、
 * 服务器已应答不重试、重连失败双重原因、关停期不重连。
 */
import { describe, it, expect } from "vitest";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import type { CallToolResult, Tool as McpTool } from "@modelcontextprotocol/sdk/types.js";
import { mcpToolToEngine, type McpToolCaller } from "../../../src/tools/mcp/wrapper.js";
import type { ToolContext } from "../../../src/tools/types.js";

const ctx: ToolContext = { agentId: "test-agent", workspaceDir: ".", approve: async () => true };

const fakeMcpTool: McpTool = { name: "t", inputSchema: { type: "object" } };

const OK_RESULT: CallToolResult = { content: [{ type: "text", text: "fine" }] };

interface FakeCaller extends McpToolCaller {
  callCount: number;
  pingCount: number;
}

/** 按脚本行事的 caller：callTool 依次取 script 项（Error=reject，其余=resolve），ping 行为可配 */
function makeCaller(
  script: Array<Error | CallToolResult>,
  pingBehavior: "alive" | "dead" = "alive",
): FakeCaller {
  const caller: FakeCaller = {
    callCount: 0,
    pingCount: 0,
    callTool: () => {
      const next = script[Math.min(caller.callCount++, script.length - 1)];
      return next instanceof Error ? Promise.reject(next) : Promise.resolve(next);
    },
    ping: () => {
      caller.pingCount++;
      return pingBehavior === "alive"
        ? Promise.resolve({})
        : Promise.reject(new McpError(ErrorCode.ConnectionClosed, "transport gone"));
    },
  };
  return caller;
}

function connectionClosed(): McpError {
  return new McpError(ErrorCode.ConnectionClosed, "connection closed");
}

describe("调用侧自愈（封顶一次）", () => {
  it("ConnectionClosed（传输已死）→ 直接重连，新 caller 重试成功", async () => {
    const dead = makeCaller([connectionClosed()]);
    const fresh = makeCaller([OK_RESULT]);
    let reconnects = 0;
    const tool = mcpToolToEngine("s", fakeMcpTool, dead, {
      hooks: {
        reconnect: () => {
          reconnects++;
          return Promise.resolve(fresh);
        },
      },
    });

    const result = await tool.execute(ctx, {});
    expect(result).toEqual({ success: true, output: "fine" });
    expect(reconnects).toBe(1);
    expect(dead.callCount).toBe(1);
    expect(dead.pingCount).toBe(0); // ConnectionClosed 不探活，直接进重连
    expect(fresh.callCount).toBe(1);
  });

  it("歧义错误 → 探活为活 → 原地重试一次成功，不重连", async () => {
    const flaky = makeCaller([new Error("socket hangup"), OK_RESULT], "alive");
    let reconnects = 0;
    const tool = mcpToolToEngine("s", fakeMcpTool, flaky, {
      hooks: {
        reconnect: () => {
          reconnects++;
          return Promise.resolve(undefined);
        },
      },
    });

    const result = await tool.execute(ctx, {});
    expect(result).toEqual({ success: true, output: "fine" });
    expect(flaky.pingCount).toBe(1);
    expect(flaky.callCount).toBe(2);
    expect(reconnects).toBe(0);
  });

  it("歧义错误 → 探活为死 → 重连后重试成功", async () => {
    const dead = makeCaller([new Error("socket hangup")], "dead");
    const fresh = makeCaller([OK_RESULT]);
    let reconnects = 0;
    const tool = mcpToolToEngine("s", fakeMcpTool, dead, {
      hooks: {
        reconnect: () => {
          reconnects++;
          return Promise.resolve(fresh);
        },
      },
    });

    const result = await tool.execute(ctx, {});
    expect(result).toEqual({ success: true, output: "fine" });
    expect(dead.pingCount).toBe(1);
    expect(reconnects).toBe(1);
  });

  it("重连封顶一次：重连后的重试再失败，不再二次重连", async () => {
    const dead = makeCaller([connectionClosed()]);
    const stillDead = makeCaller([connectionClosed()]);
    let reconnects = 0;
    const tool = mcpToolToEngine("s", fakeMcpTool, dead, {
      hooks: {
        reconnect: () => {
          reconnects++;
          return Promise.resolve(stillDead);
        },
      },
    });

    const result = await tool.execute(ctx, {});
    expect(result.success).toBe(false);
    expect(result.error).toContain("connection closed");
    expect(reconnects).toBe(1);
    expect(stillDead.callCount).toBe(1);
  });

  it("服务器已应答（McpError 业务错误）不探活不重连不重试", async () => {
    const answered = makeCaller([new McpError(ErrorCode.InternalError, "biz boom")]);
    let reconnects = 0;
    const tool = mcpToolToEngine("s", fakeMcpTool, answered, {
      hooks: {
        reconnect: () => {
          reconnects++;
          return Promise.resolve(makeCaller([OK_RESULT]));
        },
      },
    });

    const result = await tool.execute(ctx, {});
    expect(result.success).toBe(false);
    expect(result.error).toContain("biz boom");
    expect(answered.callCount).toBe(1);
    expect(answered.pingCount).toBe(0);
    expect(reconnects).toBe(0);
  });

  it("畸形结果（ZodError）不探活不重连不重试", async () => {
    const malformed = new Error("invalid result");
    malformed.name = "ZodError";
    const caller = makeCaller([malformed]);
    let reconnects = 0;
    const tool = mcpToolToEngine("s", fakeMcpTool, caller, {
      hooks: {
        reconnect: () => {
          reconnects++;
          return Promise.resolve(makeCaller([OK_RESULT]));
        },
      },
    });

    const result = await tool.execute(ctx, {});
    expect(result.success).toBe(false);
    expect(caller.callCount).toBe(1);
    expect(caller.pingCount).toBe(0);
    expect(reconnects).toBe(0);
  });

  it("重连也失败：错误消息含「原始失败 + 重连失败」双重原因", async () => {
    const dead = makeCaller([connectionClosed()]);
    const tool = mcpToolToEngine("s", fakeMcpTool, dead, {
      hooks: { reconnect: () => Promise.reject(new Error("spawn ENOENT")) },
    });

    const result = await tool.execute(ctx, {});
    expect(result.success).toBe(false);
    expect(result.error).toContain("connection closed");
    expect(result.error).toContain("spawn ENOENT");
    expect(result.error).toContain("重连 MCP server 也失败");
  });

  it("关停期不重连（reconnect 返回 undefined）：原始失败直接上浮", async () => {
    const dead = makeCaller([connectionClosed()]);
    let reconnects = 0;
    const tool = mcpToolToEngine("s", fakeMcpTool, dead, {
      hooks: {
        reconnect: () => {
          reconnects++;
          return Promise.resolve(undefined); // manager disposed / 重连被拒
        },
      },
    });

    const result = await tool.execute(ctx, {});
    expect(result.success).toBe(false);
    expect(result.error).toContain("connection closed");
    expect(reconnects).toBe(1);
  });
});
