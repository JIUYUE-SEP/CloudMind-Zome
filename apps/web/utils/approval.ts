// 危险工具调用的 inline 审批卡片：共享的状态类型与消息流操作。
// 私聊（stores/chat.ts）与群聊（hub.vue、sessions/[id].vue）各自维护消息数组，
// 公共逻辑收敛在这里，三处各自的消息处理只需调用这些函数。

// 引擎发来的审批请求帧（群聊帧外层会额外携带 agentId）
export interface ApprovalRequestPayload {
  approvalId: string;
  toolCallId: string;
  toolName: string;
  arguments: unknown;
  agentId?: string;
}

// 卡片状态：pending 等待用户操作；approved/denied 本端已处理；
// expired 表示收到了同 toolCallId 的 tool.result（60 秒超时或已在其他窗口处理）
export type ApprovalStatus = "pending" | "approved" | "denied" | "expired";

export interface ApprovalInfo {
  approvalId: string;
  toolCallId: string;
  toolName: string;
  arguments: unknown;
  agentId?: string;
  status: ApprovalStatus;
}

// 消息流中可挂审批卡片的最小结构（chat store 与 GroupChatView 的 DisplayMessage 均满足）
export interface ApprovalHostMessage {
  id: string;
  approval?: ApprovalInfo;
}

// 客户端回执帧
export interface ApprovalResponsePayload {
  approvalId: string;
  approved: boolean;
  remember: boolean;
}

// 每次都必须人工确认的工具：即使客户端点了"本会话不再询问"，
// 引擎也不会记住（与 services/engine/src/api/ws/validation.ts 的名单保持一致）。
// run_command 是裸 shell 任意命令执行，remember 一次等于本连接放行一切命令。
// write_file/edit_file（P2-3）：写操作是注入攻击的主要落地路径
// （诱导覆写源码/配置），一律每次批。
// dispatch_subagent（P2-5）：跨 agent confused deputy 通道，一律每次批。
const NO_REMEMBER_TOOLS = new Set(["run_command", "write_file", "edit_file", "dispatch_subagent"]);

export function isApprovalRememberable(toolName: string): boolean {
  return !NO_REMEMBER_TOOLS.has(toolName);
}

// 由审批请求构造一条消息流中的"审批卡片"消息
export function createApprovalMessage(req: ApprovalRequestPayload) {
  return {
    id: `approval_${req.approvalId}`,
    role: "assistant" as const,
    text: "",
    thinking: "",
    toolCalls: [],
    isStreaming: false,
    approval: {
      approvalId: req.approvalId,
      toolCallId: req.toolCallId,
      toolName: req.toolName,
      arguments: req.arguments,
      agentId: req.agentId,
      status: "pending" as ApprovalStatus,
    },
  };
}

// 找到仍处于 pending 的审批卡片消息（用于回执前的守卫）
export function findPendingApproval<T extends ApprovalHostMessage>(
  messages: T[],
  approvalId: string
): T | undefined {
  return messages.find((m) => m.approval?.approvalId === approvalId && m.approval.status === "pending");
}

// 本端点击后把卡片标记为已处理
export function settleApproval<T extends ApprovalHostMessage>(
  messages: T[],
  approvalId: string,
  status: "approved" | "denied"
): void {
  const msg = findPendingApproval(messages, approvalId);
  if (msg?.approval) {
    msg.approval.status = status;
  }
}

// 收到 tool.result 时，若对应卡片仍 pending，标记为已超时/已处理
export function expireApprovalByToolCallId<T extends ApprovalHostMessage>(
  messages: T[],
  toolCallId: string
): void {
  for (const msg of messages) {
    if (msg.approval && msg.approval.toolCallId === toolCallId && msg.approval.status === "pending") {
      msg.approval.status = "expired";
    }
  }
}
