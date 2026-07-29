/**
 * 本地兜底 MCP server：一个只读工具 + 一个写工具，均带完整 ToolAnnotations，
 * 用于在无网络/官方包不可用时跑通链路，并给 schema 转换 demo 提供带注解的工具源。
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import fs from "node:fs/promises";
import path from "node:path";

const server = new McpServer({ name: "cmz-spike-local-server", version: "0.1.0" });

server.registerTool(
  "read_file",
  {
    title: "Read File",
    description: "读取 spike 目录内的一个文本文件（只读）",
    inputSchema: { path: z.string().describe("相对 spike 根的文件路径") },
    annotations: {
      title: "Read File",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  async ({ path: p }) => {
    try {
      const full = path.resolve(process.cwd(), p);
      if (!full.startsWith(process.cwd())) {
        return {
          content: [{ type: "text", text: "路径越界，拒绝读取" }],
          isError: true,
        };
      }
      const text = await fs.readFile(full, "utf-8");
      return { content: [{ type: "text", text: text.slice(0, 2000) }] };
    } catch (err) {
      return { content: [{ type: "text", text: `读取失败: ${String(err)}` }], isError: true };
    }
  },
);

server.registerTool(
  "delete_file",
  {
    title: "Delete File",
    description: "删除 spike 目录内的一个文件（破坏性，仅演示 annotations）",
    inputSchema: { path: z.string().describe("相对 spike 根的文件路径") },
    annotations: {
      title: "Delete File",
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: false,
    },
  },
  async ({ path: p }) => ({
    // 演示用，不真实删除
    content: [{ type: "text", text: `[dry-run] would delete ${p}` }],
  }),
);

await server.connect(new StdioServerTransport());
