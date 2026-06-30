import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Scheduler } from "../../src/scheduler/scheduler.js";
import { SchedulerRepository } from "../../src/scheduler/repository.js";
import type { ApiContext } from "../../src/api/context.js";
import type { AgentWorker } from "../../src/core/agent-worker.js";
import type { ScheduledTask } from "../../src/scheduler/types.js";

type SchedulerInternals = {
  tick(): Promise<void>;
  runTask(task: ScheduledTask, agentId: string): Promise<void>;
};

describe("Scheduler", () => {
  let tmpDir: string;
  const originalDataDir = process.env.CLOUDMIND_DATA_DIR;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "scheduler-test-"));
    process.env.CLOUDMIND_DATA_DIR = tmpDir;
  });

  afterEach(async () => {
    process.env.CLOUDMIND_DATA_DIR = originalDataDir;
    // Retry cleanup: Windows may briefly hold file handles after async I/O.
    for (let i = 0; i < 5; i++) {
      try {
        await fs.rm(tmpDir, { recursive: true, force: true });
        break;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOTEMPTY" && i < 4) {
          await new Promise((r) => setTimeout(r, 50));
          continue;
        }
        throw err;
      }
    }
  });

  function makeContext(worker: AgentWorker): ApiContext {
    return {
      agentRepository: {
        list: async () => [{ id: "agent-1", name: "agent", model: "gpt-4", provider: "openai", tools: [] }],
        get: async () => undefined,
        save: async () => {},
        delete: async () => {},
      },
      getAgentWorker: async () => worker,
    } as unknown as ApiContext;
  }

  function makeWorker(): AgentWorker {
    return { runScheduledTask: vi.fn() } as unknown as AgentWorker;
  }

  it("fires tasks asynchronously without blocking tick", async () => {
    let resolveWorker: (w: AgentWorker) => void;
    const workerPromise = new Promise<AgentWorker>((resolve) => {
      resolveWorker = resolve;
    });
    const context = makeContext(undefined as unknown as AgentWorker);
    context.getAgentWorker = async () => workerPromise;

    const scheduler = new Scheduler(context);
    const repo = new SchedulerRepository("agent-1");
    await repo.create({
      agentId: "agent-1",
      description: "t1",
      prompt: "hello",
      cron: "* * * * *",
      enabled: true,
      nextRunAt: new Date(Date.now() - 1000).toISOString(),
    });

    let tickResolved = false;
    const tickPromise = (scheduler as unknown as SchedulerInternals).tick().then(() => {
      tickResolved = true;
    });

    // Yield so runTask starts awaiting workerPromise.
    await new Promise((r) => setTimeout(r, 10));
    expect(tickResolved).toBe(true);

    const worker = makeWorker();
    resolveWorker!(worker);

    // Wait for runTask to complete (runScheduledTask is called after repo.update).
    await new Promise<void>((resolve) => {
      const check = setInterval(() => {
        if ((worker.runScheduledTask as ReturnType<typeof vi.fn>).mock.calls.length > 0) {
          clearInterval(check);
          resolve();
        }
      }, 5);
    });

    await tickPromise;
    scheduler.stop();
  });

  it("updates nextRunAt and enqueues due task", async () => {
    const worker = makeWorker();
    const scheduler = new Scheduler(makeContext(worker));
    const repo = new SchedulerRepository("agent-1");
    const past = new Date(Date.now() - 1000).toISOString();
    const task = await repo.create({
      agentId: "agent-1",
      description: "t1",
      prompt: "hello",
      cron: "0 9 * * *",
      enabled: true,
      nextRunAt: past,
    });

    await (scheduler as unknown as SchedulerInternals).tick();

    // Poll until runTask updates the schedule.
    let updated = await repo.get(task.id);
    const start = Date.now();
    while ((!updated?.lastRunAt || updated.nextRunAt === past) && Date.now() - start < 1000) {
      await new Promise((r) => setTimeout(r, 10));
      updated = await repo.get(task.id);
    }

    expect(updated?.lastRunAt).toBeTruthy();
    expect(updated?.nextRunAt).not.toBe(past);
    expect(worker.runScheduledTask).toHaveBeenCalledTimes(1);
    scheduler.stop();
  });

  it("catches errors in runTask and does not crash tick", async () => {
    const context = makeContext(undefined as unknown as AgentWorker);
    context.getAgentWorker = async () => {
      throw new Error("worker failed");
    };

    const scheduler = new Scheduler(context);
    const repo = new SchedulerRepository("agent-1");
    await repo.create({
      agentId: "agent-1",
      description: "t1",
      prompt: "hello",
      cron: "* * * * *",
      enabled: true,
      nextRunAt: new Date(Date.now() - 1000).toISOString(),
    });

    await expect((scheduler as unknown as SchedulerInternals).tick()).resolves.not.toThrow();
    scheduler.stop();
  });

  it("prevents concurrent runTask for the same task", async () => {
    let resolveWorker: (w: AgentWorker) => void;
    const workerPromise = new Promise<AgentWorker>((resolve) => {
      resolveWorker = resolve;
    });
    const getAgentWorker = vi.fn(async () => workerPromise);
    const context: ApiContext = {
      ...makeContext(undefined as unknown as AgentWorker),
      getAgentWorker,
    };

    const scheduler = new Scheduler(context);
    const repo = new SchedulerRepository("agent-1");
    const task = await repo.create({
      agentId: "agent-1",
      description: "t1",
      prompt: "hello",
      cron: "* * * * *",
      enabled: true,
      nextRunAt: new Date(Date.now() - 1000).toISOString(),
    });

    const run1 = (scheduler as unknown as SchedulerInternals).runTask(task, "agent-1");
    const run2 = (scheduler as unknown as SchedulerInternals).runTask(task, "agent-1");

    await new Promise((r) => setTimeout(r, 10));
    resolveWorker!(makeWorker());
    await run1;
    await run2;

    expect(getAgentWorker).toHaveBeenCalledTimes(1);
    scheduler.stop();
  });
});
