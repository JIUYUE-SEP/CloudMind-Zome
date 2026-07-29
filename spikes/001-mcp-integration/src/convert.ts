/**
 * MCP tool → engine 内部 Tool 格式的转换（对应 services/engine/src/tools/types.ts 的 Tool 接口）。
 *
 * engine Tool 形状：
 *   { name, description, parameters: ZodTypeAny, accesses: ToolAccess[], requiresApproval?: boolean, execute }
 * MCP tool 形状：
 *   { name, description?, inputSchema: JSONSchema, annotations?: ToolAnnotations }
 */

export interface McpToolAnnotations {
  title?: string;
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}

export interface McpToolLike {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
  annotations?: McpToolAnnotations;
}

/** 与 engine 审批策略对齐的映射结果（spike 阶段不含 execute 包装） */
export interface EngineToolSpec {
  name: string;
  description: string;
  /** engine 的 parameters 是 zod；这里产出最小可用的 zod object schema */
  parameters: unknown;
  accesses: Array<{ resource: string; action: "read" | "write" }>;
  requiresApproval: boolean;
  /** true = 禁止"本会话免问"记忆（对应 engine 的 NO_REMEMBER_TOOLS 语义） */
  noRemember: boolean;
}

/**
 * annotations → 审批映射（fail-closed）：
 * - readOnlyHint === true                → 免审批
 * - destructiveHint === true             → 需审批 + 禁止 remember
 * - readOnlyHint !== true（缺失或 false）→ 需审批（未知即危险）
 * - idempotentHint / openWorldHint       → 不改审批结论，仅记录
 */
export function mapAnnotationsToApproval(a: McpToolAnnotations | undefined): {
  requiresApproval: boolean;
  noRemember: boolean;
} {
  if (a?.readOnlyHint === true) {
    return { requiresApproval: false, noRemember: false };
  }
  return { requiresApproval: true, noRemember: true };
}

import { z } from "zod";

/** 最小 JSON Schema → zod 转换：只覆盖 object + 标量/enum/array，够 spike 用 */
export function jsonSchemaToZod(schema: Record<string, unknown>): z.ZodTypeAny {
  const type = schema.type as string | undefined;
  if (type === "object" || schema.properties) {
    const props = (schema.properties ?? {}) as Record<string, Record<string, unknown>>;
    const required = new Set((schema.required as string[] | undefined) ?? []);
    const shape: Record<string, z.ZodTypeAny> = {};
    for (const [key, sub] of Object.entries(props)) {
      let zt = jsonSchemaToZod(sub);
      if (sub.description) zt = zt.describe(sub.description as string);
      shape[key] = required.has(key) ? zt : zt.optional();
    }
    return z.object(shape);
  }
  if (schema.enum) return z.enum(schema.enum as [string, ...string[]]);
  switch (type) {
    case "string":
      return z.string();
    case "number":
      return z.number();
    case "integer":
      return z.number().int();
    case "boolean":
      return z.boolean();
    case "array":
      return z.array(jsonSchemaToZod((schema.items as Record<string, unknown>) ?? {}));
    default:
      return z.unknown();
  }
}

export function mcpToolToEngineSpec(tool: McpToolLike): EngineToolSpec {
  const approval = mapAnnotationsToApproval(tool.annotations);
  return {
    name: tool.name,
    description: tool.description ?? tool.annotations?.title ?? tool.name,
    parameters: jsonSchemaToZod(tool.inputSchema),
    // MCP annotations 不含资源维度，resource 只能粗判，正式接入需人工/配置补充
    accesses: [
      {
        resource: tool.annotations?.openWorldHint === false ? "file" : "network",
        action: approval.requiresApproval ? "write" : "read",
      },
    ],
    requiresApproval: approval.requiresApproval,
    noRemember: approval.noRemember,
  };
}
