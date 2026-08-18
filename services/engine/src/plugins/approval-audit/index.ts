import { logger } from "../../logger.js";
import path from "node:path";
import { getDataDir } from "../../config/paths.js";
import { DocumentStore } from "../memory/document-store.js";

/**
 * 审批全链路审计日志（P4-3，体验 review O-M2）。
 *
 * P2 自 api/ws/approval-audit.ts 迁址本目录（插件化迁移）：解除
 * core/agent-worker.ts 与 subagent/puppet.ts 对 api/ 层的值级反向依赖
 * （迁移方案 A2 节点名的层间倒置）。取舍：本文件是纯函数汇集面
 * （M34 前全部经 logger 单例出口；M34 增加文件 sink 后仅有按路径缓存的
 * DocumentStore 模块级引用，仍无自有业务状态），按 P2 任务书批准仅归位文件、
 * 不上架 ctx 服务——无状态可挂，空 apply 是伪插件。
 *
 * 审批是安全卖点，链路必须可回溯："这个操作是谁批的、什么时候批的、
 * 批的什么"。事件与字段约定：
 * - 请求/批准/拒绝/超时/免问记入/免问命中/免问被拒/fail-closed 各一条；
 * - 字段：agentId、sessionId、approvalId、toolCallId、toolName、args（摘要）、
 *   结果。私聊 agentId 即连接归属；群聊帧另带 pending 里的 agentId。
 *
 * M34 文件 sink：logger 只到 stdout 与内存环形缓冲，跨重启不留存——每条事件
 * 同时追加写 `DATA_DIR/approval-audit.jsonl`（复用 DocumentStore.appendLine
 * 的按文件写队列与逐行 schemaVersion 戳）。fire-and-forget：写路径全部
 * catch 住只 warn，绝不炸审批链路（审批决策不等待落盘）。字段沿用下方
 * summarizeArgs 的摘要脱敏口径，不落敏感原文。
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

/**
 * M34 文件 sink 落盘记录：一条审批事件一行 JSONL。
 * 字段与 logger 结构化字段同口径（args 已是 summarizeArgs 摘要串，不落原文）；
 * ts/event 为 sink 附加维度，schemaVersion 由 DocumentStore.appendLine 逐行盖戳。
 */
interface ApprovalAuditRecord {
  ts: string;
  event: string;
  agentId: string;
  sessionId?: string;
  approvalId?: string;
  toolCallId?: string;
  toolName: string;
  args?: string;
  approved?: boolean;
}

/**
 * 按文件路径缓存的 sink 单例：DATA_DIR 变化（测试逐用例换临时目录）时自动换
 * 实例，无需 reset 钩子；跨实例并发写由 DocumentStore 的按路径模块级写队列
 * 串行兜底。lazy 解析路径——模块加载时 CLOUDMIND_DATA_DIR 可能尚未就位。
 */
let auditSink: { filePath: string; store: DocumentStore<ApprovalAuditRecord> } | undefined;

function getAuditSink(): DocumentStore<ApprovalAuditRecord> {
  const filePath = path.join(getDataDir(), "approval-audit.jsonl");
  if (!auditSink || auditSink.filePath !== filePath) {
    auditSink = { filePath, store: new DocumentStore<ApprovalAuditRecord>(filePath) };
  }
  return auditSink.store;
}

/**
 * 追加写审计事件到 jsonl（fire-and-forget）：审批决策不等待落盘；
 * 写失败只 warn（守浮空 promise 禁令——appendLine 的 promise 在此 catch 落定），
 * 绝不把 IO 故障传播进审批链路。
 */
function persistAuditEvent(event: string, fields: Omit<ApprovalAuditRecord, "ts" | "event">): void {
  getAuditSink()
    .appendLine({ ts: new Date().toISOString(), event, ...fields })
    .catch((err) => {
      logger.warn(
        { err: err instanceof Error ? err.message : String(err), event },
        "[approval] 审计事件落盘失败（审批链路不受影响）",
      );
    });
}

export function auditRequest(
  base: AuditBase & { approvalId: string; toolCallId?: string; args: unknown },
): void {
  const args = summarizeArgs(base.toolName, base.args);
  logger.info(
    { ...base, approvalId: base.approvalId, toolCallId: base.toolCallId, args },
    "[approval] 请求审批",
  );
  persistAuditEvent("request", { ...base, approvalId: base.approvalId, toolCallId: base.toolCallId, args });
}

export function auditDecision(base: AuditBase & { approvalId: string; approved: boolean }): void {
  logger.info(
    { ...base, approvalId: base.approvalId, approved: base.approved },
    base.approved ? "[approval] 批准" : "[approval] 拒绝",
  );
  persistAuditEvent("decision", { ...base, approvalId: base.approvalId, approved: base.approved });
}

export function auditTimeout(base: AuditBase & { approvalId: string }): void {
  logger.warn({ ...base, approvalId: base.approvalId }, "[approval] 审批超时按拒绝处理");
  persistAuditEvent("timeout", { ...base, approvalId: base.approvalId });
}

export function auditRemembered(base: AuditBase): void {
  // 免问扩大信任面，warn 级留痕
  logger.warn(base, "[approval] 记入本会话免问名单");
  persistAuditEvent("remembered", base);
}

export function auditRememberRejected(base: AuditBase): void {
  logger.warn(base, "[approval] remember 被引擎拒绝（该工具每次必批）");
  persistAuditEvent("remember-rejected", base);
}

export function auditAutoApproved(base: AuditBase): void {
  logger.info(base, "[approval] 免问名单命中，自动放行");
  persistAuditEvent("auto-approved", base);
}

/** trustAllTools 信任模式自动放行（用户主权最终体现，必须留痕：工具名 + 参数摘要） */
export function auditTrustedAutoApprove(
  base: AuditBase & { toolCallId?: string; args: unknown },
): void {
  const args = summarizeArgs(base.toolName, base.args);
  // 信任模式放行影响面大，warn 级留痕（与 remember 记入同级，提升可追溯可见性）
  logger.warn(
    { ...base, toolCallId: base.toolCallId, args },
    "[approval] 信任模式自动放行",
  );
  persistAuditEvent("trusted-auto-approve", { ...base, toolCallId: base.toolCallId, args });
}

/** 无审批通道的 fail-closed 拒绝（scheduler/subagent/blueprint 路径） */
export function auditFailClosed(base: Omit<AuditBase, "sessionId"> & { toolCallId?: string }): void {
  logger.warn(base, "[approval] 无审批通道，fail-closed 拒绝");
  persistAuditEvent("fail-closed", base);
}
