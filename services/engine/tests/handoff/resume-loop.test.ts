/**
 * 换班续跑循环（水位撞顶=换班不死）：
 * ① 交接书 → scheduled → 延迟后 enqueueResume（带 abort signal）；
 * ② 棒数保险丝：shift >= maxShifts → fused，不再入队；
 * ③ 续跑正常完成 → completed；续跑再撞顶 → 链继续（下一棒接管，旧 job 收尾不误标）；
 * ④ 用户消息 cancel：清定时器 + abort 在途 job + 控制面 aborted（排队未启动的 job 被 signal 拦下）；
 * ⑤ running 期 REST 打断（loop 注册表 cancelAll）：abort 在途 job，收尾不覆盖回 completed；
 * ⑥ 落盘窗口内 abort（handleBook 复核 pending）：不复活为 scheduled。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { HandoffManager } from "../../src/handoff/manager.js";
import { HandoffResumeLoop } from "../../src/handoff/resume-loop.js";
import { HandoffLoopRegistry } from "../../src/handoff/registry.js";
import type { HandoffBookInfo, HandoffRecord } from "../../src/handoff/types.js";
import { restoreDataDir } from "../helpers/env.js";

function bookInfo(overrides: Partial<HandoffBookInfo> = {}): HandoffBookInfo {
  return {
    agentId: "a1",
    sessionId: "s1",
    reason: "watermark",
    shift: 1,
    maxShifts: 3,
    used: 950,
    window: 1000,
    bookMessageId: "msg_book",
    bookText: "[交接书] 换班移交（第 1/3 棒）",
    ...overrides,
  };
}

let tmpDir: string;
let originalDataDir: string | undefined;
let manager: HandoffManager;
const enqueued: Array<{
  record: HandoffRecord;
  signal: AbortSignal;
  jobId: string;
  chainId?: string;
}> = [];
const updates: string[] = [];

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "handoff-loop-test-"));
  originalDataDir = process.env.CLOUDMIND_DATA_DIR;
  process.env.CLOUDMIND_DATA_DIR = tmpDir;
  // 内存 store：续跑循环测试只关心时序/状态机，绕开 fake timer 与真实文件 I/O 的交互
  manager = new HandoffManager({
    store: {
      loadAll: async () => [],
      save: async () => {},
      markActiveAsLost: async () => 0,
    } as never,
  });
  enqueued.length = 0;
  updates.length = 0;
  vi.useFakeTimers();
});

afterEach(async () => {
  vi.useRealTimers();
  restoreDataDir(originalDataDir);
  await fs.rm(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
});

function makeLoop(delayMs = 50): HandoffResumeLoop {
  return new HandoffResumeLoop({
    manager,
    delayMs,
    enqueueResume: (record, signal, jobId, chainId) => {
      enqueued.push({ record, signal, jobId, chainId });
    },
    onUpdate: (record) => {
      updates.push(`${record.status}:${record.shift}`);
    },
  });
}

describe("HandoffResumeLoop 续跑循环", () => {
  it("交接书 → scheduled → 延迟后 enqueueResume（带可打断 signal）", async () => {
    const loop = makeLoop();
    await loop.onWatermarkBook(bookInfo());
    expect(manager.activeFor("a1", "s1")).toMatchObject({ status: "scheduled", shift: 1 });

    await vi.advanceTimersByTimeAsync(50);
    await vi.waitFor(() => expect(enqueued).toHaveLength(1));
    expect(manager.activeFor("a1", "s1")).toMatchObject({ status: "running", shift: 1 });
    expect(enqueued[0]!.record.id).toBe("ho_a1_s1");
    expect(enqueued[0]!.signal.aborted).toBe(false);
    // resumeJobId 接线：控制面 running 记录与 worker job id 同源（P3 顺手包）
    expect(manager.get("ho_a1_s1")?.resumeJobId).toBe(enqueued[0]!.jobId);
    // 状态帧序列：pending → scheduled → running（前端横幅随帧可见）
    expect(updates).toEqual(["pending:1", "scheduled:1", "running:1"]);
  });

  it("棒数保险丝：shift >= maxShifts → fused，不再入队", async () => {
    const loop = makeLoop();
    await loop.onWatermarkBook(bookInfo({ shift: 3, maxShifts: 3 }));
    await vi.advanceTimersByTimeAsync(100);
    expect(manager.get("ho_a1_s1")).toMatchObject({ status: "fused", shift: 3 });
    expect(enqueued).toHaveLength(0);
  });

  it("续跑正常完成 → completed；再撞顶 → 下一棒接管，旧 job 收尾不误标新棒", async () => {
    const loop = makeLoop();
    await loop.onWatermarkBook(bookInfo());
    await vi.advanceTimersByTimeAsync(50);
    await vi.waitFor(() => expect(enqueued).toHaveLength(1));
    const first = enqueued[0]!.record;

    // 续跑 job 再撞顶：book 事件到达（新棒替换 current 并调度）
    await loop.onWatermarkBook(bookInfo({ shift: 2 }));
    // 旧 job 收尾（无错）：current 已是新棒，不得把新棒标 completed
    await loop.onJobDone(first, "a1", "s1");
    expect(manager.get("ho_a1_s1")).toMatchObject({ status: "scheduled", shift: 2 });

    // 第二棒入队并正常完成：链结束
    await vi.advanceTimersByTimeAsync(50);
    await vi.waitFor(() => expect(enqueued).toHaveLength(2));
    const second = enqueued[1]!.record;
    await loop.onJobDone(second, "a1", "s1");
    expect(manager.get("ho_a1_s1")).toMatchObject({ status: "completed", shift: 2 });
  });

  it("用户消息 cancel：清定时器 + abort 在途 job + 控制面 aborted", async () => {
    const loop = makeLoop();
    await loop.onWatermarkBook(bookInfo());
    await vi.advanceTimersByTimeAsync(50);
    await vi.waitFor(() => expect(enqueued).toHaveLength(1));

    await loop.cancel("a1", "s1", "user_message");
    expect(enqueued[0]!.signal.aborted).toBe(true);
    expect(manager.get("ho_a1_s1")).toMatchObject({ status: "aborted", abortReason: "user_message" });

    // cancel 后不再有新的续跑（定时器已清）
    await vi.advanceTimersByTimeAsync(1000);
    expect(enqueued).toHaveLength(1);
  });

  it("scheduled 阶段用户消息 cancel：定时器清除，不产生续跑 job", async () => {
    const loop = makeLoop(1000);
    await loop.onWatermarkBook(bookInfo());
    expect(manager.activeFor("a1", "s1")?.status).toBe("scheduled");

    await loop.cancel("a1", "s1", "user_message");
    await vi.advanceTimersByTimeAsync(2000);
    expect(enqueued).toHaveLength(0);
    expect(manager.get("ho_a1_s1")).toMatchObject({ status: "aborted" });
  });

  it("REST 手动打断（外部改状态）后定时器到点不入队（入队前复核）", async () => {
    const loop = makeLoop(1000);
    await loop.onWatermarkBook(bookInfo());
    expect(manager.activeFor("a1", "s1")?.status).toBe("scheduled");

    // 外部路径（REST DELETE /handoff/:id）直接改控制面，loop 定时器仍在
    await manager.abort("ho_a1_s1", "manual");
    await vi.advanceTimersByTimeAsync(2000);
    expect(enqueued).toHaveLength(0);
    expect(manager.get("ho_a1_s1")).toMatchObject({ status: "aborted", abortReason: "manual" });
  });

  it("running 期 REST 打断：registry.cancelAll abort 在途 job，收尾不覆盖回 completed（P1-1）", async () => {
    const loop = makeLoop();
    const registry = new HandoffLoopRegistry();
    registry.register("a1", "s1", loop);
    await loop.onWatermarkBook(bookInfo());
    await vi.advanceTimersByTimeAsync(50);
    await vi.waitFor(() => expect(enqueued).toHaveLength(1));
    const record = enqueued[0]!.record;

    // REST DELETE /handoff/:id 走的就是这个入口（route → cancelAll → loop.cancel）
    await registry.cancelAll("a1", "s1", "manual");
    expect(enqueued[0]!.signal.aborted).toBe(true);
    expect(manager.get("ho_a1_s1")).toMatchObject({ status: "aborted", abortReason: "manual" });

    // 在途 job 收尾：不得把 aborted 覆盖回 completed（转移表 + current 已清双防线）
    await loop.onJobDone(record, "a1", "s1");
    expect(manager.get("ho_a1_s1")).toMatchObject({ status: "aborted", abortReason: "manual" });
    await vi.advanceTimersByTimeAsync(1000);
    expect(enqueued).toHaveLength(1);
  });

  it("落盘窗口内 abort：handleBook 复核 pending 不复活为 scheduled（P1-2）", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const save = vi.fn(() => gate);
    const gatedManager = new HandoffManager({
      store: {
        loadAll: async () => [],
        save,
        markActiveAsLost: async () => 0,
      } as never,
    });
    const loop = new HandoffResumeLoop({
      manager: gatedManager,
      delayMs: 50,
      enqueueResume: (record, signal, jobId, chainId) => {
        enqueued.push({ record, signal, jobId, chainId });
      },
      onUpdate: (record) => updates.push(`${record.status}:${record.shift}`),
    });

    // book 事件已触发、manager.record 卡在落盘（save 门闩）时用户消息到达
    const bookPromise = loop.onWatermarkBook(bookInfo());
    await vi.waitFor(() => expect(save).toHaveBeenCalled());
    const cancelPromise = loop.cancel("a1", "s1", "user_message");
    release();
    await Promise.all([bookPromise, cancelPromise]);

    // 控制面保持 aborted，600ms 后没有续跑 job
    expect(gatedManager.get("ho_a1_s1")).toMatchObject({
      status: "aborted",
      abortReason: "user_message",
    });
    await vi.advanceTimersByTimeAsync(1000);
    expect(enqueued).toHaveLength(0);
  });

  it("A1 ghost 闩锁：handleBook 入口复核 aborted 条目，迟到交接书不复活不调度", async () => {
    const loop = makeLoop(50);
    await loop.onWatermarkBook(bookInfo());
    expect(manager.get("ho_a1_s1")?.status).toBe("scheduled");
    // 用户消息/断连打断：控制面标 aborted
    await manager.abort("ho_a1_s1", "user_message");
    expect(manager.get("ho_a1_s1")).toMatchObject({ status: "aborted" });

    // 在途 job 的迟到交接书（同棒次）到达：入口直接返回，record 不得覆盖成 pending
    await loop.onWatermarkBook(bookInfo());
    expect(manager.get("ho_a1_s1")).toMatchObject({
      status: "aborted",
      abortReason: "user_message",
    });
    await vi.advanceTimersByTimeAsync(2000);
    expect(enqueued).toHaveLength(0);
    expect(updates.filter((u) => u.startsWith("pending:"))).toHaveLength(1);
  });

  it("A1 代际闩锁（F1）：abort 后新链 book 正常调度续跑；旧链迟到 book 两阶段均被拦", async () => {
    const loop = makeLoop(50);
    // 首棒：新用户消息签发新链代际
    const oldChainId = loop.beginNewChain();
    await loop.onWatermarkBook(bookInfo({ chainId: oldChainId }));
    expect(manager.get("ho_a1_s1")).toMatchObject({ status: "scheduled", shift: 1 });
    await vi.advanceTimersByTimeAsync(50);
    await vi.waitFor(() => expect(enqueued).toHaveLength(1));
    expect(enqueued[0]!.chainId).toBe(oldChainId);

    // 用户消息打断旧链：作废旧代际，控制面标 aborted
    await loop.cancel("a1", "s1", "user_message");
    expect(manager.get("ho_a1_s1")).toMatchObject({ status: "aborted" });

    // 旧链在途 job 的迟到 book（旧代际）到达：入口拦，不复活不调度
    await loop.onWatermarkBook(bookInfo({ shift: 2, chainId: oldChainId }));
    expect(manager.get("ho_a1_s1")).toMatchObject({ status: "aborted" });
    expect(enqueued).toHaveLength(1);

    // abort 后新用户消息新链：beginNewChain 换新代际，新 job 撞顶 book 正常 record
    const newChainId = loop.beginNewChain();
    await loop.onWatermarkBook(bookInfo({ shift: 1, chainId: newChainId }));
    expect(manager.get("ho_a1_s1")).toMatchObject({ status: "scheduled", shift: 1 });
    await vi.advanceTimersByTimeAsync(50);
    await vi.waitFor(() => expect(enqueued).toHaveLength(2));
    expect(enqueued[1]!.record).toMatchObject({ status: "running", shift: 1 });
    expect(enqueued[1]!.chainId).toBe(newChainId);

    // 新链已 record 后，旧链迟到 book 再到达：状态已非 aborted，但代际不符仍被拦
    await loop.onWatermarkBook(bookInfo({ shift: 2, chainId: oldChainId }));
    expect(manager.get("ho_a1_s1")).toMatchObject({ status: "running", shift: 1 });
    expect(enqueued).toHaveLength(2);
  });

  it("续跑异常（非 abort）→ 控制面 aborted，链结束", async () => {
    const loop = makeLoop();
    await loop.onWatermarkBook(bookInfo());
    await vi.advanceTimersByTimeAsync(50);
    await vi.waitFor(() => expect(enqueued).toHaveLength(1));
    const record = enqueued[0]!.record;
    await loop.onJobDone(record, "a1", "s1", new Error("boom"));
    expect(manager.get("ho_a1_s1")).toMatchObject({ status: "aborted", abortReason: "resume_failed" });
  });

  it("交接书事件先于旧 job 收尾：onJobDone 不误标 completed（booked 防闪回）", async () => {
    const loop = makeLoop();
    await loop.onWatermarkBook(bookInfo());
    await vi.advanceTimersByTimeAsync(50);
    await vi.waitFor(() => expect(enqueued).toHaveLength(1));
    const first = enqueued[0]!.record;

    // 不 await：模拟真实时序（book 事件先到、handleBook 落盘未完成时 onDone 已触发）
    const bookPromise = loop.onWatermarkBook(bookInfo({ shift: 2 }));
    await loop.onJobDone(first, "a1", "s1");
    // onDone 已跳过 completed；handleBook 完成后进入 scheduled
    await bookPromise;
    expect(manager.get("ho_a1_s1")).toMatchObject({ status: "scheduled", shift: 2 });
  });
});
