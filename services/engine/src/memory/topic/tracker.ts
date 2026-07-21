import { randomUUID } from "node:crypto";
import type { ChatMessage } from "@mindcloud/shared";
import { detectTopicBoundary } from "./detector.js";
import type { TopicCompressionConfig, TopicSegment } from "./types.js";

// 太短的话题不压缩：一两句话就产一个压缩档只会制造噪声
export const MIN_SEGMENT_MESSAGES = 4;

/**
 * per-agent 话题跟踪（TopicContext 的规则版）。
 * 状态只存内存：进程重启后未压缩的 segment 丢失，但消息仍在热存储，
 * 由下一轮话题关闭时自然覆盖，不做跨重启追溯。
 */
export class TopicTracker {
  private current: ChatMessage[] = [];

  constructor(
    private config: Pick<
      TopicCompressionConfig,
      "enabled" | "windowMinutes" | "messageThreshold"
    >,
    private sourceId: string,
    private sourceName?: string,
  ) {}

  /** 新用户消息到达（turn 开始前）调用；返回被关闭的话题片段（无则 null） */
  onUserMessage(msg: ChatMessage): TopicSegment | null {
    if (!this.config.enabled) {
      this.current.push(msg);
      return null;
    }
    const prev = this.current[this.current.length - 1];
    const boundary = detectTopicBoundary({
      prevMessage: prev,
      newMessage: msg,
      currentCount: this.current.length,
      windowMinutes: this.config.windowMinutes,
      messageThreshold: this.config.messageThreshold,
    });
    if (boundary === "new_topic") {
      const closed = this.closeSegment();
      this.current.push(msg);
      return closed;
    }
    this.current.push(msg);
    return null;
  }

  /** turn 完成（assistant/tool 消息落库前）调用；达到数量阈值则关闭当前话题 */
  onTurnAppended(messages: ChatMessage[]): TopicSegment | null {
    if (!this.config.enabled) return null;
    this.current.push(...messages);
    if (this.current.length >= this.config.messageThreshold) {
      return this.closeSegment();
    }
    return null;
  }

  /** 关闭当前话题；消息太少时不产出 segment（消息留在热存储不追溯） */
  private closeSegment(): TopicSegment | null {
    const messages = this.current;
    this.current = [];
    if (messages.length < MIN_SEGMENT_MESSAGES) return null;
    const first = messages[0]!;
    const last = messages[messages.length - 1]!;
    return {
      topicId: `tp_${Date.now()}_${randomUUID().slice(0, 8)}`,
      messages,
      sourceId: this.sourceId,
      sourceName: this.sourceName,
      startedAt: first.createdAt,
      endedAt: last.createdAt,
    };
  }
}
