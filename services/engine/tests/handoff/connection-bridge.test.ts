/**
 * 续跑 L3 窗口随棒递减（路线图 §五 D1 欠账）：
 * ① handoffHistoryLimit：首棒 20、逐棒 -5、floor 5（首棒语义不变）；
 * ② 连接桥续跑入队：loadHistory 收到随棒递减的 limit，续跑的是
 *   record.shift+1 棒（record.shift = 刚写完交接书的一棒，语义不变）。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { HandoffManager } from "../../src/handoff/manager.js";
import { HandoffLoopRegistry } from "../../src/handoff/registry.js";
import { HANDOFF_RESUME_DELAY_MS } from "../../src/handoff/types.js";
import type { LLMEvent } from "../../src/provider/types.js";
import type { AgentWorker } from "../../src/core/agent-worker.js";
import {
  HandoffConnectionBridge,
  handoffHistoryLimit,
} from "../../src/plugins/handoff/connection-bridge.js";
import { restoreDataDir } from "../helpers/env.js";

let tmpDir: string;
let originalDataDir: string | undefined;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "handoff-bridge-test-"));
  originalDataDir = process.env.CLOUDMIND_DATA_DIR;
  process.env.CLOUDMIND_DATA_DIR = tmpDir;
  vi.useFakeTimers();
});

afterEach(async () => {
  vi.useRealTimers();
  restoreDataDir(originalDataDir);
  await fs.rm(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
});

function makeHarness(loadHistory: ReturnType<typeof vi.fn>) {
  // 内存 store：本测试只关心连接桥 → loop → enqueue 的接线，不做真实文件 I/O
  const manager = new HandoffManager({
    store: {
      loadAll: async () => [],
      save: async () => {},
      markActiveAsLost: async () => 0,
    } as never,
  });
  const loops = new HandoffLoopRegistry();
  const enqueue = vi.fn();
  const worker = { enqueue } as unknown as AgentWorker;
  const bridge = new HandoffConnectionBridge(
    {
      agentId: "a1",
      sessionId: "s1",
      send: () => {},
      sendJobEvent: () => {},
      loadHistory,
      resolveWorker: async () => undefined,
      fallbackWorker: worker,
    },
    { manager, loops },
  );
  return { bridge, manager, enqueue };
}

function bookEvent(shift: number): LLMEvent {
  return {
    type: "handoff.book",
    shift,
    maxShifts: 10,
    used: 950,
    window: 1000,
    bookMessageId: `msg_book_${shift}`,
    bookText: `[交接书] 换班移交（第 ${shift}/10 棒）`,
  };
}

describe("handoffHistoryLimit 窗口递减", () => {
  it("首棒 20（语义不变）、逐棒 -5、floor 5", () => {
    expect(handoffHistoryLimit(1)).toBe(20);
    expect(handoffHistoryLimit(2)).toBe(15);
    expect(handoffHistoryLimit(3)).toBe(10);
    expect(handoffHistoryLimit(4)).toBe(5);
    // floor：再往后不再递减
    expect(handoffHistoryLimit(5)).toBe(5);
    expect(handoffHistoryLimit(10)).toBe(5);
  });
});

describe("HandoffConnectionBridge 续跑窗口接线", () => {
  it("第 1 棒撞顶 → 续跑第 2 棒：loadHistory 收到 15", async () => {
    const loadHistory = vi.fn(async () => []);
    const { bridge, manager, enqueue } = makeHarness(loadHistory);

    bridge.onEvent(bookEvent(1));
    await vi.waitFor(() =>
      expect(manager.get("ho_a1_s1")).toMatchObject({ status: "scheduled", shift: 1 }),
    );
    await vi.advanceTimersByTimeAsync(HANDOFF_RESUME_DELAY_MS);
    await vi.waitFor(() => expect(enqueue).toHaveBeenCalledTimes(1));

    expect(loadHistory).toHaveBeenCalledWith(15);
    // 续跑棒次语义不变：record.shift + 1
    expect(enqueue.mock.calls[0]![0]).toMatchObject({
      handoffResume: { shift: 2, maxShifts: 10 },
    });
  });

  it("第 3 棒撞顶 → 续跑第 4 棒：loadHistory 收到 5（floor）", async () => {
    const loadHistory = vi.fn(async () => []);
    const { bridge, manager, enqueue } = makeHarness(loadHistory);

    bridge.onEvent(bookEvent(3));
    await vi.waitFor(() =>
      expect(manager.get("ho_a1_s1")).toMatchObject({ status: "scheduled", shift: 3 }),
    );
    await vi.advanceTimersByTimeAsync(HANDOFF_RESUME_DELAY_MS);
    await vi.waitFor(() => expect(enqueue).toHaveBeenCalledTimes(1));

    expect(loadHistory).toHaveBeenCalledWith(5);
    expect(enqueue.mock.calls[0]![0]).toMatchObject({
      handoffResume: { shift: 4, maxShifts: 10 },
    });
  });
});
