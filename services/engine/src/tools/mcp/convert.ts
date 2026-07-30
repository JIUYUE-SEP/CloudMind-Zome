import { z } from "zod";
import type { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";

/**
 * annotations → 审批映射（fail-closed，spike 结论）：
 * 仅 readOnlyHint === true 免审批；其余（false 或缺失）一律需审批。
 * annotations 全部可选且第三方 server 不可信，缺失必须按危险处理。
 * 该映射可被 server 配置 toolOverrides.requiresApproval 本地覆盖（见 wrapper.ts）；
 * 「禁止本会话免问」不在这里表达——mcp__ 前缀工具在 WS 审批层默认禁 remember，
 * 仅 toolOverrides.allowRemember===true 放行（见 api/ws/handler.ts / session-handler.ts）。
 */
export function mapAnnotationsToApproval(annotations: ToolAnnotations | undefined): {
  requiresApproval: boolean;
} {
  return { requiresApproval: annotations?.readOnlyHint !== true };
}

type JsonSchema = Record<string, unknown>;

/**
 * 最小 JSON Schema → zod 转换：覆盖 object/properties/required、标量、enum、array、
 * nullable/const，足够表达 MCP 工具的常规 inputSchema。
 * 边界（oneOf/anyOf/$ref/format 等）按任务约定降级为 z.unknown()：
 * 参数校验交由 MCP server 侧，导出给 LLM 的 schema 对应字段退化为无约束，不阻塞链路。
 *
 * 不引第三方转换库的原因：@n8n/json-schema-to-zod@1.15.0 的 ESM 构建内部 import
 * 不带扩展名，在 engine 的 Node16 ESM 运行时下直接无法加载（tsc 产物与 vitest 同挂）。
 */
export function mcpInputSchemaToZod(schema: unknown): z.ZodTypeAny {
  if (typeof schema !== "object" || schema === null) return z.unknown();
  const s = schema as JsonSchema;

  // 边界构造直接降级，不做半吊子支持
  if ("$ref" in s || "oneOf" in s || "anyOf" in s || "allOf" in s || "not" in s) {
    return z.unknown();
  }
  if (Array.isArray(s.enum)) {
    const values = s.enum.filter((v): v is string => typeof v === "string");
    if (values.length === s.enum.length && values.length > 0) {
      return z.enum(values as [string, ...string[]]);
    }
    return z.unknown();
  }
  if ("const" in s) {
    return typeof s.const === "string" ? z.literal(s.const) : z.unknown();
  }

  const type = s.type;
  // nullable 表达：{ type: ["string", "null"] }
  if (Array.isArray(type)) {
    const nonNull = type.filter((t) => t !== "null");
    if (nonNull.length === 1 && type.includes("null")) {
      return mcpInputSchemaToZod({ ...s, type: nonNull[0] }).nullable();
    }
    return z.unknown();
  }

  switch (type) {
    case "object":
    case undefined: {
      if (type === undefined && !s.properties) return z.unknown();
      const props = (s.properties ?? {}) as Record<string, JsonSchema>;
      const required = new Set(Array.isArray(s.required) ? (s.required as string[]) : []);
      const shape: Record<string, z.ZodTypeAny> = {};
      for (const [key, sub] of Object.entries(props)) {
        let zt = mcpInputSchemaToZod(sub);
        if (typeof sub.description === "string") zt = zt.describe(sub.description);
        shape[key] = required.has(key) ? zt : zt.optional();
      }
      return z.object(shape);
    }
    case "string":
      return z.string();
    case "number":
      return z.number();
    case "integer":
      return z.number().int();
    case "boolean":
      return z.boolean();
    case "array":
      return z.array(mcpInputSchemaToZod(s.items));
    case "null":
      return z.null();
    default:
      return z.unknown();
  }
}
