import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { LLMProvider, LLMEvent } from "../../src/provider/types.js";
import { MessageRepository } from "../../src/memory/repositories/message.js";
import type { ChatMessageRecord } from "../../src/memory/repositories/types.js";
import { reconcileOrphanedTopic } from "../../src/memory/reconcile.js";
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

describe("reconcileOrphanedTopic 开放话题跳过（真机 #10 方案 2）", () => {
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

  async function seedOpenTopic(ids: string[]): Promise<MessageRepository> {
    const repo = new MessageRepository("a1");
    for (const id of ids) await repo.append(makeMsg(id));
    await saveTopicState("a1", {
      messageIds: ids,
      startedAt: "2026-07-24T10:00:00.000Z",
      sourceId: "s1",
    });
    return repo;
  }

  it("短开放话题：跳过——不归档不调 LLM，热存储与 open 状态原样保留", async () => {
    const provider = new CountingProvider("不该被调用");
    const repo = await seedOpenTopic(["m1", "m2"]);

    const count = await reconcileOrphanedTopic("a1", repo, deps(repo, provider));
    expect(count).toBe(0);
    expect(provider.calls).toBe(0);
    expect((await repo.listBySession("s1")).map((m) => m.id)).toEqual(["m1", "m2"]);
    expect(await repo.getArchivedByIds(["m1", "m2"])).toEqual([]);
    expect((await loadTopicState("a1"))?.open?.messageIds).toEqual(["m1", "m2"]);
  });

  it("长开放话题：同样跳过，不生成压缩档", async () => {
    const ids = ["m1", "m2", "m3", "m4"]; // ≥ MIN_SEGMENT_MESSAGES(4) 也跳过
    const provider = new CountingProvider("不该被调用");
    const repo = await seedOpenTopic(ids);

    const count = await reconcileOrphanedTopic("a1", repo, deps(repo, provider));
    expect(count).toBe(0);
    expect(provider.calls).toBe(0);
    expect((await repo.listBySession("s1")).map((m) => m.id)).toEqual(ids);
    expect(await archivedMessageIds("a1")).toEqual(new Set());
    expect((await loadTopicState("a1"))?.open?.messageIds).toEqual(ids);
  });

  it("部分消息已不在热存储：跳过，状态不消费", async () => {
    const repo = new MessageRepository("a1");
    await repo.append(makeMsg("m2"));
    await repo.append(makeMsg("m3"));
    await saveTopicState("a1", {
      messageIds: ["m1", "m2", "m3"],
      startedAt: "2026-07-24T10:00:00.000Z",
      sourceId: "s1",
    });

    const count = await reconcileOrphanedTopic(
      "a1",
      repo,
      deps(repo, new CountingProvider("x")),
    );
    expect(count).toBe(0);
    // open 状态原样保留（即使部分 id 已不在热存储），不消费不清理
    expect((await loadTopicState("a1"))?.open?.messageIds).toEqual(["m1", "m2", "m3"]);
    expect((await repo.listBySession("s1")).map((m) => m.id)).toEqual(["m2", "m3"]);
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

  it("provider 故障：跳过路径不调用 provider、不抛错", async () => {
    const repo = await seedOpenTopic(["m1", "m2", "m3", "m4"]);

    await expect(
      reconcileOrphanedTopic("a1", repo, deps(repo, new FailingProvider())),
    ).resolves.toBe(0);
    expect((await loadTopicState("a1"))?.open?.messageIds).toHaveLength(4);
    expect(await repo.listBySession("s1")).toHaveLength(4);
  });

  it("二次启动幂等：状态与热存储不漂移，不重复归档/压缩", async () => {
    const ids = ["m1", "m2", "m3", "m4"];
    const provider = new CountingProvider("不该被调用");
    const repo = await seedOpenTopic(ids);

    const first = await reconcileOrphanedTopic("a1", repo, deps(repo, provider));
    const stateAfterFirst = await loadTopicState("a1");
    const second = await reconcileOrphanedTopic("a1", repo, deps(repo, provider));
    const stateAfterSecond = await loadTopicState("a1");

    expect(first).toBe(0);
    expect(second).toBe(0);
    expect(provider.calls).toBe(0);
    expect((await repo.listBySession("s1")).map((m) => m.id)).toEqual(ids);
    expect(await repo.getArchivedByIds(ids)).toEqual([]);
    expect(await archivedMessageIds("a1")).toEqual(new Set());
    expect(stateAfterSecond).toEqual(stateAfterFirst);
    expect(stateAfterSecond?.open?.messageIds).toEqual(ids);
  });

  it("重启 N 次：开放话题一直保留，不被反复处理", async () => {
    const ids = ["m1", "m2", "m3"];
    const provider = new CountingProvider("不该被调用");
    const repo = await seedOpenTopic(ids);

    for (let round = 0; round < 5; round++) {
      const count = await reconcileOrphanedTopic("a1", repo, deps(repo, provider));
      expect(count).toBe(0);
      expect((await repo.listBySession("s1")).map((m) => m.id)).toEqual(ids);
      expect((await loadTopicState("a1"))?.open?.messageIds).toEqual(ids);
    }
    expect(provider.calls).toBe(0);
    expect(await repo.getArchivedByIds(ids)).toEqual([]);
  });
});
