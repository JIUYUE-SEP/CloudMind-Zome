import { randomUUID } from "node:crypto";
import { INTERMIND_SESSION_PREFIX, intermindSessionId, type AgentConfig, type ChatMessageRecord } from "@mindcloud/shared";
import { logger } from "../logger.js";
import type { PerceptionInject } from "../plugins/perception/index.js";
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
 * 唤醒：写信后经 perception 单口（injectNotice，P8a 决策 3）触发接收方一轮
 * 感知回合（带 intermindRide 标记，感知回合内回信搭车不再次唤醒）。唤醒与
 * 搭车两条路径都经 buildPrivateMessageNotice
 * 注入同一格式的通知到接收方主会话（default，与前端私聊同口径）——唯一区别是
 * 搭车只落通知不触发感知回合。裸原文只进 intermind 来信线程，主会话只见通知。
 */

/** 私信通知注入的主会话：与前端私聊 WS/REST 的缺省会话同 id */
export const INTERMIND_NOTICE_SESSION_ID = "default";
// INTERMIND_SESSION_PREFIX 与 intermindSessionId 已迁至 @mindcloud/shared
// （P3 切 tools→intermind 值边；会话 id 约定跨模块共享契约）

/**
 * intermind 会话热存储条数上限（H8）：intermind 会话不参与话题压缩，
 * 不封顶 messages.jsonl 会无界增长，撞上 DocumentStore 100MB 读上限后私信整体不可用。
 * 超出时最旧的溢出部分经 archiveAndRemove 移入归档（与话题压缩同语义，可恢复），
 * 读取走 listBySessionWithArchived 跨存储归并，历史完整可读。
 */
export const INTERMIND_HOT_LIMIT = 200;

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
  /** 感知注入单口（P8a perception 插件）：唤醒路径经此入队一轮感知回合；返回是否真实入队（无 worker = false） */
  injectNotice(payload: PerceptionInject): Promise<boolean>;
}

/**
 * `【来自 {name} 的私信】{content 摘要}——可用 send_private_message 给 ta 回信（to: {senderId}）`
 * ——感知回合的唤醒通知文本。回信指引必须带 senderId：真机实证接收方被唤醒后
 * 直接开口说话、回复进了自己的主会话，发送方永远收不到（#7）。
 */
export function buildPrivateMessageNotice(
  senderName: string,
  senderId: string,
  content: string,
): string {
  const truncated = content.length > PRIVATE_MESSAGE_SUMMARY_MAX;
  const summary = truncated
    ? `${content.slice(0, PRIVATE_MESSAGE_SUMMARY_MAX)}…`
    : content;
  // 摘要截断时补读全文指引（P2-4）：长信后半只有 read_private_messages 能读到
  const readFullHint = truncated
    ? `……（信太长只显示了摘要，可用 read_private_messages 读全文，from: ${senderId}）`
    : "";
  return `【来自 ${senderName} 的私信】${summary}${readFullHint}——可用 send_private_message 给 ta 回信（to: ${senderId}）`;
}

export class IntermindService {
  constructor(private deps: IntermindServiceDeps) {}

  /**
   * 写信。默认唤醒接收方（wake:false = 搭车，只入队不唤醒）。
   * 失败语义：目标不存在/自邮明确抛错；落盘失败抛错不静默；接收方无 worker 时
   * 信照常落盘、唤醒跳过并 warn（perception 侧承担，injectNotice 返回 false → woke=false）。
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

    // 热存储封顶（H8）：双写两侧各自检查，最旧溢出部分先归档后删热存储。
    // 顺序 await 无浮空 promise；归档失败只 warn 不炸写信主流程（trimHotStorage 内部 catch）
    await this.trimHotStorage(toAgentId, recipientSessionId);
    await this.trimHotStorage(fromAgentId, intermindSessionId(toAgentId));

    auditPrivateMessage({
      fromAgentId,
      toAgentId,
      sessionId: recipientSessionId,
      content,
    });

    // 两条路径共用同一通知格式（#9）：唤醒/搭车都以【来自 {name} 的私信】+摘要+
    // 回信指引（to: senderId）注入接收方主会话，区别仅在是否触发感知回合
    const noticeText = buildPrivateMessageNotice(senderName, fromAgentId, content);

    let woke = false;
    if (opts.wake !== false) {
      // 唤醒路径经 perception 单口注入（P8a 决策 3）：无可用 worker 的 warn/跳过
      // 由 perception 侧承担并返回 false（原「私信已落盘，接收方无可用 worker，
      // 唤醒跳过」语义），woke 语义不变
      woke = await this.deps.injectNotice({
        source: "intermind",
        targetAgentId: toAgentId,
        text: noticeText,
        sourceId: INTERMIND_NOTICE_SESSION_ID,
        opts: { intermindRide: true },
      });
    } else {
      // 搭车（回信）：同一格式通知落接收方主会话，但不触发感知回合——
      // 真机 #9：此前注入的是裸信件原文，接收方分不清「对方回信」与「用户怪话」。
      // 落盘失败抛错不静默（与写信同哲学）：静默失败会重现「没收到回信」。
      // M40：role 保持 user（系统通知同范式，见 agent-worker.enqueueSystemNotice
      // 注释：L1 system 是人格/纪律区，通知是瞬时外部环境消息；且 chat_completions
      // 协议对中段 system 原样透传，对端来信摘要会被抬权成 system 指令——兼容性
      // 风险实证），改以 agentId 归因标记区分「对端来信通知」与「用户亲口消息」：
      // LLM 入参 ChatMessage 无 agentId 字段（协议零影响、模型侧仍靠【】前缀区分），
      // REST 历史/前端/审计数据面可按 agentId 识别归因（群聊归属标注同构）。
      await this.deps.getMessageRepository(toAgentId).append({
        id: randomUUID(),
        role: "user",
        agentId: fromAgentId,
        content: [{ type: "text", text: noticeText }],
        createdAt: new Date().toISOString(),
        sessionId: INTERMIND_NOTICE_SESSION_ID,
      });
    }
    return { messageId, recipientSessionId, woke };
  }

  /**
   * 热存储封顶（H8）：超出 INTERMIND_HOT_LIMIT 时把最旧的溢出部分经
   * archiveAndRemove 移入归档（先写归档再删热存储，与话题压缩同原子序，可恢复）。
   * 取全量计算真实溢出：listBySession 缺省只回最近 100 条窗口，已超帽的存量会话
   * 靠窗口永远收敛不到上限以下。失败只记 warn——信已落盘，下封信再试，
   * 不能让归档故障炸掉写信主流程。
   */
  private async trimHotStorage(agentId: string, sessionId: string): Promise<void> {
    try {
      const repo = this.deps.getMessageRepository(agentId);
      const records = await repo.listBySession(sessionId, { limit: Number.MAX_SAFE_INTEGER });
      const overflow = records.length - INTERMIND_HOT_LIMIT;
      if (overflow <= 0) return;
      await repo.archiveAndRemove(records.slice(0, overflow).map((m) => m.id));
    } catch (err) {
      logger.warn(
        `[intermind] ${agentId} 的 ${sessionId} 热存储归档失败（信已落盘，下封信重试）: ${String(err)}`,
      );
    }
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
    const sessionId = intermindSessionId(peerId);
    if (options?.before) {
      // 游标校验跨热存储+归档（H8 后旧游标可能已归档，只看热存储会误拒向前翻页）
      const found =
        (await repo.getByIds([options.before])).some((m) => m.sessionId === sessionId) ||
        (await repo.getArchivedByIds([options.before])).some((m) => m.sessionId === sessionId);
      if (!found) {
        throw new Error(`Invalid before cursor: ${options.before}`);
      }
    }
    // 跨存储读（H8）：热存储+归档按 createdAt 归并，归档后历史仍完整可读；
    // limit/before 参数透传，语义与 listBySession 一致（最近 limit 条窗口）
    return repo.listBySessionWithArchived(sessionId, options);
  }
}
