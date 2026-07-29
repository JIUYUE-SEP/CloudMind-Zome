/** stdio e2e 用的本地测试 server：一个只读工具 + 一个写工具，均带 annotations */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const server = new McpServer({ name: "fixture", version: "0.0.1" });

server.registerTool(
  "echo",
  {
    description: "回显输入（只读）",
    inputSchema: { message: z.string() },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  },
  async ({ message }) => ({ content: [{ type: "text", text: `echo:${message}` }] }),
);

server.registerTool(
  "touch",
  {
    description: "写操作（演示审批映射，不真实落盘）",
    inputSchema: { path: z.string() },
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
  },
  async ({ path: p }) => ({ content: [{ type: "text", text: `touched:${p}` }] }),
);

await server.connect(new StdioServerTransport());
