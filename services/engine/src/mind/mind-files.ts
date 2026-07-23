import fs from "node:fs/promises";
import path from "node:path";
import { getAgentDir, sanitizeAgentId } from "../config/paths.js";

/**
 * SOUL.md / MIND.md（Phase 1 基础框架）。
 *
 * - SOUL.md（人格核心）：你是谁、性格、价值观、说话方式。
 *   注入 L1（system prompt 固定前缀，缓存命中）；不存在时用默认模板。
 * - MIND.md（能力档案，动态经验）：## 标题分块，初始为占位一行。
 *   不进入 L1；每轮按当前话题检索相关块，伪装成 assistant 历史消息
 *   注入到热上下文（L3）之后。
 *
 * 后续扩展（不在 Phase 1）：从话题压缩提取经验自动更新 MIND.md（后台 LLM）。
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
  /** 标题下正文（trim 后） */
  content: string;
  /** 原始块文本（## 标题 + 正文，注入用） */
  raw: string;
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

/** 解析 MIND.md 为经验块：仅识别 ## 标题；标题前的前言不进入任何块 */
export function parseMindChunks(raw: string): MindChunk[] {
  const chunks: MindChunk[] = [];
  const heads = [...raw.matchAll(/^## (.+)$/gm)];
  for (let i = 0; i < heads.length; i++) {
    const m = heads[i]!;
    const bodyStart = m.index! + m[0].length;
    const end = i + 1 < heads.length ? heads[i + 1]!.index! : raw.length;
    chunks.push({
      heading: m[1]!.trim(),
      content: raw.slice(bodyStart, end).trim(),
      raw: raw.slice(m.index!, end).trim(),
    });
  }
  return chunks;
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
