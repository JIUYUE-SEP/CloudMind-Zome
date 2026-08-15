import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { LLMProvider, LLMEvent } from "../../src/provider/types.js";
import { MessageRepository } from "../../src/memory/repositories/message.js";
import type { ChatMessageRecord } from "../../src/memory/repositories/types.js";
import { reconcilePendingSegments } from "../../src/memory/reconcile.js";
import type { CompressionTaskDeps } from "../../src/memory/topic/compression-task.js";
import {
  addPendingSegment,
  loadTopicState,
  removePendingSegment,
  saveTopicState,
  type PendingSegmentSnapshot,
} from "../../src/memory/topic/state.js";
import { archivedMessageIds, writeCompressedTopic } from "../../src/memory/topic/store.js";
import { withLLMCallRecording } from "../../src/plugins/llm/record-calls.js";
import { mindService } from "../../src/plugins/mind/index.js";
import { LLMCallRepository } from "../../src/memory/repositories/llm-call.js";
import { restoreDataDir } from "../helpers/env.js";

class CountingProvider implements LLMProvider {
  name = "counting";
  calls = 0;
  constructor(private reply: string) {}
  supportsModel() {
    return true;
  }
  async *chat(): AsyncIterable<LLMEvent> {
    this.calls++;
    yield { type: "text.delta", delta: this.reply };
    yield { type: "step.end" };
  }
}

class FailingProvider implements LLMProvider {
  name = "failing";
  supportsModel() {
    return true;
  }
  async *chat(): AsyncIterable<LLMEvent> {
    throw new Error("provider down");
  }
}

function makeMsg(id: string, sessionId = "s1"): ChatMessageRecord {
  return {
    id,
    sessionId,
    role: "user",
    content: [{ type: "text", text: `消息 ${id}` }],
    createdAt: "2026-07-24T10:00:00.000Z",
  };
}

function makePending(topicId: string, ids: string[], archiveOnly: boolean): PendingSegmentSnapshot {
  return {
    topicId,
    messageIds: ids,
    startedAt: "2026-07-24T10:00:00.000Z",
    endedAt: "2026-07-24T10:10:00.000Z",
    sourceId: "s1",
    archiveOnly,
  };
}

function deps(repo: MessageRepository, provider: LLMProvider): CompressionTaskDeps {
  return { agentId: "a1", provider, model: "mock-model", messageRepository: repo, mind: mindService };
}

describe("reconcilePendingSegments 已入队未压缩段对账（M-b）", () => {
  let tmpDir: string;
  let originalDataDir: string | undefined;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "reconcile-pending-test-"));
    originalDataDir = process.env.CLOUDMIND_DATA_DIR;
    process.env.CLOUDMIND_DATA_DIR = tmpDir;
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
    restoreDataDir(originalDataDir);
  });

  async function seedPending(ids: string[], archiveOnly: boolean, topicId = "tp_pending_1"): Promise<MessageRepository> {
    const repo = new MessageRepository("a1");
    for (const id of ids) await repo.append(makeMsg(id));
    await saveTopicState("a1", null);
    await addPendingSegment("a1", makePending(topicId, ids, archiveOnly));
    return repo;
  }

  it("长 pending 段：LLM 补压缩并归档，pending 清除，状态文件删除", async () => {
    const ids = ["m1", "m2", "m3", "m4"]; // ≥ MIN_SEGMENT_MESSAGES(4)
    const provider = new CountingProvider("话题主题：入队后崩溃\n关键结论：\n- 结论一");
    const repo = await seedPending(ids, false);

    const count = await reconcilePendingSegments("a1", repo, deps(repo, provider));
    expect(count).toBe(4);
    // 方案 C：压缩前复核一次 + 压缩一次（同一 CountingProvider 对复核 prompt
    // 也返回摘要文本，解析失败按单话题兜底，仍走一次压缩）
    expect(provider.calls).toBe(2);
    expect(await repo.listBySession("s1")).toEqual([]);
    expect(await archivedMessageIds("a1")).toEqual(new Set(ids));
    expect(await loadTopicState("a1")).toBeUndefined();
  });

  it("archiveOnly 短段：不调用 LLM 仅归档", async () => {
    const provider = new CountingProvider("不该被调用");
    const repo = await seedPending(["m1", "m2"], true);

    const count = await reconcilePendingSegments("a1", repo, deps(repo, provider));
    expect(count).toBe(2);
    expect(provider.calls).toBe(0);
    expect((await repo.getArchivedByIds(["m1", "m2"])).map((m) => m.id).sort()).toEqual(["m1", "m2"]);
    expect(await loadTopicState("a1")).toBeUndefined();
  });

  it("压缩档已存在（崩溃在写档与归档之间）：只补归档，不重复压缩", async () => {
    const ids = ["m1", "m2", "m3", "m4"];
    const provider = new CountingProvider("不该被调用");
    const repo = await seedPending(ids, false, "tp_1000_crashed");
    // 崩溃现场：压缩档已写出，archiveAndRemove 未执行
    await writeCompressedTopic("a1", {
      topicId: "tp_1000_crashed",
      label: "已写档",
      summary: "摘要",
      keyPoints: [],
      msgIds: ids,
      msgCount: ids.length,
      importance: "normal",
      sourceId: "s1",
      compressedAt: new Date().toISOString(),
    });

    const count = await reconcilePendingSegments("a1", repo, deps(repo, provider));
    expect(count).toBe(4);
    expect(provider.calls).toBe(0); // 不重复调用 LLM
    expect(await repo.listBySession("s1")).toEqual([]);
    expect(await loadTopicState("a1")).toBeUndefined();
  });

  it("消息已全部归档（任务完成、pending 未清）：仅清记录，不调 LLM", async () => {
    const provider = new CountingProvider("不该被调用");
    const repo = await seedPending(["m1", "m2"], true);
    await repo.archiveAndRemove(["m1", "m2"]); // 任务实际已完成

    const count = await reconcilePendingSegments("a1", repo, deps(repo, provider));
    expect(count).toBe(0);
    expect(provider.calls).toBe(0);
    expect(await loadTopicState("a1")).toBeUndefined();
  });

  it("压缩失败：pending 与热存储保留（下次启动重试，不丢消息）", async () => {
    const ids = ["m1", "m2", "m3", "m4"];
    const repo = await seedPending(ids, false, "tp_pending_fail");

    await expect(
      reconcilePendingSegments("a1", repo, deps(repo, new FailingProvider())),
    ).rejects.toThrow("provider down");
    expect((await loadTopicState("a1"))?.pending?.map((p) => p.topicId)).toEqual(["tp_pending_fail"]);
    expect((await repo.listBySession("s1")).map((m) => m.id)).toEqual(ids);
  });

  it("无 pending：0 条，状态文件不动", async () => {
    const repo = new MessageRepository("a1");
    await saveTopicState("a1", { messageIds: ["x"], startedAt: "t", sourceId: "s1" });
    const count = await reconcilePendingSegments("a1", repo, deps(repo, new CountingProvider("x")));
    expect(count).toBe(0);
    expect((await loadTopicState("a1"))?.open?.messageIds).toEqual(["x"]);
  });

  it("open 与 pending 并存：pending 照常收尸归档，open 原样保留", async () => {
    const repo = new MessageRepository("a1");
    for (const id of ["o1", "o2"]) await repo.append(makeMsg(id, "open-s"));
    for (const id of ["p1", "p2"]) await repo.append(makeMsg(id));
    await saveTopicState("a1", {
      messageIds: ["o1", "o2"],
      startedAt: "2026-07-24T10:00:00.000Z",
      sourceId: "open-s",
    });
    await addPendingSegment("a1", makePending("tp_mixed", ["p1", "p2"], true));
    const provider = new CountingProvider("不该被调用");

    const count = await reconcilePendingSegments("a1", repo, deps(repo, provider));
    expect(count).toBe(2);
    expect(provider.calls).toBe(0);
    // pending 已归档收尸
    expect(await repo.listBySession("s1")).toEqual([]);
    expect((await loadTopicState("a1"))?.pending ?? []).toHaveLength(0);
    // open 话题不受 pending 收尸影响：热存储与状态原样保留
    expect((await repo.listBySession("open-s")).map((m) => m.id)).toEqual(["o1", "o2"]);
    expect((await loadTopicState("a1"))?.open?.messageIds).toEqual(["o1", "o2"]);
  });

  it("reconcile 路径 provider 经 withLLMCallRecording 包装后 LLM 调用落档（P4 Minor-2）", async () => {
    const ids = ["m1", "m2", "m3", "m4"]; // ≥ MIN_SEGMENT_MESSAGES(4)：触发真实 LLM 压缩调用
    const repo = await seedPending(ids, false, "tp_recorded");
    const callRepo = new LLMCallRepository("a1");
    // 与 bootstrap.ts reconcile 路径同款接线：裸 provider 包装落档装饰器
    const recorded = withLLMCallRecording(
      new CountingProvider("话题主题：x\n关键结论：\n- y"),
      callRepo,
      "a1",
    );

    const count = await reconcilePendingSegments("a1", repo, deps(repo, recorded));
    expect(count).toBe(4);

    // 落档 fire-and-forget：等写盘完成再断言
    await vi.waitFor(async () => {
      expect((await callRepo.list()).length).toBe(2);
    });
    const [record] = await callRepo.list();
    expect(record).toMatchObject({ agentId: "a1", provider: "counting", model: "mock-model", status: "ok" });
  });

  it("state 读写串行：open 更新不丢 pending，pending 清除不丢 open", async () => {
    await saveTopicState("a1", { messageIds: ["m1"], startedAt: "t", sourceId: "s1" });
    await addPendingSegment("a1", makePending("tp_1", ["a", "b"], true));
    // 并发触发两类更新（turn 终点 open:null 与 pending 入队/清除的真实交错）
    await Promise.all([
      saveTopicState("a1", null),
      addPendingSegment("a1", makePending("tp_2", ["c"], true)),
      removePendingSegment("a1", "tp_1"),
    ]);
    const state = await loadTopicState("a1");
    expect(state?.open).toBeNull();
    expect(state?.pending?.map((p) => p.topicId)).toEqual(["tp_2"]);
  });

  it("模拟关闭入队后崩溃、重启 N 次：热存储有界，孤儿全部有出路", async () => {
    const provider = new CountingProvider("话题主题：x\n关键结论：\n- y");
    const allIds: string[] = [];
    for (let round = 0; round < 5; round++) {
      // 第 round 次"崩溃"现场：段已关闭入队（pending 已记），压缩未执行
      const repo = new MessageRepository("a1");
      const ids = [`r${round}_m1`, `r${round}_m2`, `r${round}_m3`];
      allIds.push(...ids);
      for (const id of ids) await repo.append(makeMsg(id));
      await saveTopicState("a1", null);
      await addPendingSegment("a1", makePending(`tp_r${round}`, ids, true));

      // 模拟重启：启动对账补漏
      const count = await reconcilePendingSegments("a1", repo, deps(repo, provider));
      expect(count).toBe(3);
      expect(await repo.listBySession("s1")).toEqual([]); // 每次重启后热存储清空
      expect(provider.calls).toBe(0); // archiveOnly 全程不调 LLM
    }
    const repo = new MessageRepository("a1");
    expect(await repo.listBySession("s1")).toEqual([]);
    expect(await repo.getArchivedByIds(allIds)).toHaveLength(15);
    expect(await loadTopicState("a1")).toBeUndefined();
  });
});
