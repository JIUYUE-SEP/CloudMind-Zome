import { ref } from "vue";
import type { DisplayMessage } from "@/composables/useChatRecords";
import { setToolCallStatus } from "@/composables/useChatRecords";
import {
  createApprovalMessage,
  expireApprovalByToolCallId,
  type ApprovalRequestPayload,
} from "@/utils/approval";

/**
 * 群聊流式消息的公共簿记，hub 与 sessions/[id] 两个群聊入口共用。
 *
 * engine 群聊帧按 agentId 多路复用（不 @任何人时全体成员并发回复），
 * 因此每个 Agent 的流式增量进独立气泡槽：互不交错、互不提前封口。
 * 槽的生命周期以 turn 为界（turn.end 关闭），同一 turn 的多步 ReAct
 * （文本 → 工具 → 文本）进同一气泡。私聊的单流场景不要用这个，用 stores/chat.ts。
 */
export function useGroupChatStream() {
  const messages = ref<DisplayMessage[]>([]);
  const isStreaming = ref(false);
  // agentId → 该 Agent 当前 turn 的流式气泡；turn.end 只关闭对应槽
  const streamSlots = new Map<string, DisplayMessage>();
  // Date.now() 同毫秒会撞 id（v-for key 冲突），挂自增序号
  let msgSeq = 0;
  const nextMsgId = (prefix: string) => `${prefix}_${Date.now()}_${msgSeq++}`;

  function slotFor(agentId: string | undefined): DisplayMessage {
    const key = agentId || "";
    let slot = streamSlots.get(key);
    if (!slot) {
      slot = {
        id: nextMsgId("stream"),
        role: "assistant",
        text: "",
        thinking: "",
        toolCalls: [],
        isStreaming: true,
        agentId,
      };
      streamSlots.set(key, slot);
      messages.value.push(slot);
      isStreaming.value = true;
    }
    return slot;
  }

  function closeSlot(agentId: string | undefined) {
    const key = agentId || "";
    const slot = streamSlots.get(key);
    if (slot) {
      slot.isStreaming = false;
      streamSlots.delete(key);
    }
    isStreaming.value = streamSlots.size > 0;
  }

  // 关闭所有槽：连接关闭、切换会话、组件卸载时调用
  function resetStreamState() {
    for (const slot of streamSlots.values()) {
      slot.isStreaming = false;
    }
    streamSlots.clear();
    isStreaming.value = false;
  }

  function pushUserMessage(text: string) {
    messages.value.push({
      id: nextMsgId("u"),
      role: "user",
      text,
      thinking: "",
      toolCalls: [],
      isStreaming: false,
    });
    isStreaming.value = true;
  }

  function pushError(text: string) {
    messages.value.push({
      id: nextMsgId("err"),
      role: "assistant",
      text,
      thinking: "",
      toolCalls: [],
      isStreaming: false,
    });
  }

  // connectSession 的帧处理集；delta/turn.end 依赖 useEngineClient 透出的 agentId
  const handlers = {
    onTextDelta: (delta: string, agentId?: string) => {
      slotFor(agentId).text += delta;
    },
    onThinkingDelta: (delta: string, agentId?: string) => {
      slotFor(agentId).thinking += delta;
    },
    onToolCall: (toolCall: { toolCallId: string; name: string; arguments: unknown; agentId?: string }) => {
      slotFor(toolCall.agentId).toolCalls.push(toolCall);
    },
    onToolResult: (result: { toolCallId: string }) => {
      // 工具结果返回时，若审批卡片还未处理，说明已超时或在他端处理过
      expireApprovalByToolCallId(messages.value, result.toolCallId);
      setToolCallStatus(messages.value, result.toolCallId, "done");
    },
    onApprovalRequest: (request: ApprovalRequestPayload) => {
      setToolCallStatus(messages.value, request.toolCallId, "awaiting-approval");
      messages.value.push(createApprovalMessage(request));
    },
    onTurnEnd: (agentId?: string) => {
      // 一轮结束才关闭该 Agent 的气泡槽；step.end 每个 ReAct step 都发，
      // 同一 turn 的后续 step（工具执行后的文本）仍进同一气泡
      closeSlot(agentId);
    },
    onError: (error: string) => {
      resetStreamState();
      pushError(`Error: ${error}`);
    },
  };

  return { messages, isStreaming, handlers, pushUserMessage, pushError, resetStreamState };
}
