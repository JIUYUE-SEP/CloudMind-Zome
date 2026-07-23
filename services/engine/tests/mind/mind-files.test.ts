import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  DEFAULT_SOUL_TEMPLATE,
  DEFAULT_MIND_CONTENT,
  ensureMindFiles,
  loadSoul,
  loadMindChunks,
  parseMindChunks,
  retrieveMindChunks,
  type MindChunk,
} from "../../src/mind/mind-files.js";
import { getAgentDir } from "../../src/config/paths.js";
import { restoreDataDir } from "../helpers/env.js";

const AGENT_ID = "mind-test";

let tmpDir: string;
let originalDataDir: string | undefined;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "mind-files-"));
  originalDataDir = process.env.CLOUDMIND_DATA_DIR;
  process.env.CLOUDMIND_DATA_DIR = tmpDir;
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
  restoreDataDir(originalDataDir);
});

async function writeAgentFile(name: string, content: string): Promise<void> {
  const dir = getAgentDir(AGENT_ID);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, name), content, "utf-8");
}

describe("SOUL.md 加载", () => {
  it("文件不存在时返回默认模板（trim 后）", async () => {
    expect(await loadSoul(AGENT_ID)).toBe(DEFAULT_SOUL_TEMPLATE.trim());
  });

  it("文件存在时返回文件内容", async () => {
    await writeAgentFile("SOUL.md", "# 自定义人格\n\n我是独一无二的。");
    expect(await loadSoul(AGENT_ID)).toBe("# 自定义人格\n\n我是独一无二的。");
  });
});

describe("MIND.md 解析（## 标题分块）", () => {
  it("空字符串 / 无标题内容解析为空块列表", () => {
    expect(parseMindChunks("")).toEqual([]);
    expect(parseMindChunks("我是新心智，还在学习中。")).toEqual([]);
  });

  it("按 ## 标题分块，标题前的前言不进入任何块", () => {
    const raw = ["前言：本文件记录经验。", "", "## 前端状态管理", "决定使用 Zustand。", "", "## 用户偏好", "指挥官不吃辣。", ""].join("\n");
    const chunks = parseMindChunks(raw);
    expect(chunks).toHaveLength(2);
    expect(chunks[0].heading).toBe("前端状态管理");
    expect(chunks[0].content).toBe("决定使用 Zustand。");
    expect(chunks[1].heading).toBe("用户偏好");
    expect(chunks[1].content).toBe("指挥官不吃辣。");
  });

  it("保留多行正文，raw 保留原始块文本", () => {
    const raw = "## 经验\n第一行\n第二行\n\n## 下一块\n内容";
    const chunks = parseMindChunks(raw);
    expect(chunks[0].content).toBe("第一行\n第二行");
    expect(chunks[0].raw).toBe("## 经验\n第一行\n第二行");
  });

  it("带 frontmatter 的块：字段解析到 chunk 上，content 跳过围栏段，raw 原样保留", () => {
    const raw = [
      "## 指挥官偏好：不用 emoji",
      "---",
      "source: topic-tp_123",
      "created: 2026-07-23T17:00:00Z",
      "confidence: 0.9",
      "---",
      "指挥官明确表示不使用 emoji。",
      "",
      "## 无头信息块",
      "普通正文。",
    ].join("\n");
    const chunks = parseMindChunks(raw);
    expect(chunks).toHaveLength(2);

    expect(chunks[0].heading).toBe("指挥官偏好：不用 emoji");
    expect(chunks[0].content).toBe("指挥官明确表示不使用 emoji。");
    expect(chunks[0].source).toBe("topic-tp_123");
    expect(chunks[0].created).toBe("2026-07-23T17:00:00Z");
    expect(chunks[0].confidence).toBe(0.9);
    // raw 原样（含 frontmatter，审计用）
    expect(chunks[0].raw).toContain("source: topic-tp_123");
    expect(chunks[0].raw).toContain("confidence: 0.9");

    // 无 frontmatter 的块：字段为 undefined，行为与 Phase 6 一致
    expect(chunks[1].content).toBe("普通正文。");
    expect(chunks[1].source).toBeUndefined();
    expect(chunks[1].created).toBeUndefined();
    expect(chunks[1].confidence).toBeUndefined();
  });

  it("检索打分只看标题与正文：frontmatter 内容不参与", () => {
    const chunks = parseMindChunks(
      "## 饮食偏好\n---\nsource: topic-tp_1\ncreated: 2026-07-23T00:00:00Z\nconfidence: 0.9\n---\n指挥官不吃辣。",
    );
    // "topic"/"confidence" 只出现在 frontmatter 中，不应命中
    expect(retrieveMindChunks(chunks, "topic confidence")).toEqual([]);
    // 正文命中不受影响
    expect(retrieveMindChunks(chunks, "吃辣")).toHaveLength(1);
  });
});

describe("MIND.md 读取", () => {
  it("文件不存在 / 初始占位内容时返回空块列表", async () => {
    expect(await loadMindChunks(AGENT_ID)).toEqual([]);
    await writeAgentFile("MIND.md", DEFAULT_MIND_CONTENT);
    expect(await loadMindChunks(AGENT_ID)).toEqual([]);
  });

  it("解析文件中的 ## 分块", async () => {
    await writeAgentFile("MIND.md", "## 经验A\n内容A\n\n## 经验B\n内容B\n");
    const chunks = await loadMindChunks(AGENT_ID);
    expect(chunks.map((c) => c.heading)).toEqual(["经验A", "经验B"]);
  });
});

describe("MIND.md 检索（按话题匹配）", () => {
  const chunks: MindChunk[] = [
    { heading: "前端状态管理", content: "决定使用 Zustand 而非 Redux。", raw: "## 前端状态管理\n决定使用 Zustand 而非 Redux。" },
    { heading: "用户饮食偏好", content: "指挥官不吃辣。", raw: "## 用户饮食偏好\n指挥官不吃辣。" },
  ];

  it("命中话题的块被检索到，无关块被排除", () => {
    const hit = retrieveMindChunks(chunks, "状态管理方案怎么定？");
    expect(hit).toHaveLength(1);
    expect(hit[0].heading).toBe("前端状态管理");
  });

  it("英文关键词同样命中", () => {
    const hit = retrieveMindChunks(chunks, "should we use Zustand here?");
    expect(hit.map((c) => c.heading)).toEqual(["前端状态管理"]);
  });

  it("无匹配时返回空数组", () => {
    expect(retrieveMindChunks(chunks, "今天天气怎么样")).toEqual([]);
    expect(retrieveMindChunks([], "状态管理")).toEqual([]);
  });

  it("按相关度降序返回，limit 生效，平分保持文件顺序", () => {
    const many: MindChunk[] = [
      { heading: "工具链", content: "Vite 构建。", raw: "## 工具链\nVite 构建。" },
      { heading: "状态管理", content: "状态管理用 Zustand，工具链用 Vite。", raw: "## 状态管理\n状态管理用 Zustand，工具链用 Vite。" },
      { heading: "工具偏好", content: "喜欢 pnpm。", raw: "## 工具偏好\n喜欢 pnpm。" },
    ];
    // query "状态管理工具"：状态管理块命中 token 最多，其余两块平分
    const hit = retrieveMindChunks(many, "状态管理工具", 2);
    expect(hit).toHaveLength(2);
    expect(hit[0].heading).toBe("状态管理");
    expect(hit[1].heading).toBe("工具链");
  });
});

describe("新建 Agent 默认文件", () => {
  it("ensureMindFiles 生成默认 SOUL.md 与占位 MIND.md", async () => {
    await ensureMindFiles(AGENT_ID);
    const dir = getAgentDir(AGENT_ID);
    expect(await fs.readFile(path.join(dir, "SOUL.md"), "utf-8")).toBe(DEFAULT_SOUL_TEMPLATE);
    expect(await fs.readFile(path.join(dir, "MIND.md"), "utf-8")).toBe(DEFAULT_MIND_CONTENT);
  });

  it("已存在的文件不被覆盖", async () => {
    await writeAgentFile("SOUL.md", "# 已定制的人格");
    await ensureMindFiles(AGENT_ID);
    const dir = getAgentDir(AGENT_ID);
    expect(await fs.readFile(path.join(dir, "SOUL.md"), "utf-8")).toBe("# 已定制的人格");
    // MIND.md 不存在，仍被创建
    expect(await fs.readFile(path.join(dir, "MIND.md"), "utf-8")).toBe(DEFAULT_MIND_CONTENT);
  });
});
