import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { MessageRepository } from "../../src/memory/repositories/message.js";
import { RecallService } from "../../src/memory/recall.js";
import { writeCompressedTopic } from "../../src/memory/topic/store.js";
import type { ChatMessageRecord } from "@mindcloud/shared";
import type { CompressedTopic } from "../../src/memory/topic/types.js";
import { restoreDataDir } from "../helpers/env.js";

function msg(id: string, text: string, createdAt: string): ChatMessageRecord {
  return {
    id,
    sessionId: "s1",
    role: "user",
    content: [{ type: "text", text }],
    createdAt,
  };
}

function makeTopic(
  topicId: string,
  label: string,
  msgIds: string[],
  startedAt: string,
  endedAt: string,
): CompressedTopic {
  return {
    topicId,
    label,
    summary: `话题主题：${label}\n关键结论：\n- x`,
    keyPoints: ["x"],
    msgIds,
    msgCount: msgIds.length,
    importance: "normal",
    sourceId: "s1",
    compressedAt: "2026-08-07T12:00:00.000Z",
    startedAt,
    endedAt,
  };
}

describe("RecallService（上阁楼）", () => {
  let tmpDir: string;
  let originalDataDir: string | undefined;
  let service: RecallService;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "recall-service-test-"));
    originalDataDir = process.env.CLOUDMIND_DATA_DIR;
    process.env.CLOUDMIND_DATA_DIR = tmpDir;
    service = new RecallService({
      getMessageRepository: (agentId) => new MessageRepository(agentId),
    });
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
    restoreDataDir(originalDataDir);
  });

  async function seedArchived(records: ChatMessageRecord[]): Promise<MessageRepository> {
    const repo = new MessageRepository("a1");
    for (const record of records) await repo.append(record);
    await repo.archiveAndRemove(records.map((r) => r.id));
    return repo;
  }

  it("listTopics：压缩档按开始时间倒序 + 分页", async () => {
    await writeCompressedTopic("a1", makeTopic("tp_1", "旧话题", ["m1"], "2026-08-01T00:00:00.000Z", "2026-08-01T01:00:00.000Z"));
    await writeCompressedTopic("a1", makeTopic("tp_2", "中话题", ["m2"], "2026-08-02T00:00:00.000Z", "2026-08-02T01:00:00.000Z"));
    await writeCompressedTopic("a1", makeTopic("tp_3", "新话题", ["m3"], "2026-08-03T00:00:00.000Z", "2026-08-03T01:00:00.000Z"));

    const all = await service.listTopics("a1");
    expect(all.total).toBe(3);
    expect(all.items.map((t) => t.topicId)).toEqual(["tp_3", "tp_2", "tp_1"]);
    expect(all.items[0]).toMatchObject({
      label: "新话题",
      startedAt: "2026-08-03T00:00:00.000Z",
      endedAt: "2026-08-03T01:00:00.000Z",
      msgCount: 1,
    });

    const page1 = await service.listTopics("a1", { limit: 2 });
    expect(page1.items.map((t) => t.topicId)).toEqual(["tp_3", "tp_2"]);
    expect(page1.total).toBe(3);
    const page2 = await service.listTopics("a1", { limit: 2, offset: 2 });
    expect(page2.items.map((t) => t.topicId)).toEqual(["tp_1"]);
  });

  it("listTopics：>20 个话题时 offset 分页正确（总数不被截断）", async () => {
    for (let i = 1; i <= 25; i++) {
      const day = String((i % 28) + 1).padStart(2, "0");
      await writeCompressedTopic(
        "a1",
        makeTopic(
          `tp_${String(i).padStart(2, "0")}`,
          `话题 ${i}`,
          [`m${i}`],
          `2026-08-${day}T00:00:00.000Z`,
          `2026-08-${day}T01:00:00.000Z`,
        ),
      );
    }

    const page1 = await service.listTopics("a1");
    expect(page1.total).toBe(25);
    expect(page1.items).toHaveLength(20);
    expect(page1.items[0]!.topicId).toBe("tp_25");
    expect(page1.items[19]!.topicId).toBe("tp_06");

    const page2 = await service.listTopics("a1", { offset: 20 });
    expect(page2.total).toBe(25);
    expect(page2.items.map((t) => t.topicId)).toEqual(["tp_05", "tp_04", "tp_03", "tp_02", "tp_01"]);

    const page3 = await service.listTopics("a1", { offset: 25 });
    expect(page3.items).toEqual([]);
    expect(page3.total).toBe(25);
  });

  it("readByTopicId：按 msgIds 取归档原文、按时间升序、带时间戳", async () => {
    const repo = await seedArchived([
      msg("m1", "第一条", "2026-08-01T00:00:00.000Z"),
      msg("m2", "第三条", "2026-08-03T00:00:00.000Z"),
      msg("m3", "第二条", "2026-08-02T00:00:00.000Z"),
      msg("m-other", "别的", "2026-08-04T00:00:00.000Z"),
    ]);
    await writeCompressedTopic(
      "a1",
      makeTopic("tp_1", "话题一", ["m1", "m2", "m3"], "2026-08-01T00:00:00.000Z", "2026-08-03T00:00:00.000Z"),
    );

    const page = await service.readByTopicId("a1", "tp_1");
    expect(page.total).toBe(3);
    expect(page.items.map((m) => m.id)).toEqual(["m1", "m3", "m2"]);
    expect(page.items[0]).toMatchObject({ role: "user", text: "第一条", createdAt: "2026-08-01T00:00:00.000Z" });
    // m-other 不在 msgIds 里，不返回
    expect(page.items.map((m) => m.id)).not.toContain("m-other");
    void repo;
  });

  it("readByQuery：关键词大小写不敏感、命中按时间倒序、未命中空", async () => {
    await seedArchived([
      msg("m1", "先聊 Deploy 方案", "2026-08-01T00:00:00.000Z"),
      msg("m2", "部署细节 deployment", "2026-08-02T00:00:00.000Z"),
      msg("m3", "晚上吃什么", "2026-08-03T00:00:00.000Z"),
      msg("m4", "DEPLOY 回滚", "2026-08-04T00:00:00.000Z"),
    ]);

    const hits = await service.readByQuery("a1", "deploy");
    expect(hits.total).toBe(3);
    // 倒序：m4 → m2 → m1
    expect(hits.items.map((m) => m.id)).toEqual(["m4", "m2", "m1"]);

    const none = await service.readByQuery("a1", "不存在的词");
    expect(none.total).toBe(0);
    expect(none.items).toEqual([]);
  });

  it("readByQuery/readByTopicId：limit/offset 分页与总数", async () => {
    await seedArchived([
      msg("m1", "部署 1", "2026-08-01T00:00:00.000Z"),
      msg("m2", "部署 2", "2026-08-02T00:00:00.000Z"),
      msg("m3", "部署 3", "2026-08-03T00:00:00.000Z"),
      msg("m4", "部署 4", "2026-08-04T00:00:00.000Z"),
      msg("m5", "部署 5", "2026-08-05T00:00:00.000Z"),
    ]);

    const p1 = await service.readByQuery("a1", "部署", { limit: 2 });
    expect(p1.total).toBe(5);
    expect(p1.items.map((m) => m.id)).toEqual(["m5", "m4"]);
    const p2 = await service.readByQuery("a1", "部署", { limit: 2, offset: 2 });
    expect(p2.items.map((m) => m.id)).toEqual(["m3", "m2"]);
    const p3 = await service.readByQuery("a1", "部署", { limit: 2, offset: 4 });
    expect(p3.items.map((m) => m.id)).toEqual(["m1"]);
    const p4 = await service.readByQuery("a1", "部署", { limit: 2, offset: 5 });
    expect(p4.items).toEqual([]);
    expect(p4.total).toBe(5);

    await writeCompressedTopic(
      "a1",
      makeTopic("tp_1", "部署话题", ["m1", "m2", "m3", "m4", "m5"], "2026-08-01T00:00:00.000Z", "2026-08-05T00:00:00.000Z"),
    );
    const byTopic = await service.readByTopicId("a1", "tp_1", { limit: 2, offset: 3 });
    expect(byTopic.total).toBe(5);
    expect(byTopic.items.map((m) => m.id)).toEqual(["m4", "m5"]);
  });

  it("readByTopicId：压缩档不存在抛明确错误；limit 硬上限 50", async () => {
    await expect(service.readByTopicId("a1", "tp_ghost")).rejects.toThrow("压缩档不存在");
    await seedArchived(Array.from({ length: 60 }, (_, i) => msg(`m${i}`, `部署 ${i}`, `2026-08-01T00:00:00.${String(i).padStart(3, "0")}Z`)));
    const capped = await service.readByQuery("a1", "部署", { limit: 999 });
    expect(capped.items.length).toBeLessThanOrEqual(50);
  });
});
