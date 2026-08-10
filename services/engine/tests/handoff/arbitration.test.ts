/**
 * handoff 仲裁统一设计（2026-08-10）验收场景：
 * V1 双 tab：B 发消息全局 cancel → A 链 job 迟到完成不 throw 不崩溃不污染（warn 记档）
 * V2 背靠背：连发两条消息共用代际 → 第一条撞顶 book 被闩锁放行（P1-4 回归）
 * V3 半开重连：旧连接迟到 close 不杀新连接活跃链（连接级 cancel 只作用本连接资源）
 * V4 重启后闩锁：chainId 持久化 → 旧 chainId 迟到 book 被拦、reconcile 语义不变
 * V5 恶性变体：abort 后新链接管，旧链迟到 onJobDone 不污染新链状态
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { HandoffManager } from "../../src/handoff/manager.js";
import { HandoffResumeLoop } from "../../src/handoff/resume-loop.js";
import { HandoffLoopRegistry } from "../../src/handoff/registry.js";
import { HandoffStateStore } from "../../src/handoff/state.js";
import { logger } from "../../src/logger.js";
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
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "handoff-arbitration-test-"));
  originalDataDir = process.env.CLOUDMIND_DATA_DIR;
  process.env.CLOUDMIND_DATA_DIR = tmpDir;
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

describe("handoff 仲裁统一（V1-V5 验收）", () => {
  it("V1 双 tab：B 发消息全局 cancel → A 链 job 迟到完成不 throw 不崩溃不污染", async () => {
    const registry = new HandoffLoopRegistry();
    const loopA = makeLoop();
    const loopB = makeLoop();
    registry.register("a1", "s1", loopA);
    registry.register("a1", "s1", loopB);

    const chainA = loopA.beginNewChain("a1", "s1");
    await loopA.onWatermarkBook(bookInfo({ chainId: chainA }));
    await vi.advanceTimersByTimeAsync(50);
    await vi.waitFor(() => expect(enqueued).toHaveLength(1));
    const recordA = enqueued[0]!.record;

    // B tab 用户消息 → 统一仲裁面：A/B 两个 loop 资源全取消 + 全局 record aborted
    await registry.cancel("a1", "s1", "user_message");
    expect(enqueued[0]!.signal.aborted).toBe(true);
    expect(manager.get("ho_a1_s1")).toMatchObject({
      status: "aborted",
      abortReason: "user_message",
    });

    // A 的 job 迟到完成：不 throw、不崩溃、不污染
    await expect(loopA.onJobDone(recordA, "a1", "s1")).resolves.toBeUndefined();
    expect(manager.get("ho_a1_s1")).toMatchObject({
      status: "aborted",
      abortReason: "user_message",
    });
    await vi.advanceTimersByTimeAsync(1000);
    expect(enqueued).toHaveLength(1);
  });

  it("V1 防御：onJobDone 入口复核（状态非 running）→ warn 记档、不转移不 throw", async () => {
    const loop = makeLoop();
    const chain = loop.beginNewChain("a1", "s1");
    await loop.onWatermarkBook(bookInfo({ chainId: chain }));
    await vi.advanceTimersByTimeAsync(50);
    await vi.waitFor(() => expect(enqueued).toHaveLength(1));
    const record = enqueued[0]!.record;

    // 外部路径把控制面改成 aborted 而 loop current 仍在（复核窗口竞态）
    await manager.cancel("a1", "s1", "manual");
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
    try {
      await expect(loop.onJobDone(record, "a1", "s1")).resolves.toBeUndefined();
      expect(manager.get("ho_a1_s1")).toMatchObject({ status: "aborted" });
      expect(warn).toHaveBeenCalledWith(
        expect.objectContaining({ recordId: "ho_a1_s1", status: "aborted" }),
        expect.stringContaining("[handoff] onJobDone"),
      );
    } finally {
      warn.mockRestore();
    }
  });

  it("V2 背靠背：无活跃链时连发两条消息共用代际 → 第一条撞顶 book 被闩锁放行", async () => {
    const loop = makeLoop();
    // 前置：上一链 aborted 遗留入口闩锁（P1-4 现场）
    const prevChain = loop.beginNewChain("a1", "s1");
    await loop.onWatermarkBook(bookInfo({ chainId: prevChain }));
    await loop.cancel("a1", "s1", "user_message");
    expect(manager.get("ho_a1_s1")).toMatchObject({ status: "aborted" });

    // 用户连发两条消息：无活跃链 → 不轮换，两条共用同一代际
    const c1 = loop.beginNewChain("a1", "s1");
    const c2 = loop.beginNewChain("a1", "s1");
    expect(c1).toBe(c2);

    // 第一条 job 撞顶产 book：aborted 遗留闩锁放行（代际匹配），正常续跑
    await loop.onWatermarkBook(bookInfo({ chainId: c1 }));
    expect(manager.get("ho_a1_s1")).toMatchObject({ status: "scheduled", shift: 1 });
    await vi.advanceTimersByTimeAsync(50);
    await vi.waitFor(() => expect(enqueued).toHaveLength(1));
    expect(enqueued[0]!.chainId).toBe(c1);
    expect(enqueued[0]!.signal.aborted).toBe(false);
  });

  it("beginNewChain 语义：存在活跃链才轮换；无活跃链沿用/按需生成", async () => {
    const loop = makeLoop();
    const c1 = loop.beginNewChain("a1", "s1");
    await loop.onWatermarkBook(bookInfo({ chainId: c1 }));

    // 活跃链存在（scheduled）：每次 beginNewChain 都轮换
    const c2 = loop.beginNewChain("a1", "s1");
    expect(c2).not.toBe(c1);
    const c3 = loop.beginNewChain("a1", "s1");
    expect(c3).not.toBe(c2);

    // 打断后无活跃链：首次按需生成新代际，随后沿用
    await loop.cancel("a1", "s1", "user_message");
    const c4 = loop.beginNewChain("a1", "s1");
    expect(c4).not.toBe(c3);
    const c5 = loop.beginNewChain("a1", "s1");
    expect(c5).toBe(c4);
  });

  it("V3 半开重连：旧连接迟到 close 不杀新连接活跃链", async () => {
    const registry = new HandoffLoopRegistry();
    const loopOld = makeLoop();
    const loopNew = makeLoop();
    registry.register("a1", "s1", loopOld);

    // 新连接接管活跃链
    const chain = loopNew.beginNewChain("a1", "s1");
    registry.register("a1", "s1", loopNew);
    await loopNew.onWatermarkBook(bookInfo({ chainId: chain }));
    expect(manager.get("ho_a1_s1")).toMatchObject({ status: "scheduled", shift: 1 });

    // 旧连接此刻迟到 close：连接级取消只作用于本连接资源，全局 record 不动
    await registry.cancelConnection("a1", "s1", loopOld, "disconnect");
    expect(manager.get("ho_a1_s1")).toMatchObject({ status: "scheduled", shift: 1 });

    // 新连接的在途 job 未被 abort，续跑照常
    await vi.advanceTimersByTimeAsync(50);
    await vi.waitFor(() => expect(enqueued).toHaveLength(1));
    expect(enqueued[0]!.signal.aborted).toBe(false);
    expect(enqueued[0]!.chainId).toBe(chain);
  });

  it("V3：唯一活跃连接 close（维度内无其他活跃连接）→ 全局 record 一并 aborted", async () => {
    const registry = new HandoffLoopRegistry();
    const loopA = makeLoop();
    const loopB = makeLoop(); // 另一连接存在但不活跃
    registry.register("a1", "s1", loopA);
    registry.register("a1", "s1", loopB);

    const chain = loopA.beginNewChain("a1", "s1");
    await loopA.onWatermarkBook(bookInfo({ chainId: chain }));

    await registry.cancelConnection("a1", "s1", loopA, "disconnect");
    expect(manager.get("ho_a1_s1")).toMatchObject({
      status: "aborted",
      abortReason: "disconnect",
    });

    // 另一连接未受影响，可正常开新链（新代际）
    const bChain = loopB.beginNewChain("a1", "s1");
    expect(bChain).not.toBe(chain);
  });

  it("V4 重启后闩锁：chainId 持久化 → 旧链迟到 book 被拦、reconcile 语义不变", async () => {
    const store = new HandoffStateStore(path.join(tmpDir, "handoff-state.json"));
    const m1 = new HandoffManager({ store });
    const loop1 = new HandoffResumeLoop({
      manager: m1,
      delayMs: 50,
      enqueueResume: (record, signal, jobId, chainId) => {
        enqueued.push({ record, signal, jobId, chainId });
      },
      onUpdate: () => {},
    });
    const chain = loop1.beginNewChain("a1", "s1");
    await loop1.onWatermarkBook(bookInfo({ chainId: chain }));
    await m1.markStatus("ho_a1_s1", "running", { resumeJobId: "job_1" });

    // chainId 落盘（handoff-state.json）
    const onDisk = await store.loadAll();
    expect(onDisk[0]).toMatchObject({ status: "running", chainId: chain });

    // 重启：活跃条目标 lost，chainId 保留（闩锁权威数据不丢）
    const m2 = new HandoffManager({ store });
    await m2.load();
    expect(m2.get("ho_a1_s1")).toMatchObject({
      status: "lost",
      abortReason: "engine_restart",
      chainId: chain,
    });

    const enqueued2: typeof enqueued = [];
    const loop2 = new HandoffResumeLoop({
      manager: m2,
      delayMs: 50,
      enqueueResume: (record, signal, jobId, chainId) => {
        enqueued2.push({ record, signal, jobId, chainId });
      },
      onUpdate: () => {},
    });

    // 旧 chainId 的迟到 book：被拦，不复活不调度（reconcile 语义不变）
    await loop2.onWatermarkBook(bookInfo({ chainId: chain, shift: 2 }));
    expect(m2.get("ho_a1_s1")).toMatchObject({ status: "lost" });
    await vi.advanceTimersByTimeAsync(1000);
    expect(enqueued2).toHaveLength(0);

    // 重启后新链照常：beginNewChain 签发新代际，book 正常 record/scheduled
    const newChain = loop2.beginNewChain("a1", "s1");
    expect(newChain).not.toBe(chain);
    await loop2.onWatermarkBook(bookInfo({ chainId: newChain, shift: 1 }));
    expect(m2.get("ho_a1_s1")).toMatchObject({ status: "scheduled", shift: 1, chainId: newChain });
  });

  it("V5 恶性变体：abort 后新链接管，旧链迟到 onJobDone 不污染新链状态", async () => {
    const loop = makeLoop();
    const oldChain = loop.beginNewChain("a1", "s1");
    await loop.onWatermarkBook(bookInfo({ chainId: oldChain }));
    await vi.advanceTimersByTimeAsync(50);
    await vi.waitFor(() => expect(enqueued).toHaveLength(1));
    const oldRecord = enqueued[0]!.record;

    // abort 旧链 → 新用户消息新链接管（同 id 同 shift，仅代际不同）
    await loop.cancel("a1", "s1", "user_message");
    const newChain = loop.beginNewChain("a1", "s1");
    await loop.onWatermarkBook(bookInfo({ chainId: newChain, shift: 1 }));
    await vi.advanceTimersByTimeAsync(50);
    await vi.waitFor(() => expect(enqueued).toHaveLength(2));
    expect(manager.get("ho_a1_s1")).toMatchObject({ status: "running", chainId: newChain });

    // 旧链迟到完成（无错、非 abort）：代际复核拦截，不污染新链
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
    try {
      await expect(loop.onJobDone(oldRecord, "a1", "s1")).resolves.toBeUndefined();
      expect(manager.get("ho_a1_s1")).toMatchObject({ status: "running", chainId: newChain });
      expect(warn).toHaveBeenCalledWith(
        expect.objectContaining({
          recordChainId: oldChain,
          currentChainId: newChain,
        }),
        expect.stringContaining("旧链迟到完成"),
      );
    } finally {
      warn.mockRestore();
    }
  });
});
