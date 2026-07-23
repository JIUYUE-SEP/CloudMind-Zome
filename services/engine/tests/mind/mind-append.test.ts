import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  appendMindExperiences,
  parseMindChunks,
  DEFAULT_MIND_CONTENT,
  type NewMindExperience,
} from "../../src/mind/mind-files.js";
import { getAgentDir } from "../../src/config/paths.js";
import { restoreDataDir } from "../helpers/env.js";

const AGENT_ID = "mind-append";

let tmpDir: string;
let originalDataDir: string | undefined;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "mind-append-"));
  originalDataDir = process.env.CLOUDMIND_DATA_DIR;
  process.env.CLOUDMIND_DATA_DIR = tmpDir;
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
  restoreDataDir(originalDataDir);
});

function mindPath(): string {
  return path.join(getAgentDir(AGENT_ID), "MIND.md");
}

async function readMind(): Promise<string> {
  return fs.readFile(mindPath(), "utf-8");
}

async function seedMind(content: string): Promise<void> {
  await fs.mkdir(path.dirname(mindPath()), { recursive: true });
  await fs.writeFile(mindPath(), content, "utf-8");
}

function exp(overrides: Partial<NewMindExperience> = {}): NewMindExperience {
  return {
    title: "指挥官偏好：不用 emoji",
    text: "指挥官明确表示不使用 emoji。",
    confidence: 0.9,
    source: "topic-tp_1",
    created: "2026-07-23T17:00:00Z",
    ...overrides,
  };
}

describe("appendMindExperiences 写入（append-only + frontmatter）", () => {
  it("新经验追加为带 frontmatter 的 ## 块，已有内容原样保留", async () => {
    await seedMind(`${DEFAULT_MIND_CONTENT}\n## 已有经验\n旧的正文。\n`);
    const before = await readMind();

    const result = await appendMindExperiences(AGENT_ID, [exp()]);

    const after = await readMind();
    // append-only：原内容完整保留为前缀
    expect(after.startsWith(before.trimEnd())).toBe(true);
    expect(after).toContain(
      [
        "## 指挥官偏好：不用 emoji",
        "---",
        "source: topic-tp_1",
        "created: 2026-07-23T17:00:00Z",
        "confidence: 0.9",
        "---",
        "指挥官明确表示不使用 emoji。",
      ].join("\n"),
    );
    expect(result).toEqual({ appended: 1, merged: 0, skipped: 0 });
    // 写出的块可被解析器读回（frontmatter 字段 + 正文）
    const chunks = parseMindChunks(after);
    const written = chunks.find((c) => c.heading === "指挥官偏好：不用 emoji");
    expect(written?.content).toBe("指挥官明确表示不使用 emoji。");
    expect(written?.source).toBe("topic-tp_1");
    expect(written?.confidence).toBe(0.9);
  });

  it("MIND.md 不存在时创建文件并写入", async () => {
    await appendMindExperiences(AGENT_ID, [exp()]);
    const after = await readMind();
    expect(after).toContain("## 指挥官偏好：不用 emoji");
    expect(after).toContain("source: topic-tp_1");
  });

  it("confidence ≤ 0.5 直接不落盘（含 0.5 边界）", async () => {
    const result = await appendMindExperiences(AGENT_ID, [
      exp({ title: "低置信经验", confidence: 0.5 }),
      exp({ title: "更低置信经验", confidence: 0.2 }),
      exp({ title: "合格经验", confidence: 0.51 }),
    ]);
    expect(result).toEqual({ appended: 1, merged: 0, skipped: 2 });
    const after = await readMind();
    expect(after).not.toContain("低置信经验");
    expect(after).toContain("合格经验");
    expect(after).toContain("confidence: 0.51");
  });

  it("全部被过滤时不创建文件", async () => {
    const result = await appendMindExperiences(AGENT_ID, [exp({ confidence: 0.3 })]);
    expect(result).toEqual({ appended: 0, merged: 0, skipped: 1 });
    await expect(fs.stat(mindPath())).rejects.toThrow();
  });

  it("空标题 / 空正文的条目不落盘", async () => {
    const result = await appendMindExperiences(AGENT_ID, [
      exp({ title: "  " }),
      exp({ text: "" }),
    ]);
    expect(result.skipped).toBe(2);
    await expect(fs.stat(mindPath())).rejects.toThrow();
  });
});

describe("appendMindExperiences 去重（标题 token Jaccard ≥ 0.6 合并）", () => {
  it("标题相似：新正文作为一行补充追加到已有块末尾，原文不删、不产生新块", async () => {
    await seedMind("## 指挥官偏好：不用 emoji\n指挥官提过回复里不要带 emoji。\n");

    const result = await appendMindExperiences(AGENT_ID, [
      exp({ title: "指挥官偏好-emoji", text: "文档里同样避免 emoji。" }),
    ]);

    expect(result).toEqual({ appended: 0, merged: 1, skipped: 0 });
    const after = await readMind();
    // 原文保留，补充行追加在已有块正文末尾
    expect(after).toContain("指挥官提过回复里不要带 emoji。");
    expect(after).toContain("指挥官提过回复里不要带 emoji。\n文档里同样避免 emoji。");
    // 只有一个 ## 块
    expect(parseMindChunks(after)).toHaveLength(1);
  });

  it("合并目标带 frontmatter：补充行在正文末尾，frontmatter 不动", async () => {
    await seedMind(
      [
        "## 指挥官偏好：不用 emoji",
        "---",
        "source: topic-tp_0",
        "created: 2026-07-20T00:00:00Z",
        "confidence: 0.8",
        "---",
        "指挥官提过回复里不要带 emoji。",
        "",
        "## 另一块",
        "别的内容。",
        "",
      ].join("\n"),
    );

    await appendMindExperiences(AGENT_ID, [
      exp({ title: "指挥官偏好-emoji", text: "文档里同样避免\nemoji。" }),
    ]);

    const after = await readMind();
    // 补充行压成一行，追加在目标块正文末尾（下一块之前）
    expect(after).toContain("指挥官提过回复里不要带 emoji。\n文档里同样避免 emoji。\n\n## 另一块");
    // frontmatter 保持原样
    expect(after).toContain("source: topic-tp_0");
    expect(after).toContain("confidence: 0.8");
    expect(parseMindChunks(after)).toHaveLength(2);
  });

  it("标题不相似：独立成块", async () => {
    await seedMind("## Windows 进程管理\n杀 node 会连带 engine。\n");

    const result = await appendMindExperiences(AGENT_ID, [exp()]);

    expect(result).toEqual({ appended: 1, merged: 0, skipped: 0 });
    expect(parseMindChunks(await readMind())).toHaveLength(2);
  });

  it("Jaccard = 0.6 边界也合并", async () => {
    // {git,rebase,flow} vs {git,rebase,flow,with,care}：交 3 并 5 = 0.6
    await seedMind("## git rebase flow\n先 fetch 再 rebase。\n");

    const result = await appendMindExperiences(AGENT_ID, [
      exp({ title: "git rebase flow with care", text: "rebase 前先备份分支。" }),
    ]);

    expect(result.merged).toBe(1);
    const after = await readMind();
    expect(after).toContain("先 fetch 再 rebase。\nrebase 前先备份分支。");
    expect(parseMindChunks(after)).toHaveLength(1);
  });

  it("共享前缀但主体段不同：不误并（review M1 反例）", async () => {
    // 「指挥官偏好：饮食」vs「指挥官偏好：穿搭」：整体 Jaccard 0.6 过线，
    // 但主体段（末段）饮食/穿搭无共享 token —— 双重门槛下不并
    await seedMind("## 指挥官偏好：饮食\n不吃辣。\n");

    const result = await appendMindExperiences(AGENT_ID, [
      exp({ title: "指挥官偏好：穿搭", text: "正式场合穿深色。" }),
    ]);

    expect(result).toEqual({ appended: 1, merged: 0, skipped: 0 });
    const chunks = parseMindChunks(await readMind());
    expect(chunks).toHaveLength(2);
    expect(chunks[0].content).toBe("不吃辣。"); // 原块未被污染
  });

  it("主体段有共享 token 且整体相似：正常合并（双重门槛正例）", async () => {
    // 整体 Jaccard 4/6 ≈ 0.67，主体段「不用 emoji」vs「emoji 禁用」共享 emoji
    await seedMind("## 指挥官偏好：不用 emoji\n回复不带 emoji。\n");

    const result = await appendMindExperiences(AGENT_ID, [
      exp({ title: "指挥官偏好：emoji 禁用", text: "文档里同样避免。" }),
    ]);

    expect(result.merged).toBe(1);
    const after = await readMind();
    expect(after).toContain("回复不带 emoji。\n文档里同样避免。");
    expect(parseMindChunks(after)).toHaveLength(1);
  });

  it("同批次后写入的经验参与去重（连续合并到同一块）", async () => {
    const result = await appendMindExperiences(AGENT_ID, [
      exp(),
      exp({ title: "指挥官偏好-emoji", text: "文档里同样避免 emoji。" }),
    ]);
    expect(result).toEqual({ appended: 1, merged: 1, skipped: 0 });
    const after = await readMind();
    expect(parseMindChunks(after)).toHaveLength(1);
    expect(after).toContain("指挥官明确表示不使用 emoji。\n文档里同样避免 emoji。");
  });
});
