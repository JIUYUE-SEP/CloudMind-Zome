import { describe, it, expect } from "vitest";
import { PlanManager } from "../../src/plan/manager.js";
import type { PlanRepository } from "../../src/plan/repository.js";
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
    const paused = await manager.pause(plan.id);
    expect(paused.status).toBe("paused");
    const running = await manager.resume(plan.id);
    expect(running.status).toBe("pending");
  });

  it("retries failed step", async () => {
    const manager = new PlanManager({ provider: new MockLLMProvider(), model: "mock" });
    const plan = await manager.createPlan("- step one");
    await manager.executeStep(plan.id, plan.steps[0].id, async () => {
      throw new Error("boom");
    });
    expect(manager.get(plan.id)?.status).toBe("failed");
    const retried = await manager.retry(plan.id, plan.steps[0].id);
    expect(retried.steps[0].status).toBe("pending");
    expect(retried.status).toBe("pending");
  });

  it("M21：persist 失败不卡死——step 照常终态流转、plan 不悬空 running", async () => {
    // 落盘全失败的 repository：与 BackgroundManager.persist 同口径，
    // 只记 warn 不抛出，内存态为准继续流转
    const failingRepository = {
      loadAll: async () => [],
      upsert: async () => {
        throw new Error("disk full");
      },
    } as unknown as PlanRepository;
    const manager = new PlanManager(
      { provider: new MockLLMProvider(), model: "mock" },
      failingRepository,
    );
    // createPlan 的落盘失败同样不抛出
    const plan = await manager.createPlan("- step one");
    const updated = await manager.executeStep(plan.id, plan.steps[0].id, async () => "done");
    expect(updated.steps[0].status).toBe("completed");
    expect(updated.status).toBe("completed");
  });

  it("M22：signal 中止的步骤标 aborted（区别于 failed），plan 回 pending 可重跑", async () => {
    const manager = new PlanManager({ provider: new MockLLMProvider(), model: "mock" });
    const plan = await manager.createPlan("- step one");
    const controller = new AbortController();
    const updated = await manager.executeStep(
      plan.id,
      plan.steps[0].id,
      async () => {
        controller.abort(new Error("client gone"));
        throw new Error("aborted");
      },
      { signal: controller.signal },
    );
    expect(updated.steps[0].status).toBe("aborted");
    expect(updated.status).toBe("pending");

    // aborted 语义可恢复：retry 重置 pending 后可正常重跑
    const retried = await manager.retry(plan.id, plan.steps[0].id);
    expect(retried.steps[0].status).toBe("pending");
    const redone = await manager.executeStep(plan.id, plan.steps[0].id, async () => "done");
    expect(redone.steps[0].status).toBe("completed");
    expect(redone.status).toBe("completed");
  });

  it("M22：executor 抛错但 signal 未中止仍标 failed（口径不混淆）", async () => {
    const manager = new PlanManager({ provider: new MockLLMProvider(), model: "mock" });
    const plan = await manager.createPlan("- step one");
    const controller = new AbortController();
    const updated = await manager.executeStep(
      plan.id,
      plan.steps[0].id,
      async () => {
        throw new Error("genuine failure");
      },
      { signal: controller.signal },
    );
    expect(updated.steps[0].status).toBe("failed");
    expect(updated.status).toBe("failed");
  });
});
