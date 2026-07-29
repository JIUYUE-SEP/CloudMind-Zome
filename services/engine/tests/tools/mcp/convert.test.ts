import { describe, it, expect } from "vitest";
import { z } from "zod";
import { mapAnnotationsToApproval, mcpInputSchemaToZod } from "../../../src/tools/mcp/convert.js";

describe("mapAnnotationsToApproval（fail-closed）", () => {
  it("readOnlyHint === true → 免审批", () => {
    expect(mapAnnotationsToApproval({ readOnlyHint: true })).toEqual({ requiresApproval: false });
  });

  it("readOnlyHint === false → 需审批", () => {
    expect(mapAnnotationsToApproval({ readOnlyHint: false })).toEqual({ requiresApproval: true });
  });

  it("annotations 缺失/为空 → 需审批（未知即危险）", () => {
    expect(mapAnnotationsToApproval(undefined)).toEqual({ requiresApproval: true });
    expect(mapAnnotationsToApproval({})).toEqual({ requiresApproval: true });
    expect(mapAnnotationsToApproval({ destructiveHint: false })).toEqual({ requiresApproval: true });
  });
});

describe("mcpInputSchemaToZod", () => {
  it("object + required + 标量/枚举/数组转换后可校验", () => {
    const schema = mcpInputSchemaToZod({
      type: "object",
      properties: {
        path: { type: "string", description: "文件路径" },
        mode: { enum: ["fast", "safe"] },
        count: { type: "integer" },
        tags: { type: "array", items: { type: "string" } },
      },
      required: ["path"],
    });
    expect(schema.parse({ path: "a.txt" })).toEqual({ path: "a.txt" });
    expect(() => schema.parse({})).toThrow();
    expect(() => schema.parse({ path: "a", mode: "turbo" })).toThrow();
  });

  it("边界 schema 不抛错，返回可用的 zod schema（降级路径）", () => {
    // oneOf/anyOf/$ref 等边界构造：要么库能转，要么降级 z.unknown()，绝不能炸掉工具装配
    for (const edge of [
      { $ref: "#/definitions/x", definitions: { x: { type: "string" } } },
      { oneOf: [{ type: "string" }, { type: "number" }] },
      { anyOf: [{ type: "boolean" }, { enum: ["auto"] }] },
      {},
    ]) {
      const schema = mcpInputSchemaToZod(edge);
      expect(schema).toBeInstanceOf(z.ZodType);
      expect(() => schema.parse({})).not.toThrow();
    }
  });
});
