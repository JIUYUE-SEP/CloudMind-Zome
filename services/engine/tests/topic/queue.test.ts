import { describe, it, expect, vi, afterEach } from "vitest";
import { logger } from "../../src/logger.js";
import { CompressionQueue } from "../../src/memory/topic/queue.js";
import type { TopicSegment } from "../../src/memory/topic/types.js";

// M13：压缩失败的进程内有限次退避重试——重试按序退避、耗尽告警兜底、
// 串行语义保持（前段退避期间后段不启动）。sleep 注入替身，不走真实时钟。
function seg(topicId: string): TopicSegment {
  return {
    topicId,
    messages: [
      {
        id: `${topicId}-m1`,
        role: "user",
        content: [{ type: "text", text: "内容" }],
        createdAt: "2026-07-24T10:00:00.000Z",
      },
    ],
    sourceId: "s1",
    startedAt: "2026-07-24T10:00:00.000Z",
    endedAt: "2026-07-24T10:05:00.000Z",
  };
}

describe("CompressionQueue 退避重试（M13）", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("成功任务不重试、不告警", async () => {
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
    const run = vi.fn(async () => {});
    const q = new CompressionQueue(run, { retryDelaysMs: [1, 2, 3], sleep: async () => {} });

    q.enqueue(seg("t1"));
    await q.drain();

    expect(run).toHaveBeenCalledTimes(1);
    expect(warn).not.toHaveBeenCalled();
  });

  it("失败后按退避序列重试至成功：sleep 按序、每次重试各 warn 一条", async () => {
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
    const sleeps: number[] = [];
    let calls = 0;
    const run = vi.fn(async () => {
      calls++;
      if (calls < 3) throw new Error("llm down");
    });
    const q = new CompressionQueue(run, {
      retryDelaysMs: [5, 15, 45],
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });

    q.enqueue(seg("t1"));
    await q.drain();

    expect(run).toHaveBeenCalledTimes(3);
    expect(sleeps).toEqual([5, 15]); // 第 3 次尝试成功，不再退避
    // 每次失败重试各一条 warn（含进度字段），无"重试耗尽"告警
    expect(warn).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ attempt: 1, maxAttempts: 4, retryInMs: 5 }),
      expect.stringContaining("后重试"),
    );
    expect(warn).not.toHaveBeenCalledWith(expect.anything(), expect.stringContaining("重试耗尽"));
  });

  it("重试耗尽：1+2 次尝试后 warn 兜底一次，后续任务照常执行", async () => {
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
    const done: string[] = [];
    const run = vi.fn(async (s: TopicSegment) => {
      if (s.topicId === "bad") throw new Error("llm down");
      done.push(s.topicId);
    });
    const q = new CompressionQueue(run, { retryDelaysMs: [1, 2], sleep: async () => {} });

    q.enqueue(seg("bad"));
    q.enqueue(seg("good"));
    await q.drain();

    // bad：首次 + 2 次重试 = 3 次调用（retryDelaysMs 长度 2）
    expect(run.mock.calls.filter(([s]) => s.topicId === "bad")).toHaveLength(3);
    expect(done).toEqual(["good"]);
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.any(Error) }),
      expect.stringContaining("重试耗尽"),
    );
  });

  it("串行语义保持：前段退避期间后段不启动", async () => {
    vi.spyOn(logger, "warn").mockImplementation(() => {});
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const order: string[] = [];
    const run = vi.fn(async (s: TopicSegment) => {
      order.push(`run-${s.topicId}`);
      if (s.topicId === "t1" && order.filter((o) => o === "run-t1").length === 1) {
        throw new Error("boom");
      }
    });
    const q = new CompressionQueue(run, { retryDelaysMs: [10], sleep: () => gate });

    q.enqueue(seg("t1"));
    q.enqueue(seg("t2"));
    // t1 首次失败进入退避（sleep 被 gate 卡住）：t2 不得启动
    await new Promise((r) => setTimeout(r, 20));
    expect(order).toEqual(["run-t1"]);

    release();
    await q.drain();
    expect(order).toEqual(["run-t1", "run-t1", "run-t2"]);
  });

  it("生产默认退避序列为 5s/15s/45s（最多 3 次重试）", async () => {
    vi.spyOn(logger, "warn").mockImplementation(() => {});
    const sleeps: number[] = [];
    const run = vi.fn(async () => {
      throw new Error("always down");
    });
    const q = new CompressionQueue(run, { sleep: async (ms) => void sleeps.push(ms) });

    q.enqueue(seg("t1"));
    await q.drain();

    expect(run).toHaveBeenCalledTimes(4);
    expect(sleeps).toEqual([5_000, 15_000, 45_000]);
  });
});
