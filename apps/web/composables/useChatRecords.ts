import type { ChatMessageRecord } from "@/composables/useEngineClient";
import type { ApprovalInfo } from "@/utils/approval";

export type ToolCallStatus = "running" | "awaiting-approval" | "done";

export interface DisplayToolCall {
  toolCallId: string;
  name: string;
  arguments: unknown;
  status?: ToolCallStatus;
}

export interface DisplayMessage {
  id: string;
  role: "user" | "assistant" | "tool";
  text: string;
  thinking: string;
  toolCalls: DisplayToolCall[];
  isStreaming: boolean;
  approval?: ApprovalInfo;
}

/**
 * 聊天记录转换的公共逻辑：私聊（chat store）与群聊（hub / sessions 页面）共用。
 * 把 engine 返回的 ChatMessageRecord 拍平为渲染用的 DisplayMessage。
 */
export function useChatRecords() {
  function recordsToDisplay(records: ChatMessageRecord[]): DisplayMessage[] {
    return records.map((r) => ({
      id: r.id,
      role: r.role,
      text: r.content.filter((c): c is { type: "text"; text: string } => c.type === "text").map((c) => c.text).join(""),
      thinking: r.content.filter((c): c is { type: "think"; think: string } => c.type === "think").map((c) => c.think).join(""),
      toolCalls: r.toolCalls || [],
      isStreaming: false,
    }));
  }

  return { recordsToDisplay };
}

/**
 * 从消息流尾部向前找包含 toolCallId 的工具调用并更新其状态。
 * 审批请求/工具结果到达时由各会话 handler 调用，驱动工具卡片的状态徽章。
 */
export function setToolCallStatus(
  messages: DisplayMessage[],
  toolCallId: string,
  status: ToolCallStatus,
): void {
  for (let i = messages.length - 1; i >= 0; i--) {
    const toolCall = messages[i]!.toolCalls.find((t) => t.toolCallId === toolCallId);
    if (toolCall) {
      toolCall.status = status;
      return;
    }
  }
}
