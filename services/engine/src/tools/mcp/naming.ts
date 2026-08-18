/**
 * MCP 工具限定命名（直搬 kimi-code `agent/mcp/tool-naming.ts`，27 行零依赖）：
 * 字符白名单 + 下划线折叠，限定名 64 字符封顶、超长加 FNV-1a 哈希后缀（确定性）。
 * 与包 1 的旧 sanitize（小写化、去首尾下划线）语义不同，以本文件为准。
 * 64 封顶逻辑拆为 capQualifiedToolName 导出：外部插件工具（ext__ 前缀）命名
 * 同用一套加固（E3，见 tools/external/naming.ts）。
 */
const MCP_NAME_PREFIX = "mcp__";
const MCP_NAME_SEPARATOR = "__";
const MAX_QUALIFIED_LENGTH = 64;

export function sanitizeMcpNamePart(part: string): string {
  return part.replaceAll(/[^a-zA-Z0-9_-]/g, "_").replaceAll(/_+/g, "_");
}

export function qualifyMcpToolName(serverName: string, toolName: string): string {
  return capQualifiedToolName(
    `${MCP_NAME_PREFIX}${sanitizeMcpNamePart(serverName)}${MCP_NAME_SEPARATOR}${sanitizeMcpNamePart(toolName)}`,
  );
}

/** 限定名 64 字符封顶：超长截头 + FNV-1a 哈希后缀（确定性；ext__ 命名复用） */
export function capQualifiedToolName(full: string): string {
  if (full.length <= MAX_QUALIFIED_LENGTH) return full;

  const hash = stableHash8(full);
  const head = full.slice(0, MAX_QUALIFIED_LENGTH - hash.length - 1);
  return `${head}_${hash}`;
}

function stableHash8(input: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.codePointAt(i)!;
    hash = Math.trunc(Math.imul(hash, 0x01000193));
  }
  // >>> 0 转无符号：kimi 原实现对负 hash 会产出带 "-" 的 9 位后缀、突破 64 封顶；
  // 转无符号后恒为 8 位十六进制，封顶不变量成立（相对直搬的唯一修正）
  return (hash >>> 0).toString(16).padStart(8, "0");
}
