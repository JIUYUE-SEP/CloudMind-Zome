import { randomUUID } from "node:crypto";
import type { ChatMessage } from "@mindcloud/shared";
import type { SemanticMemory, TopicSummary } from "./layers.js";
import type { MindChunk } from "../mind/mind-files.js";

/**
 * 记忆自然化（最终设计）：
 * L4/L5 检索结果不再以 system 元信息注入，而是改写成第三人称、
 * 带真实时间戳的 user 历史消息，让模型像"自然想起"而非"被塞了检索结果"。
 * 检索失败则相反——诚实透明，明确告知。
 */

/** 置信度阈值（设计决策）：> 0.7 正常注入；(0.5, 0.7] 模糊化注入；≤ 0.5 丢弃 */
export const CONFIDENCE_HIGH = 0.7;
export const CONFIDENCE_DROP = 0.5;
/** 单条注入内容长度上限，超过则摘要化（保留首尾、中段省略） */
export const MAX_MEMORY_CHARS = 500;

export type Confidence = "high" | "fuzzy" | "drop";

export function classifyScore(score: number): Confidence {
  if (score > CONFIDENCE_HIGH) return "high";
  if (score > CONFIDENCE_DROP) return "fuzzy";
  return "drop";
}

/** 相对时间：让心智对"多久以前"有直观感受（配合绝对时间可算精确时间差） */
export function relativeTime(createdAt: string, now: number = Date.now()): string {
  const diff = now - Date.parse(createdAt);
  if (!Number.isFinite(diff) || diff < 60_000) return "刚刚";
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 60) return `${minutes}分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}小时前`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}天前`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}个月前`;
  return `${Math.floor(months / 12)}年前`;
}

/** "2026-07-10 15:30 · 12天前"；无法解析时原样返回，不崩溃 */
export function formatMemoryTime(createdAt: string, now: number = Date.now()): string {
  if (!Number.isFinite(Date.parse(createdAt))) return createdAt;
  const absolute = createdAt.slice(0, 16).replace("T", " ");
  return `${absolute} · ${relativeTime(createdAt, now)}`;
}

/**
 * 长度控制（设计决策 7）：超过 500 字符摘要化注入。
 * 规则式摘要——保留首尾（开头通常是问题、结尾通常是结论），中段标注省略字数。
 */
export function summarizeContent(text: string, maxChars: number = MAX_MEMORY_CHARS): string {
  if (text.length <= maxChars) return text;
  const head = Math.floor(maxChars * 0.6);
  const tail = Math.floor(maxChars * 0.3);
  const omitted = text.length - head - tail;
  return `${text.slice(0, head)}\n……（中段省略 ${omitted} 字）……\n${text.slice(-tail)}`;
}

/**
 * L4 语义记忆 → 伪装成 user 历史消息。
 * 第三人称叙述（"用户之前提到过"），避免"你/我/我们"的亲密错觉；
 * 低置信度模糊化（"好像"、"记忆有些模糊"）；≤ 0.5 返回 null（丢弃）。
 * createdAt 保留原始时间戳——心智拥有真实时间感。
 */
export function memoryToMessage(mem: SemanticMemory, now: number = Date.now()): ChatMessage | null {
  if (classifyScore(mem.score) === "drop") return null;
  const fuzzy = classifyScore(mem.score) === "fuzzy";
  const time = formatMemoryTime(mem.createdAt, now);
  const content = summarizeContent(mem.content);
  const where = mem.source ? "在另一个对话里" : "";
  const recall = fuzzy ? "好像提到过" : "提到过";
  const caveat = fuzzy ? "（这段记忆有些模糊，可能不准确）" : "";
  const text = `[${time}] 用户之前${where}${recall}：「${content}」${caveat}`;
  return {
    id: `mem-${mem.id}`,
    role: "user",
    content: [{ type: "text", text }],
    createdAt: mem.createdAt,
  };
}

/** L5 话题摘要 → 伪装成 user 历史消息（压缩档摘要自然化注入） */
export function topicToMessage(topic: TopicSummary, now: number = Date.now()): ChatMessage {
  const time = formatMemoryTime(topic.createdAt, now);
  const text = `[${time}] 用户之前聊过「${topic.label}」这个话题：\n${summarizeContent(topic.text)}`;
  return {
    id: `topic-${topic.id}`,
    role: "user",
    content: [{ type: "text", text }],
    createdAt: topic.createdAt,
  };
}

/**
 * MIND.md 经验块 → 伪装成 assistant 历史消息（第一人称想起自己的经验档案）。
 * 注入位置在热上下文之后（assembler 显式追加，不参与时间归并），
 * createdAt 取注入时刻——经验是"现在想起的"，不属于过去某个时间点。
 */
export function mindToMessage(chunks: MindChunk[], now: number = Date.now()): ChatMessage {
  const text = `我记得自己积累过这些经验：\n\n${chunks.map((c) => c.raw).join("\n\n")}`;
  return {
    id: "mind-recall",
    role: "assistant",
    content: [{ type: "text", text }],
    createdAt: new Date(now).toISOString(),
  };
}

/**
 * 检索失败明确告知（诚实透明，与自然化注入互为两面）：
 * 不作为历史伪装，而是尾随的 system 提示，模型应明确说明检索不可用。
 */
export function retrievalFailedMessage(): ChatMessage {
  return {
    id: randomUUID(),
    role: "system",
    content: [
      {
        type: "text",
        text: "[记忆检索暂时不可用] 本次仅基于当前对话回答；如需引用过往记忆，请明确告知用户检索失败。",
      },
    ],
    createdAt: new Date().toISOString(),
  };
}
