/**
 * 外部插件工具限定命名（迁移第二阶段 E3）：与 MCP 同一套加固——字符白名单 +
 * 下划线折叠复用 tools/mcp/naming.ts 的 sanitizeMcpNamePart，64 字符封顶
 * FNV-1a 哈希后缀复用 capQualifiedToolName；前缀 ext__ 与 mcp__/内置名隔离。
 * 审批层据 ext__ 前缀识别动态第三方命名：默认禁「本会话免问」（与 mcp__ 同待遇，
 * 判定点见 api/ws/handler.ts / session-handler.ts 的 rememberable 判定）。
 */
import { capQualifiedToolName, sanitizeMcpNamePart } from "../mcp/naming.js";

/** 外部工具的统一命名前缀，防与内置/MCP 工具冲突，也供审批层识别（remember 判定） */
export const EXTERNAL_TOOL_PREFIX = "ext__";

/** 限定名段间分隔符（与 MCP 同名同义，mcp naming.ts 未导出故此处自留一份） */
const EXTERNAL_NAME_SEPARATOR = "__";

export function isExternalToolName(name: string): boolean {
  return name.startsWith(EXTERNAL_TOOL_PREFIX);
}

/** ext__<plugin>__<tool> 限定名：两段各自白名单净化，整体 64 字符封顶（超长加哈希后缀） */
export function qualifyExternalToolName(pluginName: string, toolName: string): string {
  return capQualifiedToolName(
    `${EXTERNAL_TOOL_PREFIX}${sanitizeMcpNamePart(pluginName)}${EXTERNAL_NAME_SEPARATOR}${sanitizeMcpNamePart(toolName)}`,
  );
}
