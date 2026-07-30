import { z } from "zod";

/** 单个工具的本地覆盖（key 为限定名 mcp__<server>__<tool>），优先级高于 annotations 映射 */
export const McpToolOverrideSchema = z.object({
  /** false 是本地显式信任（免审批），true 强制更严 */
  requiresApproval: z.boolean().optional(),
  /** true 才放行「本会话免问」（默认禁） */
  allowRemember: z.boolean().optional(),
});
export type McpToolOverride = z.infer<typeof McpToolOverrideSchema>;

/** mcp-servers.json 中单个 server 的配置 */
export const McpServerConfigSchema = z.object({
  name: z.string().min(1),
  command: z.string().min(1),
  args: z.array(z.string()).optional(),
  env: z.record(z.string()).optional(),
  /** 单次 callTool 超时（默认 60s），包进 SDK RequestOptions.timeout */
  callTimeoutMs: z.number().int().positive().optional(),
  toolOverrides: z.record(McpToolOverrideSchema).optional(),
});
export type McpServerConfig = z.infer<typeof McpServerConfigSchema>;

/** DATA_DIR/mcp-servers.json 的文件格式（文件不存在视为空配置） */
export const McpServersFileSchema = z.object({
  servers: z.array(McpServerConfigSchema),
});
