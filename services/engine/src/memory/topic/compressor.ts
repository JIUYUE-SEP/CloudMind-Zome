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
async function collectChatText(provider: LLMProvider, model: string, prompt: string): Promise<string> {
  const message: ChatMessage = {
    id: `compress_${Date.now()}`,
    role: "user",
    content: [{ type: "text", text: prompt }],
    createdAt: new Date().toISOString(),
  };

  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await new Promise<string>((resolve, reject) => {
      let text = "";
      timeout = setTimeout(() => reject(new Error("compress timeout")), COMPRESS_TIMEOUT_MS);
      (async () => {
        for await (const event of provider.chat({ model, messages: [message] })) {
          if (event.type === "text.delta") text += event.delta;
          if (event.type === "step.end") break;
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
): Promise<CompressedTopic> {
  const fallbackText = segment.messages.map(messageText).join("\n").slice(0, 500);
  const reply = (await collectChatText(provider, model, buildPrompt(segment))).trim();
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
