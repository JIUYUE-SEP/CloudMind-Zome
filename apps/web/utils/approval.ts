// 危险工具调用的 inline 审批卡片：共享的状态类型与消息流操作。
// 私聊（stores/chat.ts）与群聊（hub.vue、sessions/[id].vue）各自维护消息数组，
// 公共逻辑收敛在这里，三处各自的消息处理只需调用这些函数。

// 引擎发来的审批请求帧（群聊帧外层会额外携带 agentId）——权威定义在 shared 协议层
import type { ApprovalRequestFrame, ApprovalResponseFrame } from "@mindcloud/shared";

export { isApprovalRememberable } from "@mindcloud/shared";

export type ApprovalRequestPayload = Omit<ApprovalRequestFrame, "type">;

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
export type ApprovalResponsePayload = Omit<ApprovalResponseFrame, "type">;

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
