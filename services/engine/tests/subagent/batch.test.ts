/**
 * SubagentBatch（旧骨架对外形状）换核后的语义：
 * 原位聚合保持；泛型失败不再本地重试（错误原位落结果），
 * 429 限流由内核自适应回队续跑（fake timers 跳过 3s 退避）。
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { SubagentBatch } from "../../src/subagent/batch.js";
import type { SubagentResult } from "../../src/subagent/types.js";

afterEach(() => {
  vi.useRealTimers();
});

describe("SubagentBatch", () => {
  it("dispatches inputs in parallel and preserves order", async () => {
    const outputs = ["a", "b", "c"];
    const batch = new SubagentBatch(async (input: string) => {
      return { taskId: input, output: `done:${input}` } satisfies SubagentResult;
    });
    const results = await batch.run(outputs, { concurrency: 2 });
    expect(results).toHaveLength(3);
    expect(results.map((r) => r.output)).toEqual(["done:a", "done:b", "done:c"]);
    expect(results.every((r) => r.error === undefined)).toBe(true);
  });

  it("generic failure lands in place（内核只自适应续跑 429，不重试泛型错误）", async () => {
    const batch = new SubagentBatch(async (input: string) => {
      if (input === "bad") throw new Error("transient");
      return { taskId: input, output: `done:${input}` };
    });
    const results = await batch.run(["ok", "bad"]);
    expect(results[0]).toMatchObject({ output: "done:ok" });
    expect(results[1]).toMatchObject({ output: "", error: "transient" });
  });

  it("429 限流由内核回队续跑（同 dispatch 通道，非放弃）", async () => {
    vi.useFakeTimers();
    let attempts = 0;
    // x 挂起闸门：limited 首次 429 时 x 必须还未完成，限流任务才会回队续跑
    // （否则它是"最后一个未完成任务"，按内核语义直接 failed）
    let releaseX: () => void = () => {};
    const xGate = new Promise<SubagentResult>((resolve) => {
      releaseX = () => resolve({ taskId: "x", output: "done:x" });
    });
    const batch = new SubagentBatch(async (input: string) => {
      if (input === "x") return xGate;
      if (attempts++ === 0) {
        throw Object.assign(new Error("too many requests"), { status: 429 });
      }
      return { taskId: input, output: `done:${input}` };
    });
    const promise = batch.run(["x", "limited"]);
    // fake timers 下微任务链与计时器推进交织：小步推进直到回队续跑完成
    releaseX();
    for (let i = 0; i < 16 && attempts < 2; i++) {
      await vi.advanceTimersByTimeAsync(500);
    }
    const results = await promise;
    expect(results[0]).toMatchObject({ output: "done:x" });
    expect(results[1]).toMatchObject({ output: "done:limited" });
    expect(attempts).toBe(2);
  });
});
