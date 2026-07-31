import { logger } from "../../logger.js";
import fs from "node:fs/promises";
import path from "node:path";
import { getAgentDir } from "../../config/paths.js";
import { renameWithRetry } from "../document-store.js";
import {
  CURRENT_SCHEMA_VERSION,
  MigrationChain,
  UnsupportedSchemaVersionError,
  frontmatterVersion,
} from "../../versioning.js";
import type { CompressedTopic } from "./types.js";
import type { TopicSummary } from "../../context/layers.js";

/** 压缩档 frontmatter 迁移链（P1-1）：当前 v1 无实际迁移，机制就位 */
const COMPRESSED_TOPIC_CHAIN = new MigrationChain<Record<string, string>>(CURRENT_SCHEMA_VERSION);

export function compressedDir(agentId: string): string {
  return path.join(getAgentDir(agentId), "_compressed");
}

/** frontmatter 值只放单行，换行/冒号冲突压平 */
function fmValue(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

/** 写入压缩档：markdown + frontmatter（格式见设计文档 §三） */
export async function writeCompressedTopic(
  agentId: string,
  topic: CompressedTopic,
): Promise<string> {
  const lines = [
    "---",
    `schema: ${COMPRESSED_TOPIC_CHAIN.currentVersion}`,
    `topic_id: ${topic.topicId}`,
    `embedding_id: ${topic.embeddingId ?? ""}`,
    `label: ${fmValue(topic.label)}`,
    `importance: ${topic.importance}`,
    `source_id: ${topic.sourceId}`,
    `source_name: ${fmValue(topic.sourceName ?? "")}`,
    `compressed_at: ${topic.compressedAt}`,
    `msg_count: ${topic.msgCount}`,
    `used_skills: ${(topic.usedSkills ?? []).map(fmValue).join(", ")}`,
    "---",
    "",
    "## Summary",
    "",
    topic.summary,
    "",
    "## Key Points",
    "",
    ...topic.keyPoints.map((p) => `- ${p}`),
    "",
    "## Messages Archived",
    "",
    topic.msgIds.join(", "),
    "",
  ];
  const dir = compressedDir(agentId);
  await fs.mkdir(dir, { recursive: true });
  const filePath = path.join(dir, `${topic.topicId}.md`);
  // tmp + rename 原子写：崩溃不留半截压缩档（与 DocumentStore 同一模式）
  const tmpPath = `${filePath}.tmp`;
  await fs.writeFile(tmpPath, lines.join("\n"), "utf-8");
  await renameWithRetry(tmpPath, filePath);
  return filePath;
}

/** 删除压缩档（归档失败时隔离用：避免"摘要已注入 + 原文仍在热存储"的重复） */
export async function removeCompressedTopic(agentId: string, topicId: string): Promise<void> {
  await fs.unlink(path.join(compressedDir(agentId), `${topicId}.md`)).catch(() => {});
}

/**
 * archivedMessageIds 的按档缓存：压缩档一经写入不再变化（topicId 唯一、单档原子写），
 * 以 (mtimeMs, size) 指纹兜底外部改动。L4 每轮都调 archivedMessageIds，
 * 命中时只付 readdir + stat，不再每轮全量读所有 .md 内容。
 */
const archivedIdsCache = new Map<string, { mtimeMs: number; size: number; ids: string[] }>();

/**
 * 已压缩话题的原始消息 id 全集（L4 归档排除用）：
 * 读全部压缩档的 "## Messages Archived" 段，避免每轮全量读 messages_archived.jsonl
 * （归档文件只增不减；压缩档 frontmatter 体积小得多）。
 * 注意：archiveOnly 短话题没有压缩档，其消息不在此集合——它们没有 L5 摘要，
 * 被 L4 检索到是预期行为，不算重复。
 */
export async function archivedMessageIds(agentId: string): Promise<Set<string>> {
  const ids = new Set<string>();
  const dir = compressedDir(agentId);
  let files: string[];
  try {
    files = await fs.readdir(dir);
  } catch {
    return ids;
  }
  const present = new Set<string>();
  for (const file of files) {
    if (!file.endsWith(".md")) continue;
    const filePath = path.join(dir, file);
    present.add(filePath);
    try {
      const stat = await fs.stat(filePath);
      const cached = archivedIdsCache.get(filePath);
      if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
        for (const id of cached.ids) ids.add(id);
        continue;
      }
      const raw = await fs.readFile(filePath, "utf-8");
      // 版本门禁（P1-1）：高版本档显式报错，而不是按旧格式正则静默抠字段
      assertCompressedVersion(raw, filePath);
      const section = raw.match(/## Messages Archived\n\n([\s\S]*?)$/)?.[1]?.trim();
      const fileIds = section
        ? section.split(",").map((s) => s.trim()).filter(Boolean)
        : [];
      archivedIdsCache.set(filePath, { mtimeMs: stat.mtimeMs, size: stat.size, ids: fileIds });
      for (const id of fileIds) ids.add(id);
    } catch (err) {
      // 版本过高（数据由更新版本的程序写入）显式上抛，不按坏档静默跳过
      if (err instanceof UnsupportedSchemaVersionError) throw err;
      logger.warn({ err: err }, `[topic] 压缩档读取失败，已跳过：${file}`);
    }
  }
  // 清理已删除压缩档的缓存项（removeCompressedTopic / 外部清理），避免无限增长
  for (const key of archivedIdsCache.keys()) {
    if (path.dirname(key) === dir && !present.has(key)) archivedIdsCache.delete(key);
  }
  return ids;
}

interface ParsedCompressedFile {
  topicId: string;
  label: string;
  compressedAt: string;
  /** 摘要正文：summary + 关键结论（不含 label 与元信息包装） */
  text: string;
  /** 阶段 5 二期：该话题内使用过的技能名（无字段的旧档为 undefined） */
  usedSkills?: string[];
}

/** 解析 frontmatter 块的 key: value 行（未知 key 保留，供版本迁移链使用） */
function parseFrontmatterBlock(block: string): Record<string, string> {
  const fm: Record<string, string> = {};
  for (const line of block.split("\n")) {
    const idx = line.indexOf(":");
    if (idx > 0) fm[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
  }
  return fm;
}

/**
 * 只做版本门禁的轻量检查（P1-1）：archivedMessageIds 按正则抠正文段、不解析
 * frontmatter，但高版本档必须显式报错，不能按旧格式静默抠字段
 */
function assertCompressedVersion(raw: string, filePath: string): void {
  const block = raw.match(/^---\n([\s\S]*?)\n---/)?.[1];
  if (!block) return; // 无 frontmatter 属损坏档，交给调用方既有的单档降级
  const fm = parseFrontmatterBlock(block);
  COMPRESSED_TOPIC_CHAIN.migrate(fm, frontmatterVersion(fm), filePath);
}

/** 解析压缩档为结构化条目；frontmatter 损坏时返回 null（单档跳过） */
function parseCompressedFile(raw: string, fallbackId: string): ParsedCompressedFile | null {
  const fmMatch = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!fmMatch) return null;
  // 版本字段（P1-1）：无 schema 的旧档视为 v1；高版本抛 UnsupportedSchemaVersionError
  //（不判废跳过——档没坏，是代码太旧）；旧版经迁移链惰性迁移
  const fmRaw = parseFrontmatterBlock(fmMatch[1]!);
  const fm = COMPRESSED_TOPIC_CHAIN.migrate(fmRaw, frontmatterVersion(fmRaw), `压缩档 ${fallbackId}`);
  const compressedAt = fm["compressed_at"];
  if (!compressedAt) return null;

  const body = fmMatch[2]!;
  const summary = body.match(/## Summary\n\n([\s\S]*?)(?=\n## )/)?.[1]?.trim() ?? "";
  const keyPointsBlock = body.match(/## Key Points\n\n([\s\S]*?)(?=\n## |$)/)?.[1]?.trim() ?? "";

  const parts: string[] = [];
  if (summary) parts.push(summary);
  if (keyPointsBlock) parts.push(`关键结论：\n${keyPointsBlock}`);
  const usedSkills = (fm["used_skills"] ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return {
    topicId: fm["topic_id"] || fallbackId,
    label: fm["label"] || "（未命名话题）",
    compressedAt,
    text: parts.join("\n"),
    ...(usedSkills.length > 0 ? { usedSkills } : {}),
  };
}

/**
 * 读取最近 count 个压缩档，返回结构化 L5 条目（id/label/text/createdAt）。
 * 自然化改写与时间渲染由注入侧（context/recall.ts）负责，本层只供数据。
 * topicId 自带时间戳前缀（tp_<Date.now()>），文件名倒序即时间倒序：
 * 先按文件名取前 N 个再读内容，避免每轮全量扫描目录。
 * 目录不存在/单档损坏不中断，最多返回空数组。
 */
export async function latestSummaries(agentId: string, count: number): Promise<TopicSummary[]> {
  if (count <= 0) return [];
  let files: string[];
  try {
    files = await fs.readdir(compressedDir(agentId));
  } catch {
    return [];
  }
  const candidates = files
    .filter((f) => f.endsWith(".md"))
    .sort()
    .reverse()
    .slice(0, count);
  const parsed: TopicSummary[] = [];
  for (const file of candidates) {
    try {
      const raw = await fs.readFile(path.join(compressedDir(agentId), file), "utf-8");
      const p = parseCompressedFile(raw, file.replace(/\.md$/, ""));
      if (p) {
        parsed.push({
          id: p.topicId,
          label: p.label,
          text: p.text,
          createdAt: p.compressedAt,
          ...(p.usedSkills ? { usedSkills: p.usedSkills } : {}),
        });
      }
    } catch (err) {
      // 版本过高（数据由更新版本的程序写入）显式上抛，不按坏档静默跳过
      if (err instanceof UnsupportedSchemaVersionError) throw err;
      logger.warn({ err: err }, `[topic] 压缩档读取失败，已跳过：${file}`);
    }
  }
  return parsed;
}
