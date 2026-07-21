import type { ChatMessage } from "@mindcloud/shared";
import { messageText } from "./types.js";

export interface TopicBoundaryInput {
  /** 当前话题的最新一条消息（无则话题刚开始） */
  prevMessage?: ChatMessage;
  newMessage: ChatMessage;
  /** 当前话题已累计的消息数（不含 newMessage） */
  currentCount: number;
  windowMinutes: number;
  messageThreshold: number;
}

// 用户显式切换话题的说法。设计决策 1：宁可不切也不错切——
// 只命中明确的切换意图，普通提及"话题"二字不算
const SWITCH_PATTERN = /换个话题|不说这个了|不聊这个了|聊点别的|换个别的话题|换个方向|开始新话题/;

/**
 * 规则版话题边界检测（v1）。
 * - 用户显式切换词 → new_topic
 * - 与上一条消息的时间间隔超过 windowMinutes → new_topic
 * - 当前话题消息数达到 messageThreshold → new_topic
 * 关键词/语义边界留给 Phase 3，默认同话题。
 */
export function detectTopicBoundary(input: TopicBoundaryInput): "new_topic" | "same" {
  if (input.currentCount >= input.messageThreshold) return "new_topic";

  if (input.newMessage.role === "user" && SWITCH_PATTERN.test(messageText(input.newMessage))) {
    return "new_topic";
  }

  if (input.prevMessage) {
    const prev = Date.parse(input.prevMessage.createdAt);
    const curr = Date.parse(input.newMessage.createdAt);
    if (
      Number.isFinite(prev) &&
      Number.isFinite(curr) &&
      curr - prev > input.windowMinutes * 60_000
    ) {
      return "new_topic";
    }
  }

  return "same";
}
