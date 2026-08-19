import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { writeCompressedTopic, latestSummaries, compressedDir, archivedMessageIds, removeCompressedTopic } from "../../src/memory/topic/store.js";
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
    expect(two[0].label).toBe("最新话题");
    expect(two[1].label).toBe("中间话题");

    const all = await latestSummaries("a1", 10);
    expect(all).toHaveLength(3);
  });

  it("结构化条目：id/label/text/createdAt 齐全，支撑自然化注入与去重", async () => {
    await writeCompressedTopic("a1", makeTopic({ topicId: "tp_4000_dddd" }));
    const [entry] = await latestSummaries("a1", 1);
    expect(entry.id).toBe("tp_4000_dddd");
    expect(entry.label).toBe("前端状态管理");
    expect(entry.createdAt).toBe("2026-07-21T10:00:00.000Z");
    // text 为摘要正文（不含 [话题摘要] 元信息包装——自然化由注入侧负责）
    expect(entry.text).not.toContain("[话题摘要]");
    expect(entry.text).toContain("话题主题：前端状态管理");
    expect(entry.text).toContain("关键结论");
    expect(entry.text).toContain("决定用 Zustand");
  });

  it("损坏的压缩档跳过不中断", async () => {
    await writeCompressedTopic("a1", makeTopic({ label: "好档" }));
    await fs.writeFile(path.join(compressedDir("a1"), "broken.md"), "这不是压缩档", "utf-8");

    const result = await latestSummaries("a1", 5);
    expect(result).toHaveLength(1);
    expect(result[0].label).toBe("好档");
  });

  it("目录不存在时返回空数组", async () => {
    expect(await latestSummaries("ghost", 2)).toEqual([]);
  });

  it("count<=0 时不读取目录直接返回空", async () => {
    await writeCompressedTopic("a1", makeTopic());
    expect(await latestSummaries("a1", 0)).toEqual([]);
  });

  // P4-b 差异化保留：最近 N 个之外，最近一个 importance=high 的档始终追加注入
  it("高重要常驻：high 档被挤出最近 N 个时仍追加（置末尾，时间倒序不破）", async () => {
    await writeCompressedTopic("a1", makeTopic({ topicId: "tp_1000_high", label: "高重要旧话题", importance: "high" }));
    await writeCompressedTopic("a1", makeTopic({ topicId: "tp_2000_n1", label: "新话题一" }));
    await writeCompressedTopic("a1", makeTopic({ topicId: "tp_3000_n2", label: "新话题二" }));

    const out = await latestSummaries("a1", 2);
    expect(out.map((t) => t.id)).toEqual(["tp_3000_n2", "tp_2000_n1", "tp_1000_high"]);
    expect(out[2]!.importance).toBe("high");
  });

  it("高重要常驻：high 档已在最近 N 个内时不重复追加", async () => {
    await writeCompressedTopic("a1", makeTopic({ topicId: "tp_1000_aaaa", label: "旧话题" }));
    await writeCompressedTopic("a1", makeTopic({ topicId: "tp_2000_high", label: "高重要新话题", importance: "high" }));

    const out = await latestSummaries("a1", 2);
    expect(out.map((t) => t.id)).toEqual(["tp_2000_high", "tp_1000_aaaa"]);
  });

  it("高重要常驻：多个 high 档只追加最近一个", async () => {
    await writeCompressedTopic("a1", makeTopic({ topicId: "tp_1000_h1", label: "高重要一", importance: "high" }));
    await writeCompressedTopic("a1", makeTopic({ topicId: "tp_2000_h2", label: "高重要二", importance: "high" }));
    await writeCompressedTopic("a1", makeTopic({ topicId: "tp_3000_n1", label: "新话题一" }));
    await writeCompressedTopic("a1", makeTopic({ topicId: "tp_4000_n2", label: "新话题二" }));

    const out = await latestSummaries("a1", 2);
    expect(out.map((t) => t.id)).toEqual(["tp_4000_n2", "tp_3000_n1", "tp_2000_h2"]);
  });

  it("normal 档不常驻：全部 normal 时返回与旧版一致（逐字节不变）", async () => {
    await writeCompressedTopic("a1", makeTopic({ topicId: "tp_1000_aaaa", label: "旧话题" }));
    await writeCompressedTopic("a1", makeTopic({ topicId: "tp_2000_bbbb", label: "中间话题" }));
    await writeCompressedTopic("a1", makeTopic({ topicId: "tp_3000_cccc", label: "最新话题" }));

    const out = await latestSummaries("a1", 2);
    expect(out.map((t) => t.id)).toEqual(["tp_3000_cccc", "tp_2000_bbbb"]);
    expect(out.every((t) => t.importance === "normal")).toBe(true);
  });

  it("存量档（frontmatter 无 importance 行）按 normal 处理：不常驻、不炸", async () => {
    // 手工构造 P4-a 之前的旧格式档（无 importance 行）
    const legacy = [
      "---",
      "schema: 1",
      "topic_id: tp_0500_legacy",
      "embedding_id: ",
      "label: 存量旧话题",
      "source_id: s1",
      "source_name: ",
      "compressed_at: 2026-07-01T10:00:00.000Z",
      "started_at: ",
      "ended_at: ",
      "msg_count: 2",
      "used_skills: ",
      "---",
      "",
      "## Summary",
      "",
      "旧话题摘要",
      "",
      "## Key Points",
      "",
      "- 旧结论",
      "",
      "## Messages Archived",
      "",
      "m1, m2",
      "",
    ].join("\n");
    await fs.mkdir(compressedDir("a1"), { recursive: true });
    await fs.writeFile(path.join(compressedDir("a1"), "tp_0500_legacy.md"), legacy, "utf-8");
    await writeCompressedTopic("a1", makeTopic({ topicId: "tp_2000_bbbb", label: "新话题" }));

    const out = await latestSummaries("a1", 1);
    // 存量档无 importance → 不触发常驻追加；读回条目无 importance 字段
    expect(out.map((t) => t.id)).toEqual(["tp_2000_bbbb"]);
    const all = await latestSummaries("a1", 10);
    expect(all.find((t) => t.id === "tp_0500_legacy")!.importance).toBeUndefined();
  });

  it("archivedMessageIds 汇总全部压缩档的消息 id，重复调用结果一致", async () => {
    await writeCompressedTopic("a1", makeTopic({ topicId: "tp_1000_aaaa", msgIds: ["m1", "m2"] }));
    await writeCompressedTopic("a1", makeTopic({ topicId: "tp_2000_bbbb", msgIds: ["m3"] }));

    const first = await archivedMessageIds("a1");
    expect(first).toEqual(new Set(["m1", "m2", "m3"]));
    // 第二次走缓存路径，结果必须一致
    const second = await archivedMessageIds("a1");
    expect(second).toEqual(first);
  });

  it("archivedMessageIds：新写压缩档后 id 集合更新", async () => {
    await writeCompressedTopic("a1", makeTopic({ topicId: "tp_1000_aaaa", msgIds: ["m1"] }));
    expect(await archivedMessageIds("a1")).toEqual(new Set(["m1"]));

    await writeCompressedTopic("a1", makeTopic({ topicId: "tp_2000_bbbb", msgIds: ["m2"] }));
    expect(await archivedMessageIds("a1")).toEqual(new Set(["m1", "m2"]));
  });

  it("archivedMessageIds：压缩档删除后 id 集合收缩", async () => {
    await writeCompressedTopic("a1", makeTopic({ topicId: "tp_1000_aaaa", msgIds: ["m1"] }));
    await writeCompressedTopic("a1", makeTopic({ topicId: "tp_2000_bbbb", msgIds: ["m2"] }));
    expect(await archivedMessageIds("a1")).toEqual(new Set(["m1", "m2"]));

    await removeCompressedTopic("a1", "tp_2000_bbbb");
    expect(await archivedMessageIds("a1")).toEqual(new Set(["m1"]));
  });
});
