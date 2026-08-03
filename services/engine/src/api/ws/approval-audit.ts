import { logger } from "../../logger.js";

/**
 * 审批全链路审计日志（P4-3，体验 review O-M2）。
 *
 * 审批是安全卖点，链路必须可回溯："这个操作是谁批的、什么时候批的、
 * 批的什么"。事件与字段约定：
 * - 请求/批准/拒绝/超时/免问记入/免问命中/免问被拒/fail-closed 各一条；
 * - 字段：agentId、sessionId、approvalId、toolCallId、toolName、args（摘要）、
 *   结果。私聊 agentId 即连接归属；群聊帧另带 pending 里的 agentId。
 *
 * 参摘要分寸（参考 P2-4 的全文可审 vs 审计够用的差异）：
 * - path（write_file/edit_file/read_file）：全文——路径是审计定位的关键；
 * - command（run_command/bash）：截 500——够定位命令意图，避免把超长命令
 *   （可能内嵌密钥）整段写进日志文件；
 * - agentId+task（dispatch_subagent）：目标 agent 全文，task 截 300；
 * - 其他参数：JSON 截 300。任何情况下不记 write_file 的 content、
 *   不记 apiKey/密钥类字段（当前工具参数结构中无此类字段，新增工具时
 *   本函数是唯一需要同步评审的点）。
 */

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…(${text.length} chars)`;
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

/** 审批参数的审计摘要（不记敏感全文，见模块注释的分寸） */
export function summarizeArgs(toolName: string, args: unknown): string {
  void toolName; // 摘要按字段结构判定，工具名只留调用方日志字段
  if (args && typeof args === "object" && !Array.isArray(args)) {
    const a = args as Record<string, unknown>;
    if (typeof a.path === "string") return `path=${a.path}`;
    if (typeof a.command === "string") return `command=${truncate(a.command, 500)}`;
    if (typeof a.agentId === "string") {
      return `agentId=${a.agentId} task=${truncate(String(a.task ?? ""), 300)}`;
    }
  }
  return truncate(safeJson(args), 300);
}

interface AuditBase {
  agentId: string;
  sessionId: string;
  toolName: string;
}

export function auditRequest(
  base: AuditBase & { approvalId: string; toolCallId?: string; args: unknown },
): void {
  logger.info(
    { ...base, approvalId: base.approvalId, toolCallId: base.toolCallId, args: summarizeArgs(base.toolName, base.args) },
    "[approval] 请求审批",
  );
}

export function auditDecision(base: AuditBase & { approvalId: string; approved: boolean }): void {
  logger.info(
    { ...base, approvalId: base.approvalId, approved: base.approved },
    base.approved ? "[approval] 批准" : "[approval] 拒绝",
  );
}

export function auditTimeout(base: AuditBase & { approvalId: string }): void {
  logger.warn({ ...base, approvalId: base.approvalId }, "[approval] 审批超时按拒绝处理");
}

export function auditRemembered(base: AuditBase): void {
  // 免问扩大信任面，warn 级留痕
  logger.warn(base, "[approval] 记入本会话免问名单");
}

export function auditRememberRejected(base: AuditBase): void {
  logger.warn(base, "[approval] remember 被引擎拒绝（该工具每次必批）");
}

export function auditAutoApproved(base: AuditBase): void {
  logger.info(base, "[approval] 免问名单命中，自动放行");
}

/** trustAllTools 信任模式自动放行（用户主权最终体现，必须留痕：工具名 + 参数摘要） */
export function auditTrustedAutoApprove(
  base: AuditBase & { toolCallId?: string; args: unknown },
): void {
  // 信任模式放行影响面大，warn 级留痕（与 remember 记入同级，提升可追溯可见性）
  logger.warn(
    { ...base, toolCallId: base.toolCallId, args: summarizeArgs(base.toolName, base.args) },
    "[approval] 信任模式自动放行",
  );
}

/** 无审批通道的 fail-closed 拒绝（scheduler/subagent/blueprint 路径） */
export function auditFailClosed(base: Omit<AuditBase, "sessionId"> & { toolCallId?: string }): void {
  logger.warn(base, "[approval] 无审批通道，fail-closed 拒绝");
}
