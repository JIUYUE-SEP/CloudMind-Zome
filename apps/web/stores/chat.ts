import { defineStore } from "pinia";
import { ref } from "vue";
import { useEngineClient } from "@/composables/useEngineClient";
import type { ChatMessageRecord } from "@/composables/useEngineClient";
import {
  createApprovalMessage,
  findPendingApproval,
  settleApproval,
  expireApprovalByToolCallId,
  type ApprovalInfo,
} from "@/utils/approval";

export interface DisplayMessage {
  id: string;
  role: "user" | "assistant" | "tool";
  text: string;
  thinking: string;
  toolCalls: { toolCallId: string; name: string; arguments: unknown }[];
  isStreaming: boolean;
  approval?: ApprovalInfo;
}

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

export const useChatStore = defineStore("chat", () => {
  const client = useEngineClient();
  const sessionId = ref<string>("default");
  const messages = ref<DisplayMessage[]>([]);
  const isConnected = ref(false);
  const isStreaming = ref(false);
  let connection: ReturnType<typeof client.connect> | null = null;

  async function loadMessages(agentId: string) {
    const records = await client.getMessages(agentId, sessionId.value, 100);
    messages.value = recordsToDisplay(records);
  }

  function connect(agentId: string) {
    if (connection) connection.close();
    isConnected.value = false;
    isStreaming.value = false;

    connection = client.connect(agentId, sessionId.value, {
      onOpen: () => {
        isConnected.value = true;
      },
      onTextDelta: (delta) => {
        const last = messages.value[messages.value.length - 1];
        if (last && last.role === "assistant" && last.isStreaming) {
          last.text += delta;
        } else {
          messages.value.push({
            id: `stream_${Date.now()}`,
            role: "assistant",
            text: delta,
            thinking: "",
            toolCalls: [],
            isStreaming: true,
          });
        }
      },
      onThinkingDelta: (delta) => {
        const last = messages.value[messages.value.length - 1];
        if (last && last.role === "assistant" && last.isStreaming) {
          last.thinking += delta;
        }
      },
      onToolCall: (toolCall) => {
        const last = messages.value[messages.value.length - 1];
        if (last && last.role === "assistant") {
          last.toolCalls.push(toolCall);
        }
      },
      onToolResult: (result) => {
        // 工具结果返回时，若审批卡片还未处理，说明已超时或在他端处理过
        expireApprovalByToolCallId(messages.value, result.toolCallId);
      },
      onApprovalRequest: (request) => {
        messages.value.push(createApprovalMessage(request));
      },
      onStepEnd: () => {
        const last = messages.value[messages.value.length - 1];
        if (last && last.role === "assistant") {
          last.isStreaming = false;
        }
        isStreaming.value = false;
      },
      onError: (error) => {
        isStreaming.value = false;
        messages.value.push({
          id: `err_${Date.now()}`,
          role: "assistant",
          text: `Error: ${error}`,
          thinking: "",
          toolCalls: [],
          isStreaming: false,
        });
      },
      onClose: () => {
        isConnected.value = false;
        isStreaming.value = false;
      },
    });
  }

  function send(text: string) {
    if (!connection) return;
    messages.value.push({
      id: `u_${Date.now()}`,
      role: "user",
      text,
      thinking: "",
      toolCalls: [],
      isStreaming: false,
    });
    isStreaming.value = true;
    connection.send(text);
  }

  // 审批卡片点击后回执引擎；remember 表示本会话对同名工具不再询问
  function respondApproval(approvalId: string, approved: boolean, remember: boolean) {
    if (!connection) return;
    if (!findPendingApproval(messages.value, approvalId)) return;
    const sent = connection.sendRaw({ type: "tool.approval", approvalId, approved, remember });
    if (sent) {
      settleApproval(messages.value, approvalId, approved ? "approved" : "denied");
    }
  }

  function disconnect() {
    connection?.close();
    connection = null;
    isConnected.value = false;
    isStreaming.value = false;
  }

  return { sessionId, messages, isConnected, isStreaming, loadMessages, connect, send, respondApproval, disconnect };
});
