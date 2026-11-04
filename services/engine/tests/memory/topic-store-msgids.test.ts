import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  writeCompressedTopic,
  readCompressedTopicMsgIds,
  archivedMessageIds,
  archivedIdsByKeep,
} from "../../src/memory/topic/store.js";
import type { CompressedTopic } from "../../src/memory/topic/types.js";
import { restoreDataDir } from "../helpers/env.js";

function makeTopic(overrides: Partial<CompressedTopic> = {}): CompressedTopic {
  return {
    topicId: `tp_${Math.random().toString(36).slice(2)}`,
    label: "测试话题",
    summary: "摘要正文",
    keyPoints: ["要点一"],
    msgIds: ["m1", "m2"],
    msgCount: 2,
    importance: "normal",
    sourceId: "s1",
    compressedAt: "2026-08-01T10:00:00.000Z",
    ...overrides,
  };
}

describe("压缩档 msgIds 解析（M11）", () => {
  let tmpDir: string;
  let originalDataDir: string | undefined;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "topic-msgids-test-"));
    originalDataDir = process.env.CLOUDMIND_DATA_DIR;
    process.env.CLOUDMIND_DATA_DIR = tmpDir;
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
    restoreDataDir(originalDataDir);
  });

  it("正常解析文末分节：readCompressedTopicMsgIds 与 archivedMessageIds 一致", async () => {
    await writeCompressedTopic("a1", makeTopic({ topicId: "tp_1000_aaaa", msgIds: ["m1", "m2", "m3"] }));

    expect(await readCompressedTopicMsgIds("a1", "tp_1000_aaaa")).toEqual(["m1", "m2", "m3"]);
    expect(await archivedMessageIds("a1")).toEqual(new Set(["m1", "m2", "m3"]));
  });

  it("摘要正文混入同名标题不污染解析（对抗样本）", async () => {
    // review M11：LLM 摘要正文自带 "## Messages Archived" 行 + 伪 id，
    // 旧正则按首个命中抠到文末，伪 id 会混进结果（L4 归档排除失效、recall 取错档）
    await writeCompressedTopic(
      "a1",
      makeTopic({
        topicId: "tp_1000_evil",
        summary: "讨论了归档格式：\n\n## Messages Archived\n\nfake_1, fake_2\n\n如上所示。",
        msgIds: ["real_1", "real_2"],
      }),
    );

    expect(await readCompressedTopicMsgIds("a1", "tp_1000_evil")).toEqual(["real_1", "real_2"]);
    const all = await archivedMessageIds("a1");
    expect(all).toEqual(new Set(["real_1", "real_2"]));
    expect(all.has("fake_1")).toBe(false);
    expect(all.has("fake_2")).toBe(false);
  });

  it("关键结论混入同名标题同样不污染", async () => {
    await writeCompressedTopic(
      "a1",
      makeTopic({
        topicId: "tp_2000_evil",
        keyPoints: ["见下：\n\n## Messages Archived\n\nfake_9"],
        msgIds: ["real_3"],
      }),
    );

    expect(await readCompressedTopicMsgIds("a1", "tp_2000_evil")).toEqual(["real_3"]);
    expect(await archivedMessageIds("a1")).toEqual(new Set(["real_3"]));
  });

  it("多档汇总时只取各档真实分节", async () => {
    await writeCompressedTopic("a1", makeTopic({ topicId: "tp_1000_aaaa", msgIds: ["m1"] }));
    await writeCompressedTopic(
      "a1",
      makeTopic({
        topicId: "tp_2000_bbbb",
        summary: "## Messages Archived\n\nfake_1",
        msgIds: ["m2"],
      }),
    );

    expect(await archivedMessageIds("a1")).toEqual(new Set(["m1", "m2"]));
  });

  it("topicId 非法或档不存在返回 null", async () => {
    expect(await readCompressedTopicMsgIds("a1", "../etc/passwd")).toBeNull();
    expect(await readCompressedTopicMsgIds("a1", "tp_ghost")).toBeNull();
  });

  it("archivedIdsByKeep 按 importance 划分：high 进 highKept，normal/low 不进", async () => {
    await writeCompressedTopic(
      "a1",
      makeTopic({ topicId: "tp_1000_high", msgIds: ["h1", "h2"], importance: "high" }),
    );
    await writeCompressedTopic(
      "a1",
      makeTopic({ topicId: "tp_2000_norm", msgIds: ["n1"], importance: "normal" }),
    );
    await writeCompressedTopic(
      "a1",
      makeTopic({ topicId: "tp_3000_low", msgIds: ["l1"], importance: "low" }),
    );

    const idx = await archivedIdsByKeep("a1");
    expect(idx.all).toEqual(new Set(["h1", "h2", "n1", "l1"]));
    expect(idx.highKept).toEqual(new Set(["h1", "h2"]));
    // 扁平全集与划分的 all 同源（启动对账用前者），不额外读盘
    expect(await archivedMessageIds("a1")).toEqual(idx.all);
  });

  it("archivedIdsByKeep：无压缩档时两个集合皆空", async () => {
    const idx = await archivedIdsByKeep("ghost");
    expect(idx.all.size).toBe(0);
    expect(idx.highKept.size).toBe(0);
  });
});
