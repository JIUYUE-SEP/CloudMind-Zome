import type { ChatMessage } from "@mindcloud/shared";
import type { LLMProvider } from "../../provider/types.js";
import { messageText, type CompressedTopic, type TopicSegment } from "./types.js";

/** 压缩调用超时（对齐 grok 的 wall_clock_budget_secs=60） */
const COMPRESS_TIMEOUT_MS = 60_000;

const MAX_KEY_POINTS = 5;

function buildPrompt(segment: TopicSegment): string {
  const lines = segment.messages
    .map((m) => `${m.role === "user" ? "用户" : "助手"}: ${messageText(m)}`)
    .join("\n");
  return [
    "你是对话归档助手。把下面的对话片段压缩为摘要，严格按以下格式输出，不要输出任何其他内容：",
    "",
    "话题主题：<一句话概括主题>",
    "关键结论：",
    "- <关键决策、事实或结论，最多 5 条，每条一行>",
    "",
    "对话片段：",
    lines,
  ].join("\n");
}

/** 非流式收集一次 chat 调用的全部文本（至 step.end 或迭代结束），带超时保护 */
async function collectChatText(
  provider: LLMProvider,
  model: string,
  prompt: string,
  timeoutMs: number,
): Promise<string> {
  const message: ChatMessage = {
    id: `compress_${Date.now()}`,
    role: "user",
    content: [{ type: "text", text: prompt }],
    createdAt: new Date().toISOString(),
  };

  // 手动持迭代器：超时时调用 return() 终止生成器，级联中止底层 HTTP 流
  // （此前只 reject 外层 Promise，生成器继续空转，泄漏一次连接直到流自然结束）
  const it = provider.chat({ model, messages: [message] })[Symbol.asyncIterator]();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await new Promise<string>((resolve, reject) => {
      let text = "";
      timeout = setTimeout(() => {
        void it.return?.();
        reject(new Error("compress timeout"));
      }, timeoutMs);
      (async () => {
        for (;;) {
          const { done, value } = await it.next();
          if (done) break;
          if (value.type === "text.delta") text += value.delta;
          if (value.type === "step.end") break;
        }
        return text;
      })().then(resolve, reject);
    });
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

interface ParsedSummary {
  label: string;
  keyPoints: string[];
}

/** 解析「话题主题：… / 关键结论：- …」格式；解析失败走兜底，不让坏输出阻断归档 */
function parseSummary(reply: string, fallbackText: string): ParsedSummary {
  const labelMatch = reply.match(/话题主题[：:]\s*(.+)/);
  const label = labelMatch?.[1]?.trim();
  const keyPoints = reply
    .split("\n")
    .map((line) => line.match(/^\s*[-•]\s*(.+)$/)?.[1]?.trim())
    .filter((p): p is string => !!p)
    .slice(0, MAX_KEY_POINTS);
  if (label) return { label, keyPoints };
  return {
    label: "（未命名话题）",
    keyPoints: keyPoints.length > 0 ? keyPoints : [fallbackText.slice(0, 200)],
  };
}

/**
 * LLM 单程压缩：生成摘要 + 关键点。
 * 压缩模型由调用方解析（compressionModel || 主模型）；失败不 fallback（设计决策 2），
 * 异常直接抛给 queue，原始消息保持不动。
 */
export async function compressTopic(
  segment: TopicSegment,
  provider: LLMProvider,
  model: string,
  /** 超时毫秒数，默认 60s（对齐 grok wall_clock_budget_secs）；测试可传小值 */
  timeoutMs: number = COMPRESS_TIMEOUT_MS,
): Promise<CompressedTopic> {
  const fallbackText = segment.messages.map(messageText).join("\n").slice(0, 500);
  const reply = (await collectChatText(provider, model, buildPrompt(segment), timeoutMs)).trim();
  const { label, keyPoints } = parseSummary(reply, fallbackText);
  return {
    topicId: segment.topicId,
    label,
    summary: reply || fallbackText,
    keyPoints,
    msgIds: segment.messages.map((m) => m.id),
    msgCount: segment.messages.length,
    importance: "normal",
    sourceId: segment.sourceId,
    sourceName: segment.sourceName,
    compressedAt: new Date().toISOString(),
  };
}
