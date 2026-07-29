import type { CallToolResult, Tool as McpTool } from "@modelcontextprotocol/sdk/types.js";
import type { Tool, ToolResult } from "../types.js";
import { mapAnnotationsToApproval, mcpInputSchemaToZod } from "./convert.js";

/** MCP 工具的统一命名前缀，防与内置工具冲突，也供审批层识别（禁 remember） */
export const MCP_TOOL_PREFIX = "mcp__";

/** server 名 sanitize：小写、非法字符折叠为下划线（toolName 按 MCP spec 本身已是安全字符集，原样保留） */
export function sanitizeMcpName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

export function mcpToolName(serverName: string, toolName: string): string {
  return `${MCP_TOOL_PREFIX}${sanitizeMcpName(serverName)}__${toolName}`;
}

export function isMcpToolName(name: string): boolean {
  return name.startsWith(MCP_TOOL_PREFIX);
}

/** 与 SDK Client 解耦的调用口，便于 InMemoryTransport 测试与未来传输层扩展 */
export interface McpToolCaller {
  callTool(name: string, args: Record<string, unknown>): Promise<CallToolResult>;
}

/** 提取 callTool 返回为 engine ToolResult.output：优先 structuredContent，其次拼接 text 块 */
function extractOutput(result: CallToolResult): unknown {
  if ("structuredContent" in result && result.structuredContent !== undefined) {
    return result.structuredContent;
  }
  const content = (result.content ?? []) as Array<{ type: string; text?: string }>;
  const texts = content.filter((c) => c.type === "text").map((c) => c.text ?? "");
  if (texts.length > 0) return texts.join("\n");
  return content;
}

/** 把一个 MCP tool 包装成 engine Tool 实例，execute 内转发 client.callTool */
export function mcpToolToEngine(serverName: string, tool: McpTool, caller: McpToolCaller): Tool {
  const name = mcpToolName(serverName, tool.name);
  const { requiresApproval } = mapAnnotationsToApproval(tool.annotations);
  return {
    name,
    description: tool.description ?? tool.annotations?.title ?? name,
    parameters: mcpInputSchemaToZod(tool.inputSchema),
    accesses: [
      {
        // annotations 不含资源维度，只能粗判；openWorldHint=false 视为封闭域（本地）
        resource: tool.annotations?.openWorldHint === false ? "file" : "network",
        action: requiresApproval ? "write" : "read",
      },
    ],
    requiresApproval,
    async execute(_ctx, args): Promise<ToolResult> {
      try {
        const result = await caller.callTool(tool.name, (args ?? {}) as Record<string, unknown>);
        if (result.isError) {
          const output = extractOutput(result);
          return { success: false, error: typeof output === "string" ? output : JSON.stringify(output) };
        }
        return { success: true, output: extractOutput(result) };
      } catch (err) {
        return { success: false, error: String(err) };
      }
    },
  };
}
