/**
 * L6 工具分流（决策 1/2，单一事实源）：名字前缀分类。
 *
 * - `mcp__` / `ext__` 前缀 → L6-ext（可裁剪层）：MCP server 工具与外部插件
 *   工具等动态注册项，预算压力下按降级序列先裁（用户可预期"某 MCP 工具
 *   暂时下线"）。
 * - 其余一律 L6-core（永不裁剪）：14 个内置工具（含 dispatch 系编排能力）
 *   是 Agent 基本盘，预算压力不该静默剥夺。
 *
 * fail-safe（决策 2）：ToolSchema = unknown，读不到合法名字（无 function
 * 段 / name 缺失 / name 非 string）一律归 core，永不误裁不可识别项。
 */

/** 形状守卫读工具名：仅 `schema.function.name` 为 string 时返回，其余形态 undefined */
export function readToolName(schema: unknown): string | undefined {
  if (typeof schema !== "object" || schema === null) return undefined;
  const fn = (schema as Record<string, unknown>).function;
  if (typeof fn !== "object" || fn === null) return undefined;
  const name = (fn as Record<string, unknown>).name;
  return typeof name === "string" ? name : undefined;
}

/** 名字以 `mcp__` 或 `ext__` 开头 → L6-ext；读不到名字或无前缀 → false（归 core） */
export function isExtTool(schema: unknown): boolean {
  const name = readToolName(schema);
  return name !== undefined && (name.startsWith("mcp__") || name.startsWith("ext__"));
}
