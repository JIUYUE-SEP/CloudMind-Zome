import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { LLMProvider, LLMEvent } from "../../src/provider/types.js";
import { MessageRepository } from "../../src/memory/repositories/message.js";
import type { ChatMessageRecord } from "../../src/memory/repositories/types.js";
import { reconcileOrphanedTopic } from "../../src/memory/reconcile.js";
import { withLLMCallRecording } from "../../src/provider/record-calls.js";
import { LLMCallRepository } from "../../src/memory/repositories/llm-call.js";
import type { CompressionTaskDeps } from "../../src/memory/topic/compression-task.js";
import { loadTopicState, saveTopicState } from "../../src/memory/topic/state.js";
import { archivedMessageIds } from "../../src/memory/topic/store.js";
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

function deps(repo: MessageRepository, provider: LLMProvider): CompressionTaskDeps {
  return { agentId: "a1", provider, model: "mock-model", messageRepository: repo };
}

describe("reconcileOrphanedTopic 重启孤儿对账（P1-2）", () => {
  let tmpDir: string;
  let originalDataDir: string | undefined;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "reconcile-orphan-test-"));
    originalDataDir = process.env.CLOUDMIND_DATA_DIR;
    process.env.CLOUDMIND_DATA_DIR = tmpDir;
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
    restoreDataDir(originalDataDir);
  });

  async function seedOrphans(ids: string[]): Promise<MessageRepository> {
    const repo = new MessageRepository("a1");
    for (const id of ids) await repo.append(makeMsg(id));
    await saveTopicState("a1", {
      messageIds: ids,
      startedAt: "2026-07-24T10:00:00.000Z",
      sourceId: "s1",
    });
    return repo;
  }

  it("短开放话题：archiveOnly 归档，不调用 LLM，清除状态文件", async () => {
    const provider = new CountingProvider("话题主题：不该被调用");
    const repo = await seedOrphans(["m1", "m2"]);

    const count = await reconcileOrphanedTopic("a1", repo, deps(repo, provider));
    expect(count).toBe(2);
    expect(provider.calls).toBe(0); // 短话题与 tracker 同一规则：不浪费 LLM 调用
    expect(await repo.listBySession("s1")).toEqual([]); // 热存储清空
    expect((await repo.getArchivedByIds(["m1", "m2"])).map((m) => m.id).sort()).toEqual(["m1", "m2"]);
    expect(await loadTopicState("a1")).toBeUndefined();
  });

  it("长开放话题：LLM 补压缩并归档，生成压缩档", async () => {
    const ids = ["m1", "m2", "m3", "m4"]; // ≥ MIN_SEGMENT_MESSAGES(4)
    const provider = new CountingProvider("话题主题：重启前的话题\n关键结论：\n- 结论一");
    const repo = await seedOrphans(ids);

    const count = await reconcileOrphanedTopic("a1", repo, deps(repo, provider));
    expect(count).toBe(4);
    expect(provider.calls).toBe(1);
    expect(await repo.listBySession("s1")).toEqual([]);
    // 压缩档存在且指向这些消息（L5 摘要可用，归档排除生效）
    expect(await archivedMessageIds("a1")).toEqual(new Set(ids));
    expect(await loadTopicState("a1")).toBeUndefined();
  });

  it("部分消息已不在热存储：只处理仍在的，不重复归档", async () => {
    // m1 已不在热存储（模拟此前崩溃在"归档 append 完成、热存储删除未完成"之间）
    const repo = new MessageRepository("a1");
    await repo.append(makeMsg("m2"));
    await repo.append(makeMsg("m3"));
    await saveTopicState("a1", {
      messageIds: ["m1", "m2", "m3"],
      startedAt: "2026-07-24T10:00:00.000Z",
      sourceId: "s1",
    });
    const provider = new CountingProvider("x");

    const count = await reconcileOrphanedTopic("a1", repo, deps(repo, provider));
    expect(count).toBe(2);
    expect(await repo.listBySession("s1")).toEqual([]);
  });

  it("无状态文件：0 条，热存储原样保留", async () => {
    const repo = new MessageRepository("a1");
    await repo.append(makeMsg("m1"));
    const provider = new CountingProvider("x");

    const count = await reconcileOrphanedTopic("a1", repo, deps(repo, provider));
    expect(count).toBe(0);
    expect(provider.calls).toBe(0);
    expect((await repo.listBySession("s1")).map((m) => m.id)).toEqual(["m1"]);
  });

  it("压缩失败：保留状态文件与热存储（下次启动重试，不丢消息）", async () => {
    const ids = ["m1", "m2", "m3", "m4"];
    const repo = await seedOrphans(ids);

    await expect(reconcileOrphanedTopic("a1", repo, deps(repo, new FailingProvider()))).rejects.toThrow(
      "provider down",
    );
    expect((await loadTopicState("a1"))?.open?.messageIds).toEqual(ids);
    expect((await repo.listBySession("s1")).map((m) => m.id)).toEqual(ids);
  });

  it("reconcile 路径 provider 经 withLLMCallRecording 包装后 LLM 调用落档（P4 Minor-2）", async () => {
    const ids = ["m1", "m2", "m3", "m4"]; // ≥ MIN_SEGMENT_MESSAGES(4)：触发真实 LLM 压缩调用
    const repo = await seedOrphans(ids);
    const callRepo = new LLMCallRepository("a1");
    // 与 bootstrap.ts reconcile 路径同款接线：裸 provider 包装落档装饰器
    const recorded = withLLMCallRecording(
      new CountingProvider("话题主题：x\n关键结论：\n- y"),
      callRepo,
      "a1",
    );

    const count = await reconcileOrphanedTopic("a1", repo, deps(repo, recorded));
    expect(count).toBe(4);

    // 落档 fire-and-forget：等写盘完成再断言
    await vi.waitFor(async () => {
      expect((await callRepo.list()).length).toBe(1);
    });
    const [record] = await callRepo.list();
    expect(record).toMatchObject({ agentId: "a1", provider: "counting", model: "mock-model", status: "ok" });
  });

  it("模拟崩溃后重启 N 次：热存储消息数有界（修复前随重启次数单调增长）", async () => {
    const provider = new CountingProvider("话题主题：x\n关键结论：\n- y");
    const allIds: string[] = [];
    for (let round = 0; round < 5; round++) {
      // 第 round 次"崩溃"现场：热存储留着一个未关闭话题，tracker 状态已落盘
      const repo = new MessageRepository("a1");
      const ids = [`r${round}_m1`, `r${round}_m2`, `r${round}_m3`];
      allIds.push(...ids);
      for (const id of ids) await repo.append(makeMsg(id));
      await saveTopicState("a1", {
        messageIds: ids,
        startedAt: "2026-07-24T10:00:00.000Z",
        sourceId: "s1",
      });

      // 模拟重启：启动对账处理重启孤儿
      const count = await reconcileOrphanedTopic("a1", repo, deps(repo, provider));
      expect(count).toBe(3);
      // 每次重启后热存储都清空——有界，不随重启次数累积
      expect(await repo.listBySession("s1")).toEqual([]);
    }
    // 5 轮后：热存储仍 0 条；15 条孤儿全部进入归档（有出路，不丢消息）
    const repo = new MessageRepository("a1");
    expect(await repo.listBySession("s1")).toEqual([]);
    expect(await repo.getArchivedByIds(allIds)).toHaveLength(15);
  });
});
