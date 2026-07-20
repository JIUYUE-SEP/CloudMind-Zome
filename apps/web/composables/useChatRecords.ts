import type { ChatMessageRecord } from "@/composables/useEngineClient";
import type { ApprovalInfo } from "@/utils/approval";

export interface DisplayMessage {
  id: string;
  role: "user" | "assistant" | "tool";
  text: string;
  thinking: string;
  toolCalls: { toolCallId: string; name: string; arguments: unknown }[];
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
