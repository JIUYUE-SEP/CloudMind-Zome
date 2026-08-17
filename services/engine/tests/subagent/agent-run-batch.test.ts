/**
 * AgentRunBatch 调度核测试（fake timers）：
 * ④ burst 坡道（前 5 立即、后续 700ms 间隔）；
 * ③ 限流场景（unshift 续跑非重开——retry 复用 agentId、容量衰减下限 1、
 *    末位任务不重排直接 failed）。
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import {
  AgentRunBatch,
  type AgentRunBatchLauncher,
  type SwarmSuspendedEvent,
  type SwarmTask,
} from "../../src/subagent/agent-run-batch.js";

afterEach(() => {
  vi.useRealTimers();
});

function task(prompt: string, index: number): SwarmTask {
  return { prompt, description: prompt, swarmIndex: index };
}

interface RecordedLauncher extends AgentRunBatchLauncher {
  spawns: Array<{ prompt: string; at: number }>;
  retries: Array<{ agentId: string; prompt: string; at: number }>;
  suspendedEvents: SwarmSuspendedEvent[];
}

/** 脚本化 launcher：completion 行为由 behavior(agentId/prompt, callCount) 决定 */
function makeLauncher(
  behavior: (prompt: string, agentId: string) => Promise<string>,
): RecordedLauncher {
  const recorded: RecordedLauncher = {
    spawns: [],
    retries: [],
    suspendedEvents: [],
    spawn: (o) => {
      const agentId = `agent-${recorded.spawns.length}`;
      recorded.spawns.push({ prompt: o.prompt, at: Date.now() });
      o.onReady?.();
      return Promise.resolve({ agentId, completion: behavior(o.prompt, agentId) });
    },
    retry: (agentId, o) => {
      recorded.retries.push({ agentId, prompt: o.prompt, at: Date.now() });
      o.onReady?.();
      return Promise.resolve({ agentId, completion: behavior(o.prompt, agentId) });
    },
    resume: (agentId, o) => recorded.retry(agentId, o),
    suspended: (e) => {
      recorded.suspendedEvents.push(e);
    },
  };
  return recorded;
}

describe("④ burst 坡道", () => {
  it("前 5 个立即发射，后续每 700ms 一个", async () => {
    vi.useFakeTimers();
    const launcher = makeLauncher((prompt) => Promise.resolve(`done:${prompt}`));
    const tasks = Array.from({ length: 7 }, (_, i) => task(`t${i}`, i));
    const promise = new AgentRunBatch(launcher, tasks).run();

    // burst 是 run() 内的同步调度：前 5 个立即发射（同一时刻）
    expect(launcher.spawns).toHaveLength(5);
    const t0 = launcher.spawns[0]!.at;
    expect(launcher.spawns.every((s) => s.at === t0)).toBe(true);

    await vi.advanceTimersByTimeAsync(700);
    expect(launcher.spawns).toHaveLength(6);
    expect(launcher.spawns[5]!.at - t0).toBe(700);

    await vi.advanceTimersByTimeAsync(700);
    expect(launcher.spawns).toHaveLength(7);
    expect(launcher.spawns[6]!.at - t0).toBe(1400);

    const results = await promise;
    expect(results.every((r) => r.status === "completed")).toBe(true);
    // 原位聚合
    expect(results.map((r) => r.result)).toEqual(tasks.map((t) => `done:${t.prompt}`));
  });

  it("maxConcurrency 硬封顶（ZOME_SWARM_MAX_CONCURRENCY 同通道）", async () => {
    vi.useFakeTimers();
    let release: () => void = () => {};
    const gate = new Promise<string>((r) => {
      release = () => r("done");
    });
    const launcher = makeLauncher(() => gate);
    const tasks = Array.from({ length: 4 }, (_, i) => task(`t${i}`, i));
    const promise = new AgentRunBatch(launcher, tasks, { maxConcurrency: 2 }).run();

    await vi.advanceTimersByTimeAsync(0);
    expect(launcher.spawns).toHaveLength(2); // 并发封顶优先于 burst
    await vi.advanceTimersByTimeAsync(2000);
    expect(launcher.spawns).toHaveLength(2);
    release();
    await vi.advanceTimersByTimeAsync(2000);
    const results = await promise;
    expect(results).toHaveLength(4);
  });
});

describe("③ 限流场景", () => {
  it("429 → suspended 上浮 + retry 复用同一 agentId 回队续跑（非重开）", async () => {
    vi.useFakeTimers();
    const failed = new Set<string>();
    const launcher = makeLauncher((prompt, agentId) => {
      // a 首次 429；b 挂起到 a 回队后再放行（保证 a 回队时不是末位）
      if (prompt === "a" && !failed.has(agentId)) {
        failed.add(agentId);
        return Promise.reject(Object.assign(new Error("rate limited"), { status: 429 }));
      }
      if (prompt === "b") {
        return new Promise<string>((resolve) => {
          setTimeout(() => resolve("done:b"), 5000);
        });
      }
      return Promise.resolve(`done:${prompt}`);
    });
    const promise = new AgentRunBatch(launcher, [task("a", 0), task("b", 1)]).run();

    // fake timers 下微任务链与计时器推进交织：小步推进直到回队链 settle、retry 发射
    for (let i = 0; i < 12 && launcher.suspendedEvents.length === 0; i++) {
      await vi.advanceTimersByTimeAsync(500);
    }
    expect(launcher.suspendedEvents).toHaveLength(1);
    expect(launcher.suspendedEvents[0]!.reason).toContain("rate limit");

    for (let i = 0; i < 12 && launcher.retries.length === 0; i++) {
      await vi.advanceTimersByTimeAsync(500);
    }
    expect(launcher.retries).toHaveLength(1);
    expect(launcher.retries[0]!.agentId).toBe("agent-0"); // 复用 a 首次 spawn 的 agentId
    expect(launcher.spawns).toHaveLength(2); // 没有重开新 agent

    await vi.advanceTimersByTimeAsync(5000); // b 的 5s 闸门到点
    const results = await promise;
    expect(results[0]).toMatchObject({ status: "completed", result: "done:a" });
    expect(results[1]).toMatchObject({ status: "completed", result: "done:b" });
  });

  it("末位（唯一未完成）任务限流不重排，直接 failed", async () => {
    vi.useFakeTimers();
    const launcher = makeLauncher(() =>
      Promise.reject(Object.assign(new Error("rate limited"), { status: 429 })),
    );
    const promise = new AgentRunBatch(launcher, [task("only", 0)]).run();
    await vi.advanceTimersByTimeAsync(10);
    await vi.advanceTimersByTimeAsync(10);
    const results = await promise;
    expect(results[0]!.status).toBe("failed");
    expect(results[0]!.error).toContain("rate limited");
    expect(launcher.retries).toHaveLength(0);
    expect(launcher.spawns).toHaveLength(1);
  });

  it("限流模式下重试按 ≥3s 间隔排布（容量衰减后自适应 pacing，最终全部有终局）", async () => {
    vi.useFakeTimers();
    const failStreak = new Map<string, number>();
    const launcher = makeLauncher((prompt, agentId) => {
      // b 直接完成；a/c 各 429 两轮后成功（验证限流模式下重试的排布间隔）
      if (prompt === "b") return Promise.resolve("done:b");
      const key = `${prompt}:${agentId}`;
      const streak = (failStreak.get(key) ?? 0) + 1;
      failStreak.set(key, streak);
      if (streak <= 2) {
        return Promise.reject(Object.assign(new Error("rate limited"), { status: 429 }));
      }
      return Promise.resolve(`done:${prompt}`);
    });
    const tasks = [task("a", 0), task("b", 1), task("c", 2)];
    const promise = new AgentRunBatch(launcher, tasks).run();

    await vi.advanceTimersByTimeAsync(0);
    expect(launcher.suspendedEvents.length).toBeGreaterThanOrEqual(1);

    await vi.advanceTimersByTimeAsync(60_000);
    const results = await promise;
    expect(results.every((r) => r.status === "completed")).toBe(true);
    // retry 发射间隔 ≥3s（限流退避 + 容量自适应的排布效果）
    expect(launcher.retries.length).toBeGreaterThanOrEqual(2);
    for (let i = 1; i < launcher.retries.length; i++) {
      expect(launcher.retries[i]!.at - launcher.retries[i - 1]!.at).toBeGreaterThanOrEqual(3000);
    }
  });
});

describe("M23 限流恢复退出与退避封顶", () => {
  it("连续 3 次成功后退出限流态：回队任务走正常坡道立即重发（不再等 3s 退避）", async () => {
    vi.useFakeTimers();
    const failed = new Set<string>();
    const launcher = makeLauncher((prompt, agentId) => {
      // a 首次 429；其余立即成功——b/c/d 的连续完成触发限流退出
      if (prompt === "a" && !failed.has(agentId)) {
        failed.add(agentId);
        return Promise.reject(Object.assign(new Error("rate limited"), { status: 429 }));
      }
      return Promise.resolve(`done:${prompt}`);
    });
    const tasks = ["a", "b", "c", "d", "e"].map((p, i) => task(p, i));
    const promise = new AgentRunBatch(launcher, tasks).run();

    const t0 = launcher.spawns[0]!.at;
    // fake timers 下微任务链与计时器推进交织：小步推进直到 retry 发射
    for (let i = 0; i < 12 && launcher.retries.length === 0; i++) {
      await vi.advanceTimersByTimeAsync(100);
    }
    expect(launcher.retries).toHaveLength(1);
    // 限流态已退出：retry 立即发射（远小于 3s 退避）；修复前此处 ≥3000ms
    expect(launcher.retries[0]!.at - t0).toBeLessThan(3000);

    const results = await promise;
    expect(results.every((r) => r.status === "completed")).toBe(true);
  });

  it("退避 3s×2^n 按 30s 封顶（长尾重试不排向无穷远）", async () => {
    vi.useFakeTimers();
    const attemptsByKey = new Map<string, number>();
    const launcher = makeLauncher((prompt, agentId) => {
      // c 立即成功；a/b 各 429 六轮后成功（退避序列 3/6/12/24/30/30s）
      if (prompt === "c") return Promise.resolve("done:c");
      const key = `${prompt}:${agentId}`;
      const n = (attemptsByKey.get(key) ?? 0) + 1;
      attemptsByKey.set(key, n);
      if (n <= 6) {
        return Promise.reject(Object.assign(new Error("rate limited"), { status: 429 }));
      }
      return Promise.resolve(`done:${prompt}`);
    });
    const promise = new AgentRunBatch(launcher, [task("a", 0), task("b", 1), task("c", 2)]).run();

    await vi.advanceTimersByTimeAsync(150_000);
    const results = await promise;
    expect(results.every((r) => r.status === "completed")).toBe(true);

    // 同一任务的相邻发射间隔：3s,6s,12s,24s 后触顶 30s，不再翻倍
    const timesByPrompt = new Map<string, number[]>();
    for (const s of launcher.spawns) timesByPrompt.set(s.prompt, [s.at]);
    for (const r of launcher.retries) timesByPrompt.get(r.prompt)!.push(r.at);
    for (const prompt of ["a", "b"]) {
      const times = timesByPrompt.get(prompt)!.sort((x, y) => x - y);
      expect(times).toHaveLength(7); // 1 spawn + 6 retry
      const gaps = times.slice(1).map((t, i) => t - times[i]!);
      expect(Math.max(...gaps)).toBeLessThanOrEqual(30_000);
      expect(gaps.filter((g) => g === 30_000).length).toBeGreaterThanOrEqual(2);
    }
  });

  it("批次收尾时中止在途 attempt（cleanup 联动 abort，孤儿不空转）", async () => {
    vi.useFakeTimers();
    const attemptSignals: AbortSignal[] = [];
    const launcher = makeLauncher(() => new Promise<string>(() => {}));
    const baseSpawn = launcher.spawn;
    launcher.spawn = (o) => {
      attemptSignals.push(o.signal);
      return baseSpawn(o);
    };
    const batchController = new AbortController();
    const tasks = [task("x", 0), task("y", 1)].map((t) => ({
      ...t,
      signal: batchController.signal,
    }));
    const promise = new AgentRunBatch(launcher, tasks).run();
    await vi.advanceTimersByTimeAsync(0);
    expect(attemptSignals).toHaveLength(2);

    // 用户取消：批次即刻收尾，在途 attempt 的 signal 全部中止
    batchController.abort(Object.assign(new Error("user cancel"), { name: "AbortError" }));
    const results = await promise;
    expect(results.every((r) => r.status === "aborted")).toBe(true);
    expect(attemptSignals.every((s) => s.aborted)).toBe(true);
  });
});
