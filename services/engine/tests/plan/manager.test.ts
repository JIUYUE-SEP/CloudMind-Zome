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

  it("pauses and resumes plan", async () => {
    const manager = new PlanManager({ provider: new MockLLMProvider(), model: "mock" });
    const plan = await manager.createPlan("- step one");
    const paused = manager.pause(plan.id);
    expect(paused.status).toBe("paused");
    const running = manager.resume(plan.id);
    expect(running.status).toBe("pending");
  });

  it("retries failed step", async () => {
    const manager = new PlanManager({ provider: new MockLLMProvider(), model: "mock" });
    const plan = await manager.createPlan("- step one");
    await manager.executeStep(plan.id, plan.steps[0].id, async () => {
      throw new Error("boom");
    });
    expect(manager.get(plan.id)?.status).toBe("failed");
    const retried = manager.retry(plan.id, plan.steps[0].id);
    expect(retried.steps[0].status).toBe("pending");
    expect(retried.status).toBe("pending");
  });
});
