import { describe, it, expect } from "vitest";
import { executeBlueprint } from "../../src/blueprint/engine.js";
import type { Blueprint } from "../../src/blueprint/types.js";
import type { ApiContext } from "../../src/api/context.js";

const mockContext = {
  getAgentWorker: async () => undefined,
} as unknown as ApiContext;

describe("executeBlueprint", () => {
  it("executes start -> end blueprint", async () => {
    const blueprint: Blueprint = {
      id: "b1",
      name: "Test",
      nodes: [
        { id: "start", type: "start", x: 0, y: 0 },
        { id: "end", type: "end", x: 200, y: 0 },
      ],
      edges: [{ source: "start", target: "end" }],
      createdAt: "2024-01-01",
      updatedAt: "2024-01-01",
    };
    const result = await executeBlueprint(blueprint, mockContext, { initialInput: "hello" });
    expect(result.status).toBe("completed");
    expect(result.outputs["end"]).toBe("hello");
  });

  it("fails when start node is missing", async () => {
    const blueprint: Blueprint = {
      id: "b1",
      name: "Test",
      nodes: [{ id: "end", type: "end", x: 0, y: 0 }],
      edges: [],
      createdAt: "2024-01-01",
      updatedAt: "2024-01-01",
    };
    const result = await executeBlueprint(blueprint, mockContext);
    expect(result.status).toBe("failed");
  });

  it("reports tool not found for unknown tool", async () => {
    const blueprint: Blueprint = {
      id: "b1",
      name: "Test",
      nodes: [
        { id: "start", type: "start", x: 0, y: 0 },
        { id: "tool", type: "tool", x: 200, y: 0, config: { toolName: "unknown", arguments: {} } },
        { id: "end", type: "end", x: 400, y: 0 },
      ],
      edges: [
        { source: "start", target: "tool" },
        { source: "tool", target: "end" },
      ],
      createdAt: "2024-01-01",
      updatedAt: "2024-01-01",
    };
    const result = await executeBlueprint(blueprint, mockContext);
    expect(result.status).toBe("completed");
    expect(result.outputs["tool"]).toContain("tool not found");
  });

  it.each(["run_command", "write_file", "bash"])(
    "refuses requiresApproval tool in blueprints: %s",
    async (toolName) => {
      const blueprint: Blueprint = {
        id: "b1",
        name: "Test",
        nodes: [
          { id: "start", type: "start", x: 0, y: 0 },
          { id: "tool", type: "tool", x: 200, y: 0, config: { toolName, arguments: {} } },
          { id: "end", type: "end", x: 400, y: 0 },
        ],
        edges: [
          { source: "start", target: "tool" },
          { source: "tool", target: "end" },
        ],
        createdAt: "2024-01-01",
        updatedAt: "2024-01-01",
      };
      // blueprint 无人工审批通道，危险工具必须被拒绝而不是 executeTool 直跑
      const result = await executeBlueprint(blueprint, mockContext);
      expect(result.status).toBe("completed");
      expect(result.outputs["tool"]).toContain("requires approval");
    },
  );
});
