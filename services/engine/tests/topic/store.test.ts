import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { writeCompressedTopic, latestSummaries, compressedDir } from "../../src/memory/topic/store.js";
import type { CompressedTopic } from "../../src/memory/topic/types.js";
import { restoreDataDir } from "../helpers/env.js";

function makeTopic(overrides: Partial<CompressedTopic> = {}): CompressedTopic {
  return {
    topicId: `tp_${Math.random().toString(36).slice(2)}`,
    label: "前端状态管理",
    summary: "话题主题：前端状态管理\n关键结论：\n- 决定用 Zustand",
    keyPoints: ["决定用 Zustand", "持久化用 localStorage"],
    msgIds: ["m1", "m2"],
    msgCount: 2,
    importance: "normal",
    sourceId: "s1",
    sourceName: "与指挥官的私聊",
    compressedAt: "2026-07-21T10:00:00.000Z",
    ...overrides,
  };
}

describe("topic store", () => {
  let tmpDir: string;
  let originalDataDir: string | undefined;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "topic-store-test-"));
    originalDataDir = process.env.CLOUDMIND_DATA_DIR;
    process.env.CLOUDMIND_DATA_DIR = tmpDir;
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
    restoreDataDir(originalDataDir);
  });

  it("写入压缩档：frontmatter 字段与各分节齐全", async () => {
    const topic = makeTopic();
    const filePath = await writeCompressedTopic("a1", topic);
    const raw = await fs.readFile(filePath, "utf-8");

    expect(raw).toContain("topic_id: " + topic.topicId);
    expect(raw).toContain("label: 前端状态管理");
    expect(raw).toContain("importance: normal");
    expect(raw).toContain("source_id: s1");
    expect(raw).toContain("source_name: 与指挥官的私聊");
    expect(raw).toContain("msg_count: 2");
    expect(raw).toContain("embedding_id:");
    expect(raw).toContain("## Summary");
    expect(raw).toContain("## Key Points");
    expect(raw).toContain("- 决定用 Zustand");
    expect(raw).toContain("## Messages Archived");
    expect(raw).toContain("m1, m2");
  });

  it("latestSummaries 按文件名（topicId 时间戳）倒序取最近 N 个", async () => {
    await writeCompressedTopic("a1", makeTopic({ topicId: "tp_1000_aaaa", label: "旧话题" }));
    await writeCompressedTopic("a1", makeTopic({ topicId: "tp_3000_cccc", label: "最新话题" }));
    await writeCompressedTopic("a1", makeTopic({ topicId: "tp_2000_bbbb", label: "中间话题" }));

    const two = await latestSummaries("a1", 2);
    expect(two).toHaveLength(2);
    expect(two[0]).toContain("最新话题");
    expect(two[1]).toContain("中间话题");

    const all = await latestSummaries("a1", 10);
    expect(all).toHaveLength(3);
  });

  it("注入文本包含主题、摘要与关键结论", async () => {
    await writeCompressedTopic("a1", makeTopic());
    const [text] = await latestSummaries("a1", 1);
    expect(text).toContain("[话题摘要] 前端状态管理");
    expect(text).toContain("话题主题：前端状态管理");
    expect(text).toContain("关键结论");
    expect(text).toContain("决定用 Zustand");
  });

  it("损坏的压缩档跳过不中断", async () => {
    await writeCompressedTopic("a1", makeTopic({ label: "好档" }));
    await fs.writeFile(path.join(compressedDir("a1"), "broken.md"), "这不是压缩档", "utf-8");

    const result = await latestSummaries("a1", 5);
    expect(result).toHaveLength(1);
    expect(result[0]).toContain("好档");
  });

  it("目录不存在时返回空数组", async () => {
    expect(await latestSummaries("ghost", 2)).toEqual([]);
  });

  it("count<=0 时不读取目录直接返回空", async () => {
    await writeCompressedTopic("a1", makeTopic());
    expect(await latestSummaries("a1", 0)).toEqual([]);
  });
});
