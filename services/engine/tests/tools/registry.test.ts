import { describe, it, expect } from "vitest";
import { z } from "zod";
import { ToolRegistry } from "../../src/tools/registry.js";
import type { Tool, ToolContext, ToolResult } from "../../src/tools/types.js";

const dummyTool: Tool = {
  name: "dummy",
  description: "A dummy tool for testing",
  parameters: z.object({ value: z.string() }),
  accesses: [{ resource: "file", action: "read" }],
  async execute(ctx: ToolContext, args: unknown): Promise<ToolResult> {
    void ctx;
    void args;
    return { success: true, output: "ok" };
  },
};

describe("ToolRegistry", () => {
  it("registers, gets and lists tools", () => {
    const registry = new ToolRegistry();
    registry.register(dummyTool);

    expect(registry.get("dummy")).toBe(dummyTool);
    expect(registry.list()).toEqual([dummyTool]);
  });

  it("throws when registering a duplicate tool", () => {
    const registry = new ToolRegistry();
    registry.register(dummyTool);
    expect(() => registry.register(dummyTool)).toThrow("already registered");
  });

  it("converts tools to OpenAI function format", () => {
    const registry = new ToolRegistry();
    registry.register(dummyTool);

    const openaiTools = registry.toOpenAITools();
    expect(openaiTools).toHaveLength(1);
    expect(openaiTools[0]).toMatchObject({
      type: "function",
      function: {
        name: "dummy",
        description: "A dummy tool for testing",
      },
    });

    const schema = (openaiTools[0] as { function: { parameters: unknown } }).function.parameters as {
      type: string;
      properties: Record<string, unknown>;
      required: string[];
    };
    expect(schema.type).toBe("object");
    expect(schema.properties).toHaveProperty("value");
    expect(schema.required).toContain("value");
  });
});
