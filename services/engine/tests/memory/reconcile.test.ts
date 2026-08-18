import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { MessageRepository } from "../../src/memory/repositories/message.js";
import type { ChatMessageRecord } from "../../src/memory/repositories/types.js";
import { reconcileHotStorage } from "../../src/memory/reconcile.js";
import { writeCompressedTopic } from "../../src/memory/topic/store.js";
import type { CompressedTopic } from "../../src/memory/topic/types.js";
import { restoreDataDir } from "../helpers/env.js";

function makeMsg(id: string, sessionId = "s1"): ChatMessageRecord {
  return {
    id,
    sessionId,
    role: "user",
    content: [{ type: "text", text: `消息 ${id}` }],
    createdAt: "2026-07-21T10:00:00.000Z",
  };
}

function makeTopic(msgIds: string[]): CompressedTopic {
  return {
    topicId: `tp_${Math.random().toString(36).slice(2)}`,
    label: "测试话题",
    summary: "摘要",
    keyPoints: ["要点"],
    msgIds,
    msgCount: msgIds.length,
    importance: "normal",
    sourceId: "s1",
    sourceName: "测试会话",
    compressedAt: "2026-07-21T11:00:00.000Z",
  };
}

describe("reconcileHotStorage 启动对账", () => {
  let tmpDir: string;
  let originalDataDir: string | undefined;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "reconcile-test-"));
    originalDataDir = process.env.CLOUDMIND_DATA_DIR;
    process.env.CLOUDMIND_DATA_DIR = tmpDir;
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
    restoreDataDir(originalDataDir);
  });

  it("补归档：已有压缩档但仍留在热存储的孤儿消息被移入归档", async () => {
    const repo = new MessageRepository("a1");
    for (const id of ["m1", "m2", "m3", "m4", "m5"]) await repo.append(makeMsg(id));
    await writeCompressedTopic("a1", makeTopic(["m1", "m2"]));

    const count = await reconcileHotStorage("a1", repo);
    expect(count).toBe(2);

    // 热存储只剩未归档的 m3/m4/m5
    const hot = await repo.listBySession("s1");
    expect(hot.map((m) => m.id)).toEqual(["m3", "m4", "m5"]);
    // 孤儿已进入归档（最后防线可读回）
    const archived = await repo.getArchivedByIds(["m1", "m2"]);
    expect(archived.map((m) => m.id).sort()).toEqual(["m1", "m2"]);
  });

  it("部分归档：只有交集被补归档，未压缩消息不受影响", async () => {
    const repo = new MessageRepository("a1");
    for (const id of ["m1", "m2", "m3"]) await repo.append(makeMsg(id));
    await writeCompressedTopic("a1", makeTopic(["m1"]));
    await writeCompressedTopic("a1", makeTopic(["m9", "m8"])); // 指向热存储不存在的 id

    const count = await reconcileHotStorage("a1", repo);
    expect(count).toBe(1);
    expect((await repo.listBySession("s1")).map((m) => m.id)).toEqual(["m2", "m3"]);
  });

  it("无压缩档时跳过，热存储原样保留", async () => {
    const repo = new MessageRepository("a1");
    await repo.append(makeMsg("m1"));

    const count = await reconcileHotStorage("a1", repo);
    expect(count).toBe(0);
    expect((await repo.listBySession("s1")).map((m) => m.id)).toEqual(["m1"]);
  });

  it("无热存储时跳过", async () => {
    const repo = new MessageRepository("ghost");
    await writeCompressedTopic("ghost", makeTopic(["m1"]));

    const count = await reconcileHotStorage("ghost", repo);
    expect(count).toBe(0);
  });

  it("无孤儿时不向归档重复追加", async () => {
    const repo = new MessageRepository("a1");
    await repo.append(makeMsg("m1"));
    await writeCompressedTopic("a1", makeTopic(["m9"])); // 压缩档指向的 id 不在热存储

    const count = await reconcileHotStorage("a1", repo);
    expect(count).toBe(0);
    // 归档文件不应被创建/追加
    await expect(repo.getArchivedByIds(["m9"])).resolves.toEqual([]);
    expect((await repo.listBySession("s1")).map((m) => m.id)).toEqual(["m1"]);
  });

  it("对账失败向调用方抛错（由启动流程 catch 记 warn，不阻断启动）", async () => {
    // 需要压缩档存在，对账才会走到读热存储这一步
    await writeCompressedTopic("a1", makeTopic(["m1"]));
    const failingRepo = {
      getByIds: async () => {
        throw new Error("disk gone");
      },
    } as unknown as MessageRepository;

    await expect(reconcileHotStorage("a1", failingRepo)).rejects.toThrow("disk gone");
  });

  it("孤儿 createdAt 早于现有归档尾部：保序插入归档正确位置，归并读仍按时间序（G3c）", async () => {
    const repo = new MessageRepository("a1");
    const timed = (id: string, createdAt: string): ChatMessageRecord => ({
      ...makeMsg(id),
      createdAt,
    });
    // 崩溃现场重建：m-old 的压缩档已写但归档未完成（孤儿，createdAt 10:00）；
    // 归档里已有更晚归档的 m-new（12:00）——裸 append 会把 m-old 追加到末尾，
    // 破坏「归档按 createdAt 递增」前提
    await repo.append(timed("m-old", "2026-07-21T10:00:00.000Z"));
    await repo.append(timed("m-new", "2026-07-21T12:00:00.000Z"));
    await repo.archiveAndRemove(["m-new"]); // 归档 = [m-new(12:00)]
    await repo.append(timed("m-hot", "2026-07-21T13:00:00.000Z"));
    await writeCompressedTopic("a1", makeTopic(["m-old"]));

    const count = await reconcileHotStorage("a1", repo);
    expect(count).toBe(1);

    // 归档文件本身按 createdAt 递增（m-old 插在 m-new 之前，不是追加末尾）
    const archived = await repo.getArchivedByIds(["m-old", "m-new"]);
    expect(archived.map((m) => m.id)).toEqual(["m-old", "m-new"]);
    // 归并读（热存储 + 归档）按时间序：m-old → m-new → m-hot
    const merged = await repo.listBySessionWithArchived("s1", { limit: 10 });
    expect(merged.map((m) => m.id)).toEqual(["m-old", "m-new", "m-hot"]);
    // 热存储只剩 m-hot
    expect((await repo.listBySession("s1")).map((m) => m.id)).toEqual(["m-hot"]);
  });
});
