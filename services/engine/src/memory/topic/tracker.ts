import { randomUUID } from "node:crypto";
import type { ChatMessage } from "@cloudmind/shared";
import { detectTopicBoundary } from "./detector.js";
import {
  JUDGE_ROUND_INTERVAL,
  MIN_SEGMENT_MESSAGES,
  type TopicCompressionConfig,
  type TopicSegment,
} from "./types.js";
import type { OpenTopicSnapshot } from "./state.js";

export { MIN_SEGMENT_MESSAGES };

/** 话题边界裁判的在途判决上下文（worker 取走异步执行，判完回写切分） */
export interface PendingTopicJudge {
  id: string;
  /** 判决依据的用户消息 id：判 NEW_TOPIC 时在其**之前**切一刀（最新用户消息之前） */
  baseMessageId: string;
  /** 当前话题第一条消息（话题在聊什么的锚点） */
  anchor: ChatMessage;
  /** 最近 6 轮的完整消息快照（判决依据窗口） */
  recentMessages: ChatMessage[];
  sourceId: string;
  sourceName?: string;
}

/**
 * per-agent 话题跟踪（TopicContext 规则版）。
 * 当前开放话题经 openTopic 快照暴露，由 AgentWorker 在 turn 边界落盘
 * （topic/state.ts，P1-2）：进程退出时未关闭话题不再成为重启孤儿——
 * 启动对账按落盘状态补压缩/归档（memory/reconcile.ts）。
 * sourceId 随调用传入：同一 agent 可能跨多个会话，segment 记录关闭时所在场景。
 */
export class TopicTracker {
  private current: ChatMessage[] = [];
  private lastSourceId = "";
  private lastSourceName: string | undefined;
  /** 自上次判决/切段以来累计的完整轮数（一轮 = 一条用户消息 + 一条助手回复） */
  private roundsSinceJudge = 0;
  /** 在途的 LLM 裁判（同一时刻至多一个；规则切段时作废） */
  private pendingJudge: PendingTopicJudge | null = null;
  /** 最近一轮的用户消息 id（裁判切点 = 这条用户消息之前） */
  private lastRoundUserMessageId: string | null = null;

  constructor(
    private config: Pick<
      TopicCompressionConfig,
      "enabled" | "windowMinutes" | "messageThreshold"
    >,
  ) {}

  /** 当前开放话题的快照（无未关闭话题时为 null；供 turn 边界落盘） */
  get openTopic(): OpenTopicSnapshot | null {
    if (this.current.length === 0) return null;
    return {
      messageIds: this.current.map((m) => m.id),
      startedAt: this.current[0]!.createdAt,
      sourceId: this.lastSourceId,
      sourceName: this.lastSourceName,
    };
  }

  /**
   * 从落盘快照重建开放话题（P3-6 配置变更 worker 替换交接）：
   * 正文按 id 从热存储回读（调用方职责），此处只恢复内存态
   */
  restoreOpen(messages: ChatMessage[], sourceId: string, sourceName?: string): void {
    this.current = [...messages];
    this.lastSourceId = sourceId;
    this.lastSourceName = sourceName;
    // 交接话题里已有的轮数照常累计（tool 不计数）；在途裁判不跨 worker
    this.roundsSinceJudge = this.countRounds(this.current);
    this.pendingJudge = null;
    this.lastRoundUserMessageId =
      [...this.current].reverse().find((m) => m.role === "user")?.id ?? null;
  }

  /** 新用户消息到达（turn 开始前）调用；返回被关闭的话题片段（无则 null） */
  onUserMessage(msg: ChatMessage, sourceId: string, sourceName?: string): TopicSegment | null {
    this.lastSourceId = sourceId;
    this.lastSourceName = sourceName;
    // 禁用时直接返回，不累积消息（否则长跑进程内存无界增长）
    if (!this.config.enabled) return null;
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
      // 规则切段：在途裁判作废（判决依据已不在当前话题），轮数重新累计
      this.resetJudgeState();
      this.current.push(msg);
      this.lastRoundUserMessageId = msg.id;
      return closed;
    }
    this.current.push(msg);
    this.lastRoundUserMessageId = msg.id;
    return null;
  }

  /** turn 完成（assistant/tool 消息已按 step 落库，P1-6）调用；达到数量阈值则关闭当前话题 */
  onTurnAppended(messages: ChatMessage[], sourceId: string, sourceName?: string): TopicSegment | null {
    this.lastSourceId = sourceId;
    this.lastSourceName = sourceName;
    if (!this.config.enabled) return null;
    this.current.push(...messages);
    this.roundsSinceJudge += 1;
    if (this.current.length >= this.config.messageThreshold) {
      const closed = this.closeSegment();
      this.resetJudgeState();
      return closed;
    }
    // 裁判只在规则沉默时运行：攒够 6 轮且无在途判决才挂起一次（回合结束后异步判）
    if (this.roundsSinceJudge >= JUDGE_ROUND_INTERVAL && !this.pendingJudge) {
      this.pendingJudge = this.buildPendingJudge();
    }
    return null;
  }

  /** 在途裁判上下文（worker 在回合结束后取走，异步 fire-and-forget） */
  peekPendingJudge(): PendingTopicJudge | null {
    return this.pendingJudge;
  }

  /**
   * 裁判判决回写（方案 C 六点定案 2/3）：
   * - NEW_TOPIC：在判决依据的用户消息**之前**一刀切——旧段关闭返回，
   *   该消息与其后内容（含判决期间新进来的消息）开新话题；
   * - SAME：无事发生，轮数重新累计。
   * 判决依据消息已被规则切走/已是首条时按无操作处理（不重复切段）。
   */
  resolvePendingJudge(
    judgeId: string,
    verdict: "new_topic" | "same",
  ): TopicSegment | null {
    const judge = this.pendingJudge;
    if (!judge || judge.id !== judgeId) return null; // 已作废/过期
    this.pendingJudge = null;
    if (verdict === "same") {
      this.roundsSinceJudge = 0;
      return null;
    }
    const baseIndex = this.current.findIndex((m) => m.id === judge.baseMessageId);
    if (baseIndex <= 0) return null; // 已被规则切走（-1）或无可切旧段（0）
    const closed = this.makeSegment(this.current.slice(0, baseIndex));
    this.current = this.current.slice(baseIndex);
    this.roundsSinceJudge = this.countRounds(this.current);
    return closed;
  }

  private countRounds(messages: ChatMessage[]): number {
    // 一轮 = 一条用户消息 + 一条助手回复；tool 消息不计数
    return messages.filter((m) => m.role === "user").length;
  }

  private resetJudgeState(): void {
    this.pendingJudge = null;
    this.roundsSinceJudge = 0;
  }

  private buildPendingJudge(): PendingTopicJudge | null {
    const baseIndex = this.lastRoundUserMessageId
      ? this.current.findIndex((m) => m.id === this.lastRoundUserMessageId)
      : -1;
    if (baseIndex < 0 || this.current.length === 0) return null;
    // 最近 6 轮窗口：从倒数第 6 条用户消息开始（tool 消息混入但不计数）
    let windowStart = 0;
    let userCount = 0;
    for (let i = this.current.length - 1; i >= 0; i--) {
      if (this.current[i]!.role === "user") {
        userCount += 1;
        if (userCount === JUDGE_ROUND_INTERVAL) {
          windowStart = i;
          break;
        }
      }
    }
    return {
      id: randomUUID(),
      baseMessageId: this.current[baseIndex]!.id,
      anchor: this.current[0]!,
      recentMessages: [...this.current.slice(windowStart)],
      sourceId: this.lastSourceId,
      sourceName: this.lastSourceName,
    };
  }

  private makeSegment(messages: ChatMessage[]): TopicSegment | null {
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

  /**
   * 关闭当前话题：任何非空话题都产出 segment——
   * 达到 MIN_SEGMENT_MESSAGES 的走 LLM 压缩；更短的标记 archiveOnly
   * （不调用 LLM，仅归档，保证热存储有界且不产生噪声压缩档）。
   */
  private closeSegment(): TopicSegment | null {
    const messages = this.current;
    this.current = [];
    return this.makeSegment(messages);
  }
}
