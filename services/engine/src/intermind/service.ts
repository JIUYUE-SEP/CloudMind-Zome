import { randomUUID } from "node:crypto";
import type { AgentConfig, ChatMessageRecord } from "@mindcloud/shared";
import { logger } from "../logger.js";
import type { AgentWorker } from "../core/agent-worker.js";
import type { IMessageRepository } from "../memory/repositories/types.js";
import {
  auditPrivateMessage,
  auditPrivateMessagePartialWrite,
  PRIVATE_MESSAGE_SUMMARY_MAX,
} from "./audit.js";

/**
 * Intermind 人形间私信服务（一期）。
 *
 * 会话空间：每个 agent 的 intermind 空间按对端一个会话，sessionId = `intermind:<peer>`；
 * 邮箱对称双写——A 给 B 写信时，消息同时写入 B 的空间（`intermind:A`，来信线程）
 * 和 A 自己的空间（`intermind:B`，来往线程留底），两侧各自可读全量往来。
 * 唤醒：写信后经 enqueueSystemNotice 触发接收方一轮感知回合（带 intermindRide 标记，
 * 感知回合内回信搭车不再次唤醒）。信不参与主对话历史。
 */

export const INTERMIND_SESSION_PREFIX = "intermind:";
export const INTERMIND_NOTICE_SESSION_PREFIX = "notice_intermind:";

export function intermindSessionId(peerAgentId: string): string {
  return `${INTERMIND_SESSION_PREFIX}${peerAgentId}`;
}

export interface IntermindSessionSummary {
  peer: string;
  lastMessageAt: string;
  count: number;
}

export interface IntermindSendResult {
  messageId: string;
  /** 接收方来信线程的 sessionId（intermind:<fromAgentId>） */
  recipientSessionId: string;
  woke: boolean;
}

export interface IntermindServiceDeps {
  getAgentConfig(agentId: string): Promise<AgentConfig | undefined>;
  getMessageRepository(agentId: string): IMessageRepository;
  getAgentWorker(agentId: string): Promise<AgentWorker | undefined>;
}

/** `【来自 {name} 的私信】{content 摘要}`——感知回合的唤醒通知文本 */
export function buildPrivateMessageNotice(senderName: string, content: string): string {
  const summary =
    content.length > PRIVATE_MESSAGE_SUMMARY_MAX
      ? `${content.slice(0, PRIVATE_MESSAGE_SUMMARY_MAX)}…`
      : content;
  return `【来自 ${senderName} 的私信】${summary}`;
}

export class IntermindService {
  constructor(private deps: IntermindServiceDeps) {}

  /**
   * 写信。默认唤醒接收方（wake:false = 搭车，只入队不唤醒）。
   * 失败语义：目标不存在/自邮明确抛错；落盘失败抛错不静默；接收方无 worker 时
   * 信照常落盘、唤醒跳过并 warn。
   */
  async send(
    fromAgentId: string,
    toAgentId: string,
    content: string,
    opts: { wake?: boolean } = {},
  ): Promise<IntermindSendResult> {
    if (fromAgentId === toAgentId) {
      throw new Error("不能给自己写信（self-mail 不支持）");
    }
    const target = await this.deps.getAgentConfig(toAgentId);
    if (!target) {
      throw new Error(`Agent ${toAgentId} not found`);
    }
    const sender = await this.deps.getAgentConfig(fromAgentId);
    const senderName = sender?.name ?? fromAgentId;

    const now = new Date().toISOString();
    const messageId = randomUUID();
    const record = {
      id: messageId,
      role: "user" as const,
      content: [{ type: "text" as const, text: content }],
      agentId: fromAgentId,
      createdAt: now,
    };
    // 邮箱对称双写：先写接收方（信到），再写发送方线程留底；任一侧失败即抛错
    const recipientSessionId = intermindSessionId(fromAgentId);
    await this.deps.getMessageRepository(toAgentId).append({
      ...record,
      sessionId: recipientSessionId,
    });
    try {
      await this.deps.getMessageRepository(fromAgentId).append({
        ...record,
        sessionId: intermindSessionId(toAgentId),
      });
    } catch (err) {
      // 接收方已落盘、发送方留底失败：分叉状态必须有账可查（补偿 warn），再抛错
      auditPrivateMessagePartialWrite({
        fromAgentId,
        toAgentId,
        sessionId: recipientSessionId,
        content,
        persistedSide: "recipient",
      });
      throw err;
    }

    auditPrivateMessage({
      fromAgentId,
      toAgentId,
      sessionId: recipientSessionId,
      content,
    });

    let woke = false;
    if (opts.wake !== false) {
      const worker = await this.deps.getAgentWorker(toAgentId);
      if (!worker) {
        logger.warn(
          `[intermind] ${fromAgentId}→${toAgentId} 私信已落盘，接收方无可用 worker，唤醒跳过`,
        );
      } else {
        worker.enqueueSystemNotice(
          buildPrivateMessageNotice(senderName, content),
          `${INTERMIND_NOTICE_SESSION_PREFIX}${messageId}`,
          { intermindRide: true },
        );
        woke = true;
      }
    }
    return { messageId, recipientSessionId, woke };
  }

  /** 列出该 agent 的 intermind 会话（对端 + 最后消息时间 + 条数，最后时间倒序） */
  async listSessions(agentId: string): Promise<IntermindSessionSummary[]> {
    // 按消息前缀扫描推导会话：与 messages 端点同口径——
    // 对端即使是已删除 agent 或非人形发送者（如历史数据）也照常列出
    const records = await this.deps
      .getMessageRepository(agentId)
      .listBySessionPrefix(INTERMIND_SESSION_PREFIX);
    const byPeer = new Map<string, ChatMessageRecord[]>();
    for (const record of records) {
      const peer = record.sessionId.slice(INTERMIND_SESSION_PREFIX.length);
      if (!peer) continue;
      const list = byPeer.get(peer) ?? [];
      list.push(record);
      byPeer.set(peer, list);
    }
    return Array.from(byPeer.entries())
      .map(([peer, msgs]) => ({
        peer,
        lastMessageAt: msgs[msgs.length - 1]!.createdAt,
        count: msgs.length,
      }))
      .sort((a, b) => b.lastMessageAt.localeCompare(a.lastMessageAt));
  }

  /** 分页读取与对端的来往消息（limit 由调用方 clamp，before 为消息 id 游标） */
  async listMessages(
    agentId: string,
    peerId: string,
    options?: { limit?: number; before?: string },
  ): Promise<ChatMessageRecord[]> {
    const repo = this.deps.getMessageRepository(agentId);
    if (options?.before) {
      const all = await repo.listBySession(intermindSessionId(peerId));
      if (!all.some((m) => m.id === options.before)) {
        throw new Error(`Invalid before cursor: ${options.before}`);
      }
    }
    return repo.listBySession(intermindSessionId(peerId), options);
  }
}
