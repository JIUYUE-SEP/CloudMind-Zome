import { z } from "zod";

/** mcp-servers.json 中单个 server 的配置 */
export const McpServerConfigSchema = z.object({
  name: z.string().min(1),
  command: z.string().min(1),
  args: z.array(z.string()).optional(),
  env: z.record(z.string()).optional(),
});
export type McpServerConfig = z.infer<typeof McpServerConfigSchema>;

/** DATA_DIR/mcp-servers.json 的文件格式（文件不存在视为空配置） */
export const McpServersFileSchema = z.object({
  servers: z.array(McpServerConfigSchema),
});
