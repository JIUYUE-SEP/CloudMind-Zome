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
  // 群聊中该消息归属的 Agent（历史来自 engine 标注，流式来自帧携带）；私聊/user 消息为空
  agentId?: string;
  approval?: ApprovalInfo;
}

/**
 * 聊天记录转换的公共逻辑：私聊（chat store）与群聊（hub / sessions 页面）共用。
 * 把 engine 返回的 ChatMessageRecord 拍平为渲染用的 DisplayMessage。
 */
export function useChatRecords() {
  function recordsToDisplay(records: ChatMessageRecord[]): DisplayMessage[] {
    // 群聊用户消息会写入每个成员的仓库，历史合并后出现 N 份同 id 副本，按 id 去重
    const seen = new Set<string>();
    const out: DisplayMessage[] = [];
    for (const r of records) {
      if (seen.has(r.id)) continue;
      seen.add(r.id);
      // tool 结果记录不进气泡：调用已作为徽章挂在 assistant 消息上，
      // 与实时流式（tool.result 只更新徽章）保持渲染一致
      if (r.role === "tool") continue;
      out.push({
        id: r.id,
        role: r.role,
        text: r.content.filter((c): c is { type: "text"; text: string } => c.type === "text").map((c) => c.text).join(""),
        thinking: r.content.filter((c): c is { type: "think"; think: string } => c.type === "think").map((c) => c.think).join(""),
        toolCalls: r.toolCalls || [],
        isStreaming: false,
        agentId: r.agentId,
      });
    }
    return out;
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
