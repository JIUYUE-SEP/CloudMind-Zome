import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PlanManager } from "../../src/plan/manager.js";
import { PlanRepository } from "../../src/plan/repository.js";
import { MockLLMProvider } from "../../src/provider/llm.js";
import { getAgentDir } from "../../src/config/paths.js";
import { restoreDataDir } from "../helpers/env.js";
import type { Plan } from "../../src/plan/types.js";

describe("Plan persistence", () => {
  let tmpDir: string;
  const originalDataDir = process.env.CLOUDMIND_DATA_DIR;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "plan-persist-test-"));
    process.env.CLOUDMIND_DATA_DIR = tmpDir;
  });

  afterEach(async () => {
    restoreDataDir(originalDataDir);
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  const makeManager = () =>
    new PlanManager(
      { provider: new MockLLMProvider(), model: "mock" },
      new PlanRepository("agent-1"),
    );

  it("persists plans to plans.jsonl and reads them back identically", async () => {
    const manager = makeManager();
    const plan = await manager.createPlan("- step one\n- step two");
    await manager.executeStep(plan.id, plan.steps[0].id, async () => "done-1");

    const persisted = await new PlanRepository("agent-1").loadAll();
    expect(persisted).toHaveLength(1);
    expect(persisted[0].id).toBe(plan.id);
    expect(persisted[0].goal).toBe(plan.goal);
    expect(persisted[0].steps[0].status).toBe("completed");
    expect(persisted[0].steps[0].output).toBe("done-1");
    expect(persisted[0].steps[1].status).toBe("pending");

    // 文件确实落在 agent 目录下
    const file = path.join(getAgentDir("agent-1"), "plans.jsonl");
    const lines = (await fs.readFile(file, "utf-8")).trim().split("\n");
    expect(lines).toHaveLength(1);
  });

  it("recovers full progress after restart (new manager on same file)", async () => {
    const manager1 = makeManager();
    const plan = await manager1.createPlan("- step one\n- step two");
    await manager1.executeStep(plan.id, plan.steps[0].id, async () => "done-1");
    await manager1.pause(plan.id);

    // 模拟重启：全新 manager 实例读同一文件
    const manager2 = makeManager();
    expect(manager2.get(plan.id)).toBeUndefined();
    await manager2.load();

    const restored = manager2.get(plan.id);
    expect(restored).toBeDefined();
    expect(restored!.status).toBe("paused");
    expect(restored!.steps[0].status).toBe("completed");
    expect(restored!.steps[0].output).toBe("done-1");
    expect(restored!.steps[1].status).toBe("pending");
    expect(manager2.list()).toHaveLength(1);
  });

  it("rolls back running step/plan to pending on load and can continue executing", async () => {
    const manager1 = makeManager();
    const plan = await manager1.createPlan("- step one\n- step two");

    // 模拟执行中途崩溃：磁盘上留下 running 状态的 step/plan
    const crashed: Plan = structuredClone(plan);
    crashed.status = "running";
    crashed.steps[0].status = "running";
    await new PlanRepository("agent-1").upsert(crashed);

    const manager2 = makeManager();
    await manager2.load();

    const restored = manager2.get(plan.id)!;
    expect(restored.status).toBe("pending");
    expect(restored.steps[0].status).toBe("pending");
    expect(restored.steps[0].error).toBe("interrupted: engine restarted");
    expect(restored.steps[1].status).toBe("pending");

    // 回退后可继续执行（/run 只执行 pending 步骤的语义）
    const updated = await manager2.executeStep(plan.id, restored.steps[0].id, async () => "redone");
    expect(updated.steps[0].status).toBe("completed");
    expect(updated.steps[0].output).toBe("redone");
    expect(updated.steps[0].error).toBeUndefined();
  });

  it("truncates oversized step output on persist", async () => {
    const manager = makeManager();
    const plan = await manager.createPlan("- big output");
    const big = "x".repeat(100 * 1024);
    await manager.executeStep(plan.id, plan.steps[0].id, async () => big);

    // 内存态保持完整
    expect(manager.get(plan.id)!.steps[0].output).toBe(big);

    const persisted = await new PlanRepository("agent-1").loadAll();
    const output = persisted[0].steps[0].output as string;
    expect(output.length).toBeLessThanOrEqual(50 * 1024 + "...[truncated]".length);
    expect(output.endsWith("...[truncated]")).toBe(true);
  });
});
