import { randomUUID } from "node:crypto";
import type { ChatMessage } from "@mindcloud/shared";
import { detectTopicBoundary } from "./detector.js";
import type { TopicCompressionConfig, TopicSegment } from "./types.js";

// 短话题不调用 LLM 压缩（一两句话就产一个压缩档只会制造噪声），仅归档
export const MIN_SEGMENT_MESSAGES = 4;

/**
 * per-agent 话题跟踪（TopicContext 的规则版）。
 * 状态只存内存。已知取舍：进程重启后 tracker 状态清空，重启前的未压缩
 * 消息成为孤儿——留在热存储且不再被追溯归档（当前不做启动对账）。
 * sourceId 随调用传入：同一 agent 可能跨多个会话，segment 记录关闭时所在场景。
 */
export class TopicTracker {
  private current: ChatMessage[] = [];
  private lastSourceId = "";
  private lastSourceName: string | undefined;

  constructor(
    private config: Pick<
      TopicCompressionConfig,
      "enabled" | "windowMinutes" | "messageThreshold"
    >,
  ) {}

  /** 新用户消息到达（turn 开始前）调用；返回被关闭的话题片段（无则 null） */
  onUserMessage(msg: ChatMessage, sourceId: string, sourceName?: string): TopicSegment | null {
    this.lastSourceId = sourceId;
    this.lastSourceName = sourceName;
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
  onTurnAppended(messages: ChatMessage[], sourceId: string, sourceName?: string): TopicSegment | null {
    this.lastSourceId = sourceId;
    this.lastSourceName = sourceName;
    if (!this.config.enabled) return null;
    this.current.push(...messages);
    if (this.current.length >= this.config.messageThreshold) {
      return this.closeSegment();
    }
    return null;
  }

  /**
   * 关闭当前话题：任何非空话题都产出 segment——
   * 达到 MIN_SEGMENT_MESSAGES 的走 LLM 压缩；更短的标记 archiveOnly
   * （不调用 LLM，仅归档，保证热存储有界且不产生噪声压缩档）。
   */
  private closeSegment(): TopicSegment | null {
    const messages = this.current;
    this.current = [];
    if (messages.length === 0) return null;
    const first = messages[0]!;
    const last = messages[messages.length - 1]!;
    return {
      topicId: `tp_${Date.now()}_${randomUUID().slice(0, 8)}`,
      messages,
      sourceId: this.lastSourceId,
      sourceName: this.lastSourceName,
      startedAt: first.createdAt,
      endedAt: last.createdAt,
      archiveOnly: messages.length < MIN_SEGMENT_MESSAGES,
    };
  }
}
