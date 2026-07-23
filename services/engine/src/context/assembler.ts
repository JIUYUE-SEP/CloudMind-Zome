import { randomUUID } from "node:crypto";
import type { ChatMessage } from "@mindcloud/shared";
import type { ContextLayers } from "./layers.js";
import { memoryToMessage, topicToMessage, mindToMessage, retrievalFailedMessage } from "./recall.js";

export interface AssembleOptions {
  /** 注入文本的时间渲染基准（测试注入固定值） */
  now?: number;
  /** 记忆检索失败：尾随 system 消息明确告知（诚实透明） */
  retrievalFailed?: boolean;
}

function systemMessage(text: string): ChatMessage {
  return {
    id: randomUUID(),
    role: "system",
    content: [{ type: "text", text }],
    createdAt: new Date().toISOString(),
  };
}

function timestampOf(msg: ChatMessage): number {
  const t = Date.parse(msg.createdAt);
  return Number.isFinite(t) ? t : 0;
}

/**
 * 把分层内容组装为发给 LLM 的 messages（最终设计）。
 *
 * 结构（缓存友好的固定前缀 + 自然对话流）：
 * - 头部 system prompt（固定，缓存命中）：L1 人格（SOUL.md + skill）→ L2 @提及提醒
 * - messages 动态部分：L4/L5 伪装成的 user 历史消息与 L3 真实历史
 *   按 createdAt 归并排序（稳定：时间相等时伪装消息在前），穿插在自然对话流中；
 *   MIND.md 经验块伪装成 assistant 历史消息，追加在热上下文之后（不参与归并）；
 *   L6（工具）不走 message 通道，由 pipeline 单独返回。
 * - 检索失败时尾随一条 system 消息明确告知（不伪装）。
 */
export function assembleMessages(layers: ContextLayers, opts: AssembleOptions = {}): ChatMessage[] {
  const now = opts.now ?? Date.now();
  const messages: ChatMessage[] = [];

  // 固定前缀：L1/L2 相邻且内容在会话内不变，前缀缓存命中率最大化
  if (layers.l1.trim()) {
    messages.push(systemMessage(layers.l1));
  }
  if (layers.l2?.trim()) {
    messages.push(systemMessage(layers.l2));
  }

  // L4/L5 → 自然化 user 历史消息（≤0.5 的记忆在 recall 层返回 null 被丢弃）
  const recalled: ChatMessage[] = [
    ...layers.l5.map((t) => topicToMessage(t, now)),
    ...layers.l4.map((m) => memoryToMessage(m, now)).filter((m): m is ChatMessage => m !== null),
  ];

  // 按真实时间归并穿插（Array.sort 稳定：recalled 先入列，时间相等时排在真实历史前）
  messages.push(
    ...[...recalled, ...layers.l3].sort((a, b) => timestampOf(a) - timestampOf(b)),
  );

  // MIND.md 经验检索：伪装成 assistant 历史消息，显式追加在热上下文之后
  // （Phase 1 不参与降级与多轮去重；命中才注入，空档静默跳过）
  if (layers.mind.length > 0) {
    messages.push(mindToMessage(layers.mind, now));
  }

  if (opts.retrievalFailed) {
    messages.push(retrievalFailedMessage());
  }
  return messages;
}
