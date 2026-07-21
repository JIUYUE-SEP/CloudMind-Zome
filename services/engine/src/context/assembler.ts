import { randomUUID } from "node:crypto";
import type { ChatMessage } from "@mindcloud/shared";
import type { ContextLayers } from "./layers.js";

function systemMessage(text: string): ChatMessage {
  return {
    id: randomUUID(),
    role: "system",
    content: [{ type: "text", text }],
    createdAt: new Date().toISOString(),
  };
}

/**
 * 把分层内容组装为发给 LLM 的 messages。
 * 顺序（Python 伪代码）：L1 + L5 + L4 + L2 + L3；
 * L6（工具）不走 message 通道，由 pipeline 单独返回。
 *
 * 每个非空层一个 system 消息（便于审计与调试），L3 历史原样尾随。
 */
export function assembleMessages(layers: ContextLayers): ChatMessage[] {
  const messages: ChatMessage[] = [];

  if (layers.l1.trim()) {
    messages.push(systemMessage(layers.l1));
  }
  if (layers.l5.length > 0) {
    messages.push(
      systemMessage("以下是过去话题的摘要：\n\n" + layers.l5.join("\n\n---\n\n")),
    );
  }
  if (layers.l4.length > 0) {
    const lines = layers.l4.map((m) => (m.source ? `[来自: ${m.source}] ${m.content}` : m.content));
    messages.push(
      systemMessage("以下是你过去经历过的相关片段（历史记忆，非当前对话内容）：\n\n" + lines.join("\n\n---\n\n")),
    );
  }
  if (layers.l2?.trim()) {
    messages.push(systemMessage(layers.l2));
  }

  messages.push(...layers.l3);
  return messages;
}
