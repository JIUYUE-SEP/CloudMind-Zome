import { describe, it, expect } from "vitest";
import { PlanManager } from "../../src/plan/manager.js";
import { MockLLMProvider } from "../../src/provider/llm.js";

describe("PlanManager", () => {
  it("creates plan from goal", async () => {
    const manager = new PlanManager({ provider: new MockLLMProvider(), model: "mock" });
    const plan = await manager.createPlan("- step one\n- step two");
    expect(plan.steps).toHaveLength(2);
    expect(plan.status).toBe("pending");
  });

  it("executes step and marks complete", async () => {
    const manager = new PlanManager({ provider: new MockLLMProvider(), model: "mock" });
    const plan = await manager.createPlan("- step one");
    const updated = await manager.executeStep(plan.id, plan.steps[0].id, async () => "done");
    expect(updated.steps[0].status).toBe("completed");
    expect(updated.status).toBe("completed");
  });
});
