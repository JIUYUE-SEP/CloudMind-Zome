import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Scheduler, type SchedulerDeps } from "../../src/scheduler/scheduler.js";
import { computeNextRun } from "../../src/scheduler/engine.js";
import { ErrorThrottle } from "../../src/plugins/log/error-throttle.js";
import { logger } from "../../src/logger.js";
import { SchedulerRepository } from "../../src/scheduler/repository.js";
import type { AgentWorker } from "../../src/core/agent-worker.js";
import type { ScheduledTask } from "../../src/scheduler/types.js";
import { restoreDataDir } from "../helpers/env.js";

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
    restoreDataDir(originalDataDir);
    // Retry cleanup: Windows 上 fire-and-forget 的 runTask 可能仍在写文件，
    // 瞬时文件锁会让 rm 抛 EPERM/EBUSY；目录非空则是 ENOTEMPTY。
    for (let i = 0; i < 5; i++) {
      try {
        await fs.rm(tmpDir, { recursive: true, force: true });
        break;
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if ((code === "ENOTEMPTY" || code === "EPERM" || code === "EBUSY") && i < 4) {
          await new Promise((r) => setTimeout(r, 100));
          continue;
        }
        throw err;
      }
    }
  });

  function makeDeps(worker: AgentWorker): SchedulerDeps {
    return {
      agentRepository: {
        list: async () => [{ id: "agent-1", name: "agent", model: "gpt-4", provider: "openai", tools: [] }],
        get: async () => undefined,
        save: async () => {},
        delete: async () => {},
      },
      getAgentWorker: async () => worker,
    } as unknown as SchedulerDeps;
  }

  function makeWorker(): AgentWorker {
    return { runScheduledTask: vi.fn() } as unknown as AgentWorker;
  }

  it("fires tasks asynchronously without blocking tick", async () => {
    let resolveWorker: (w: AgentWorker) => void;
    const workerPromise = new Promise<AgentWorker>((resolve) => {
      resolveWorker = resolve;
    });
    const deps = makeDeps(undefined as unknown as AgentWorker);
    deps.getAgentWorker = async () => workerPromise;

    const scheduler = new Scheduler(deps);
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

    // tick 必须是非阻塞的（workerPromise 尚未 resolve，tick 就已完成）。
    // 用 waitFor 轮询代替固定 10ms 墙钟窗口——并行满载时 10ms 不可靠（flaky）。
    await vi.waitFor(() => expect(tickResolved).toBe(true), { timeout: 2000, interval: 5 });

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
    const scheduler = new Scheduler(makeDeps(worker));
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
    const deps = makeDeps(undefined as unknown as AgentWorker);
    deps.getAgentWorker = async () => {
      throw new Error("worker failed");
    };

    const scheduler = new Scheduler(deps);
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
    const deps: SchedulerDeps = {
      ...makeDeps(undefined as unknown as AgentWorker),
      getAgentWorker,
    };

    const scheduler = new Scheduler(deps);
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

  it("tick 错误节流（P4-4）：同一错误不每秒刷屏，恢复有日志", async () => {
    let now = 0;
    const throttle = new ErrorThrottle({ now: () => now, initialBackoffMs: 1000 });
    const errorSpy = vi.spyOn(logger, "error").mockImplementation(() => {});
    const infoSpy = vi.spyOn(logger, "info").mockImplementation(() => {});

    let shouldFail = true;
    const deps: SchedulerDeps = {
      ...makeDeps(makeWorker()),
      agentRepository: {
        list: async () => {
          if (shouldFail) throw new Error("config store corrupted");
          return [];
        },
        get: async () => undefined,
        save: async () => {},
        delete: async () => {},
      } as unknown as SchedulerDeps["agentRepository"],
    };
    const scheduler = new Scheduler(deps, { errorThrottle: throttle });
    const tick = () => (scheduler as unknown as SchedulerInternals).tick();

    // t=0 首次记录；t=100/900 折叠；t=1100 第二次记录（带累计）
    await tick();
    now = 100;
    await tick();
    now = 900;
    await tick();
    now = 1100;
    await tick();

    const errorCalls = errorSpy.mock.calls.filter((c) => String(c[1]).includes("scheduler tick failed"));
    expect(errorCalls).toHaveLength(2);
    expect(errorCalls[1]?.[0]).toMatchObject({ count: 4, suppressed: 2 });

    // 恢复：tick 跑通后记录"已恢复"（count=累计次数；折叠数已随上次错误日志清零）
    shouldFail = false;
    now = 5000;
    await tick();
    const recovered = infoSpy.mock.calls.filter((c) => String(c[1]).includes("已恢复"));
    expect(recovered).toHaveLength(1);
    expect(recovered[0]?.[0]).toMatchObject({ count: 4, suppressed: 0 });

    errorSpy.mockRestore();
    infoSpy.mockRestore();
    scheduler.stop();
  });

  it("M27：任务失败一次性重试——nextRunAt 改到 60s 后补偿，任务保持启用", async () => {
    const worker = makeWorker();
    (worker.runScheduledTask as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("boom"));
    const scheduler = new Scheduler(makeDeps(worker));
    const repo = new SchedulerRepository("agent-1");
    const task = await repo.create({
      agentId: "agent-1",
      description: "t1",
      prompt: "hello",
      cron: "0 9 * * *",
      enabled: true,
      nextRunAt: new Date(Date.now() - 1000).toISOString(),
    });

    await (scheduler as unknown as SchedulerInternals).runTask(task, "agent-1");

    const updated = await repo.get(task.id);
    expect(updated?.enabled).toBe(true);
    // 补偿语义：nextRunAt 落在 ~60s 后补跑一次，而非干等下个 cron 周期（明早 9 点）
    const retryAt = new Date(updated!.nextRunAt!).getTime();
    expect(retryAt).toBeGreaterThan(Date.now() + 50_000);
    expect(retryAt).toBeLessThanOrEqual(Date.now() + 70_000);
    scheduler.stop();
  });

  it("M27：重试仍失败不再重试——落到下个 cron 周期，不无限重试", async () => {
    const worker = makeWorker();
    (worker.runScheduledTask as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("boom"));
    const scheduler = new Scheduler(makeDeps(worker));
    const internals = scheduler as unknown as SchedulerInternals;
    const repo = new SchedulerRepository("agent-1");
    const task = await repo.create({
      agentId: "agent-1",
      description: "t1",
      prompt: "hello",
      cron: "0 9 * * *",
      enabled: true,
      nextRunAt: new Date(Date.now() - 1000).toISOString(),
    });

    await internals.runTask(task, "agent-1"); // 首次失败 → 排一次性重试
    const retryTask = (await repo.get(task.id))!;
    await internals.runTask(retryTask, "agent-1"); // 重试仍失败 → 不再重试

    const updated = await repo.get(task.id);
    // nextRunAt 是本轮执行前推进的下个 cron 周期，而不是又一个 60s 重试
    expect(updated?.nextRunAt).toBe(computeNextRun("0 9 * * *"));
    scheduler.stop();
  });

  it("M27：跑通后重置重试额度——下个周期失败仍可补跑一次", async () => {
    const worker = makeWorker();
    const runMock = worker.runScheduledTask as ReturnType<typeof vi.fn>;
    const scheduler = new Scheduler(makeDeps(worker));
    const internals = scheduler as unknown as SchedulerInternals;
    const repo = new SchedulerRepository("agent-1");
    const task = await repo.create({
      agentId: "agent-1",
      description: "t1",
      prompt: "hello",
      cron: "0 9 * * *",
      enabled: true,
      nextRunAt: new Date(Date.now() - 1000).toISOString(),
    });

    runMock.mockRejectedValueOnce(new Error("boom"));
    await internals.runTask(task, "agent-1"); // 失败 → 排重试
    const retryTask = (await repo.get(task.id))!;
    await internals.runTask(retryTask, "agent-1"); // 重试成功 → 额度重置
    const okTask = (await repo.get(task.id))!;
    runMock.mockRejectedValueOnce(new Error("boom"));
    await internals.runTask(okTask, "agent-1"); // 再次失败 → 仍获得一次重试

    const updated = await repo.get(task.id);
    const retryAt = new Date(updated!.nextRunAt!).getTime();
    expect(retryAt).toBeGreaterThan(Date.now() + 50_000);
    expect(retryAt).toBeLessThanOrEqual(Date.now() + 70_000);
    scheduler.stop();
  });
});

