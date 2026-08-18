import { describe, it, expect, vi } from "vitest";
import { gracefulShutdown, registerShutdownHandlers } from "../src/shutdown.js";
import { CompressionQueue } from "../src/memory/topic/queue.js";
import type { TopicSegment } from "../src/memory/topic/types.js";

function seg(topicId: string): TopicSegment {
  return {
    topicId,
    messages: [
      {
        id: "m1",
        role: "user",
        content: [{ type: "text", text: "内容" }],
        createdAt: "2026-07-24T10:00:00.000Z",
      },
    ],
    sourceId: "s1",
    startedAt: "2026-07-24T10:00:00.000Z",
    endedAt: "2026-07-24T10:00:00.000Z",
    archiveOnly: true,
  };
}

describe("gracefulShutdown 优雅关停（P1-2）", () => {
  it("SIGTERM 路径：drain 被调用，pending 压缩完成后才 close/exit", async () => {
    const order: string[] = [];
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    // 真实 CompressionQueue：pending 任务被 gate 卡住，模拟压缩进行中收到关停信号
    const queue = new CompressionQueue(async () => {
      order.push("task-start");
      await gate;
      order.push("task-done");
    });
    queue.enqueue(seg("t1"));

    const shutdownDone = gracefulShutdown({
      drain: () => queue.drain(),
      close: async () => {
        order.push("close");
      },
      timeoutMs: 5000,
      exit: (code) => order.push(`exit-${code}`),
      log: () => {},
    });

    // drain 进行中：压缩未完成，不得 close/exit
    await new Promise((r) => setTimeout(r, 50));
    expect(order).toEqual(["task-start"]);

    release();
    await shutdownDone;
    expect(order).toEqual(["task-start", "task-done", "close", "exit-0"]);
  });

  it("drain 超时：超时也退，不卡死关停", async () => {
    const exit = vi.fn();
    const close = vi.fn(async () => {});
    const logs: string[] = [];
    await gracefulShutdown({
      drain: () => new Promise(() => {}), // 永不完成的压缩
      close,
      timeoutMs: 50,
      exit,
      log: (msg) => logs.push(msg),
    });
    expect(exit).toHaveBeenCalledWith(0);
    expect(close).toHaveBeenCalled();
    expect(logs.some((m) => m.includes("drain 未在 50ms 内完成"))).toBe(true);
  });

  it("close 永久不 resolve：closeTimeoutMs 后仍 exit(0)", async () => {
    const exit = vi.fn();
    const logs: string[] = [];
    await gracefulShutdown({
      drain: async () => {},
      close: () => new Promise(() => {}), // 永不完成的关闭（如 WebSocket 长连接挂住 app.close()）
      closeTimeoutMs: 50,
      exit,
      log: (msg) => logs.push(msg),
    });
    expect(exit).toHaveBeenCalledWith(0);
    expect(logs.some((m) => m.includes("close 未在 50ms 内完成"))).toBe(true);
  });

  it("close 默认超时 5s 兜底（fake timers）", async () => {
    vi.useFakeTimers();
    try {
      const exit = vi.fn();
      const done = gracefulShutdown({
        drain: async () => {},
        close: () => new Promise(() => {}),
        exit,
        log: () => {},
      });
      await vi.advanceTimersByTimeAsync(5_000);
      await done;
      expect(exit).toHaveBeenCalledWith(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("stop 在 drain 之前调用，drain 在 close 之前", async () => {
    const order: string[] = [];
    await gracefulShutdown({
      stop: () => {
        order.push("stop");
      },
      drain: async () => {
        order.push("drain");
      },
      close: async () => {
        order.push("close");
      },
      exit: (code) => order.push(`exit-${code}`),
      log: () => {},
    });
    expect(order).toEqual(["stop", "drain", "close", "exit-0"]);
  });

  it("stop 抛错不阻断关停，仍走到 exit(0)", async () => {
    const exit = vi.fn();
    const order: string[] = [];
    await gracefulShutdown({
      stop: () => {
        throw new Error("stop boom");
      },
      drain: async () => {
        order.push("drain");
      },
      close: async () => {
        order.push("close");
      },
      exit,
      log: () => {},
    });
    expect(order).toEqual(["drain", "close"]);
    expect(exit).toHaveBeenCalledWith(0);
  });

  it("drain 自身失败不阻断退出，且文案与超时区分（失败 ≠ 超时）", async () => {
    const exit = vi.fn();
    const logs: string[] = [];
    await gracefulShutdown({
      drain: async () => {
        throw new Error("drain boom");
      },
      close: async () => {},
      timeoutMs: 5000,
      exit,
      log: (msg) => logs.push(msg),
    });
    expect(exit).toHaveBeenCalledWith(0);
    // 失败路径：带原因、不提时间窗
    expect(logs.some((m) => m.includes("drain 自身失败（非超时）") && m.includes("drain boom"))).toBe(true);
    expect(logs.some((m) => m.includes("drain 未在"))).toBe(false);
  });

  it("close 自身失败不阻断退出，且文案与超时区分（失败 ≠ 超时）", async () => {
    const exit = vi.fn();
    const logs: string[] = [];
    await gracefulShutdown({
      drain: async () => {},
      close: async () => {
        throw new Error("close boom");
      },
      closeTimeoutMs: 5000,
      exit,
      log: (msg) => logs.push(msg),
    });
    expect(exit).toHaveBeenCalledWith(0);
    expect(logs.some((m) => m.includes("close 自身失败（非超时）") && m.includes("close boom"))).toBe(true);
    expect(logs.some((m) => m.includes("close 未在"))).toBe(false);
  });
});

describe("registerShutdownHandlers", () => {
  it("SIGTERM/SIGINT 触发关停，重复信号幂等", async () => {
    const drain = vi.fn(async () => {});
    const exit = vi.fn();
    const unregister = registerShutdownHandlers({
      drain,
      close: async () => {},
      exit,
      log: () => {},
    });
    try {
      process.emit("SIGTERM");
      process.emit("SIGINT"); // 已在关停中，不得重复执行
      await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(0));
      expect(drain).toHaveBeenCalledTimes(1);
    } finally {
      unregister();
    }
  });
});
