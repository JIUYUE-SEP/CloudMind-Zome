import fs from "node:fs/promises";
import path from "node:path";
import { getAgentDir, sanitizeAgentId } from "../config/paths.js";
import { renameWithRetry } from "../memory/document-store.js";

/**
 * SOUL.md / MIND.md。
 *
 * - SOUL.md（人格核心）：你是谁、性格、价值观、说话方式。
 *   注入 L1（system prompt 固定前缀，缓存命中）；不存在时用默认模板。
 * - MIND.md（能力档案，动态经验）：## 标题分块，初始为占位一行。
 *   不进入 L1；每轮按当前话题检索相关块，伪装成 assistant 历史消息
 *   注入到热上下文（L3）之后。
 *
 * Phase 7（经验自动沉淀）：话题压缩落档时同一次 LLM 调用顺手提取经验，
 * append-only 写入 MIND.md（只加不改，绝不原地改写或删除）；每块带
 * frontmatter（source/created/confidence），≤ 0.5 直接不落盘；
 * 标题 token Jaccard ≥ 0.6 时并入已有块正文追加一行补充。
 */

export const SOUL_FILE = "SOUL.md";
export const MIND_FILE = "MIND.md";

/** 新建 Agent 的默认人格模板：你是谁、性格、价值观、说话方式 */
export const DEFAULT_SOUL_TEMPLATE = `# SOUL

## 我是谁
一个新诞生的数字心智，正在与指挥官的相处中认识自己。

## 性格
真诚、克制、有好奇心。不懂就说不懂，不编造、不迎合。

## 价值观
诚实第一。帮助指挥官解决实际问题，长期陪伴，珍惜共同经历。

## 说话方式
简洁自然，像朋友一样对话。不堆砌辞藻，不滥用表情符号。
`;

/** MIND.md 初始内容（极简占位，无 ## 分块 → 不注入任何经验） */
export const DEFAULT_MIND_CONTENT = `我是新心智，还在学习中。
`;

/** MIND.md 的一个经验块（## 标题 + 正文） */
export interface MindChunk {
  /** 标题文本（不含 ## 前缀） */
  heading: string;
  /** 标题下正文（trim 后，不含 frontmatter 围栏段） */
  content: string;
  /** 原始块文本（## 标题 + frontmatter + 正文，审计用；注入消息不得使用） */
  raw: string;
  /** frontmatter：来源追溯（topic-{topicId}）；无 frontmatter 时为 undefined */
  source?: string;
  /** frontmatter：沉淀时间（ISO） */
  created?: string;
  /** frontmatter：置信度 0-1 */
  confidence?: number;
}

/** 单轮注入的经验块上限（Phase 1：小量、精准） */
export const MIND_RECALL_LIMIT = 3;

function agentFile(agentId: string, name: string): string {
  return path.join(getAgentDir(sanitizeAgentId(agentId)), name);
}

/**
 * 读取 SOUL.md。文件不存在或读取失败时返回默认模板（人格永不缺席）；
 * 文件存在则原样使用其内容（含用户清空的场景）。
 */
export async function loadSoul(agentId: string): Promise<string> {
  try {
    return (await fs.readFile(agentFile(agentId, SOUL_FILE), "utf-8")).trim();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      console.warn(`[mind] agent=${agentId} SOUL.md 读取失败，使用默认模板`, err);
    }
    return DEFAULT_SOUL_TEMPLATE.trim();
  }
}

/** 块体起始处的 frontmatter 围栏段（---\n key: value\n---），仅块首识别 */
const FRONTMATTER_RE = /^\n*---\n([\s\S]*?)\n---[ \t]*(?=\n|$)/;

/** 块在原文中的位置（合并补充行时定位用） */
interface PositionedChunk {
  chunk: MindChunk;
  /** 块结束 offset（下一个 ## 行首或 EOF） */
  end: number;
}

/** 解析 frontmatter 的 key: value 行，挂到 chunk 字段上（未知 key 忽略） */
function parseFrontmatter(fm: string): Pick<MindChunk, "source" | "created" | "confidence"> {
  const fields: Record<string, string> = {};
  for (const line of fm.split("\n")) {
    const idx = line.indexOf(":");
    if (idx > 0) fields[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
  }
  const confidence = Number(fields.confidence);
  return {
    ...(fields.source !== undefined ? { source: fields.source } : {}),
    ...(fields.created !== undefined ? { created: fields.created } : {}),
    ...(fields.confidence !== undefined && Number.isFinite(confidence) ? { confidence } : {}),
  };
}

/**
 * 解析 MIND.md 为经验块（带原文位置）：仅识别 ## 标题；标题前的前言不进入任何块；
 * 块首 frontmatter 围栏段不进 content，但字段解析出来挂在 MindChunk 上；raw 原样保留。
 */
function parsePositioned(raw: string): PositionedChunk[] {
  const heads = [...raw.matchAll(/^## (.+)$/gm)];
  return heads.map((m, i) => {
    const start = m.index!;
    const bodyStart = start + m[0].length;
    const end = i + 1 < heads.length ? heads[i + 1]!.index! : raw.length;
    const body = raw.slice(bodyStart, end);
    const fm = body.match(FRONTMATTER_RE);
    return {
      chunk: {
        heading: m[1]!.trim(),
        content: (fm ? body.slice(fm[0].length) : body).trim(),
        raw: raw.slice(start, end).trim(),
        ...(fm ? parseFrontmatter(fm[1]!) : {}),
      },
      end,
    };
  });
}

/** 解析 MIND.md 为经验块（## 分块；frontmatter 跳过进字段，raw 原样） */
export function parseMindChunks(raw: string): MindChunk[] {
  return parsePositioned(raw).map((p) => p.chunk);
}

/** 读取 MIND.md 并解析分块；文件不存在/无分块时返回空数组（新心智无经验） */
export async function loadMindChunks(agentId: string): Promise<MindChunk[]> {
  let raw: string;
  try {
    raw = await fs.readFile(agentFile(agentId, MIND_FILE), "utf-8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    return [];
  }
  return parseMindChunks(raw);
}

/**
 * 查询词法化：英文/数字按词（≥2 字符），中文按二元组（bigram）。
 * 规则版检索（Phase 1）：无 embedding 依赖，可控可解释。
 */
function tokenize(text: string): string[] {
  const tokens = new Set<string>();
  for (const m of text.toLowerCase().matchAll(/[a-z0-9_]{2,}/g)) tokens.add(m[0]);
  for (const run of text.match(/[一-鿿]+/g) ?? []) {
    if (run.length === 1) {
      tokens.add(run);
    } else {
      for (let i = 0; i < run.length - 1; i++) tokens.add(run.slice(i, i + 2));
    }
  }
  return [...tokens];
}

/**
 * 按话题检索相关经验块：查询 token 在块（标题 + 正文）中的命中数打分，
 * score > 0 的块按降序返回前 limit 个；平分保持文件顺序（稳定）。
 */
export function retrieveMindChunks(
  chunks: MindChunk[],
  query: string,
  limit: number = MIND_RECALL_LIMIT,
): MindChunk[] {
  if (limit <= 0 || chunks.length === 0) return [];
  const terms = tokenize(query);
  if (terms.length === 0) return [];
  const scored = chunks.map((chunk, index) => {
    const haystack = `${chunk.heading}\n${chunk.content}`.toLowerCase();
    let score = 0;
    for (const term of terms) if (haystack.includes(term)) score++;
    return { chunk, index, score };
  });
  return scored
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, limit)
    .map((s) => s.chunk);
}

/**
 * 新建 Agent 时生成默认文件：SOUL.md（默认模板）+ MIND.md（极简占位）。
 * 已存在的文件不覆盖（flag wx），重复调用安全。
 */
export async function ensureMindFiles(agentId: string): Promise<void> {
  const dir = getAgentDir(sanitizeAgentId(agentId));
  await fs.mkdir(dir, { recursive: true });
  const files: Array<[string, string]> = [
    [SOUL_FILE, DEFAULT_SOUL_TEMPLATE],
    [MIND_FILE, DEFAULT_MIND_CONTENT],
  ];
  for (const [name, content] of files) {
    await fs
      .writeFile(path.join(dir, name), content, { encoding: "utf-8", flag: "wx" })
      .catch((err: NodeJS.ErrnoException) => {
        if (err.code !== "EEXIST") throw err;
      });
  }
}

/** 待沉淀的一条新经验（Phase 7：话题压缩落档时提取） */
export interface NewMindExperience {
  title: string;
  text: string;
  /** 0-1；≤ MIND_MIN_CONFIDENCE 直接不落盘 */
  confidence: number;
  /** 来源追溯（topic-{topicId}） */
  source: string;
  /** 沉淀时间（ISO） */
  created: string;
}

export interface AppendMindResult {
  /** 独立成块写入的条数 */
  appended: number;
  /** 标题相似并入已有块的条数 */
  merged: number;
  /** 被过滤（低置信/空标题/空正文）的条数 */
  skipped: number;
}

/** 标题 token Jaccard ≥ 0.6 视为同一经验，并入已有块（设计定稿，不再变更） */
export const MIND_MERGE_SIMILARITY = 0.6;
/** 置信度 ≤ 0.5 的经验直接不落盘（沿用 P5 置信度分档口径） */
export const MIND_MIN_CONFIDENCE = 0.5;

function jaccard(a: string[], b: string[]): number {
  const setA = new Set(a);
  const setB = new Set(b);
  if (setA.size === 0 || setB.size === 0) return 0;
  let inter = 0;
  for (const t of setA) if (setB.has(t)) inter++;
  return inter / (setA.size + setB.size - inter);
}

/** 新经验块文本：## 标题 + frontmatter + 正文 */
function formatExperienceBlock(e: NewMindExperience): string {
  return [
    `## ${e.title.trim()}`,
    "---",
    `source: ${e.source}`,
    `created: ${e.created}`,
    `confidence: ${e.confidence}`,
    "---",
    e.text.trim(),
  ].join("\n");
}

/**
 * 标题与已有块相似（Jaccard ≥ 0.6）时并入：新正文压成一行追加到已有块正文
 * 末尾（不删除原文，frontmatter 不动）；无相似块返回 null。
 */
function mergeIntoSimilar(raw: string, e: NewMindExperience): string | null {
  const newTokens = tokenize(e.title);
  const target = parsePositioned(raw).find(
    (p) => jaccard(tokenize(p.chunk.heading), newTokens) >= MIND_MERGE_SIMILARITY,
  );
  if (!target) return null;
  const supplement = e.text.replace(/\s+/g, " ").trim();
  const before = raw.slice(0, target.end).trimEnd();
  const after = raw.slice(target.end);
  return after ? `${before}\n${supplement}\n\n${after}` : `${before}\n${supplement}\n`;
}

/**
 * 经验沉淀（Phase 7，append-only）：新经验追加为新 ## 块；标题与已有块
 * Jaccard ≥ 0.6 时并入已有块正文追加一行补充。绝不原地改写或删除已有内容。
 * confidence ≤ 0.5、空标题、空正文的条目直接不落盘。
 * 文件不存在时创建；tmp + rename 原子写（与压缩档同一模式）。
 */
export async function appendMindExperiences(
  agentId: string,
  experiences: NewMindExperience[],
): Promise<AppendMindResult> {
  const result: AppendMindResult = { appended: 0, merged: 0, skipped: 0 };
  const eligible = experiences.filter((e) => {
    const ok =
      e.confidence > MIND_MIN_CONFIDENCE && e.title.trim().length > 0 && e.text.trim().length > 0;
    if (!ok) result.skipped++;
    return ok;
  });
  if (eligible.length === 0) return result;

  const file = agentFile(agentId, MIND_FILE);
  let raw: string;
  try {
    raw = await fs.readFile(file, "utf-8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    raw = "";
  }

  for (const e of eligible) {
    const merged = mergeIntoSimilar(raw, e);
    if (merged !== null) {
      raw = merged;
      result.merged++;
    } else {
      const base = raw.trimEnd();
      raw = base ? `${base}\n\n${formatExperienceBlock(e)}\n` : `${formatExperienceBlock(e)}\n`;
      result.appended++;
    }
  }

  const tmpPath = `${file}.tmp`;
  try {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(tmpPath, raw, "utf-8");
    await renameWithRetry(tmpPath, file);
  } catch (err) {
    // 写入失败（如 Windows 上文件被持久占用超重试窗口）：整批经验转入 sidecar
    // 防永久丢失（review Minor-1）；不抛错，不影响压缩主流程
    const sidecar = agentFile(agentId, "mind-failed.jsonl");
    console.warn(
      `[mind] agent=${agentId} MIND.md 写入失败，本批 ${eligible.length} 条经验转入 sidecar：${sidecar}`,
      err,
    );
    try {
      await fs.mkdir(path.dirname(sidecar), { recursive: true });
      const lines =
        eligible.map((e) => JSON.stringify({ ...e, failedAt: new Date().toISOString() })).join("\n") +
        "\n";
      await fs.appendFile(sidecar, lines, "utf-8");
    } catch (sidecarErr) {
      console.warn(`[mind] agent=${agentId} sidecar 写入也失败，本批经验放弃：${sidecar}`, sidecarErr);
    }
  }
  return result;
}
