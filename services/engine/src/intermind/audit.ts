import { logger } from "../logger.js";

/**
 * Intermind 私信审计（独立于 approval-audit——私信不是审批事件）。
 * 结构化 + 脱敏风格沿用既有约定：谁（from/to）、哪个会话、内容摘要（截 200）。
 * warn 级：社交动作留痕，可追溯谁给谁写了什么。
 */

export const PRIVATE_MESSAGE_SUMMARY_MAX = 200;

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…(${text.length} chars)`;
}

export function auditPrivateMessage(base: {
  fromAgentId: string;
  toAgentId: string;
  sessionId: string;
  content: string;
}): void {
  logger.warn(
    {
      fromAgentId: base.fromAgentId,
      toAgentId: base.toAgentId,
      sessionId: base.sessionId,
      content: truncate(base.content, PRIVATE_MESSAGE_SUMMARY_MAX),
    },
    "[intermind] 私信",
  );
}
