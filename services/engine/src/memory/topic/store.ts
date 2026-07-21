import fs from "node:fs/promises";
import path from "node:path";
import { getAgentDir } from "../../config/paths.js";
import { renameWithRetry } from "../document-store.js";
import type { CompressedTopic } from "./types.js";

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
    `topic_id: ${topic.topicId}`,
    `embedding_id: ${topic.embeddingId ?? ""}`,
    `label: ${fmValue(topic.label)}`,
    `importance: ${topic.importance}`,
    `source_id: ${topic.sourceId}`,
    `source_name: ${fmValue(topic.sourceName ?? "")}`,
    `compressed_at: ${topic.compressedAt}`,
    `msg_count: ${topic.msgCount}`,
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

interface ParsedCompressedFile {
  compressedAt: string;
  text: string;
}

/** 解析压缩档，渲染为 L5 注入文本；frontmatter 损坏时返回 null（单档跳过） */
function parseCompressedFile(raw: string): ParsedCompressedFile | null {
  const fmMatch = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!fmMatch) return null;
  const fm: Record<string, string> = {};
  for (const line of fmMatch[1]!.split("\n")) {
    const idx = line.indexOf(":");
    if (idx > 0) fm[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
  }
  const compressedAt = fm["compressed_at"];
  if (!compressedAt) return null;

  const body = fmMatch[2]!;
  const summary = body.match(/## Summary\n\n([\s\S]*?)(?=\n## )/)?.[1]?.trim() ?? "";
  const keyPointsBlock = body.match(/## Key Points\n\n([\s\S]*?)(?=\n## |$)/)?.[1]?.trim() ?? "";
  const label = fm["label"] || "（未命名话题）";

  const parts = [`[话题摘要] ${label}（${compressedAt.slice(0, 10)}）`];
  if (summary) parts.push(summary);
  if (keyPointsBlock) parts.push(`关键结论：\n${keyPointsBlock}`);
  return { compressedAt, text: parts.join("\n") };
}

/**
 * 读取最近 count 个压缩档，渲染为 L5 注入文本。
 * topicId 自带时间戳前缀（tp_<Date.now()>），文件名倒序即时间倒序：
 * 先按文件名取前 N 个再读内容，避免每轮全量扫描目录。
 * 目录不存在/单档损坏不中断，最多返回空数组。
 */
export async function latestSummaries(agentId: string, count: number): Promise<string[]> {
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
  const parsed: string[] = [];
  for (const file of candidates) {
    try {
      const raw = await fs.readFile(path.join(compressedDir(agentId), file), "utf-8");
      const p = parseCompressedFile(raw);
      if (p) parsed.push(p.text);
    } catch (err) {
      console.warn(`[topic] 压缩档读取失败，已跳过：${file}`, err);
    }
  }
  return parsed;
}
