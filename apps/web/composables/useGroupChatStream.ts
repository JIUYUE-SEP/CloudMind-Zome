import { ref } from "vue";
import type { DisplayMessage } from "@/composables/useChatRecords";
import { useChatRecords, setToolCallStatus } from "@/composables/useChatRecords";
import type { ChatMessageRecord } from "@/composables/useEngineClient";
import {
  createApprovalMessage,
  expireApprovalByToolCallId,
  type ApprovalRequestPayload,
} from "@/utils/approval";

/** 历史分页大小：与私聊（stores/chat.ts）同口径，服务端满页截断语义 */
export const HISTORY_PAGE_LIMIT = 100;

/**
 * 群聊流式消息的公共簿记，hub 与 sessions/[id] 两个群聊入口共用。
 *
 * engine 群聊帧按 agentId 多路复用（不 @任何人时全体成员并发回复），
 * 因此每个 Agent 的流式增量进独立气泡槽：互不交错、互不提前封口。
 * 槽的生命周期以 turn 为界（turn.end 关闭），同一 turn 的多步 ReAct
 * （文本 → 工具 → 文本）进同一气泡。私聊的单流场景不要用这个，用 stores/chat.ts。
 *
 * 历史「加载更早」的游标/前置合并也收敛在这里：两个入口各自持有
 * getSessionMessages 闭包（fetchPage 注入），composable 不感知 engine 连接。
 */
export function useGroupChatStream() {
  const { recordsToDisplay } = useChatRecords();
  const messages = ref<DisplayMessage[]>([]);
  const isStreaming = ref(false);
  // 「加载更早」翻页状态（与私聊 chat store 同语义）
  const hasMoreHistory = ref(false);
  const loadingOlder = ref(false);
  // 翻页游标：当前已加载最早一条 engine 记录的 id（本地消息 id 不作游标）
  let oldestRecordId: string | undefined;
  // 历史代际：整页替换/清空时自增，在途翻页的迟到结果不得落地
  let historySeq = 0;
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

  /**
   * 整页历史落地（首载 / 重连对齐）：替换消息列表并复位翻页游标。
   * 服务端满页截断语义：不满 limit 即没有更早历史，满页只代表「可能还有」。
   * 返回的 DisplayMessage 保留 record 的 agentId 归属标注（recordsToDisplay）。
   */
  function applyHistoryPage(records: ChatMessageRecord[], limit = HISTORY_PAGE_LIMIT) {
    historySeq++;
    messages.value = recordsToDisplay(records);
    oldestRecordId = records[0]?.id;
    hasMoreHistory.value = records.length >= limit;
    loadingOlder.value = false;
  }

  // 切换会话时清空历史：作废在途翻页（代际自增），游标与入口态复位
  function clearHistory() {
    historySeq++;
    messages.value = [];
    oldestRecordId = undefined;
    hasMoreHistory.value = false;
    loadingOlder.value = false;
  }

  /**
   * 加载更早的一页并前置合并。fetchPage 由页面注入（持有 sessionId 的
   * getSessionMessages 闭包）。返回实际前置条数，供视图层做滚动锚定。
   * 只在头部插入，不触碰尾部流式槽——流式进行中翻页不打断生成。
   */
  async function loadOlderHistory(
    fetchPage: (before: string) => Promise<ChatMessageRecord[]>,
  ): Promise<number> {
    if (loadingOlder.value || !hasMoreHistory.value || !oldestRecordId) return 0;
    const seq = historySeq;
    loadingOlder.value = true;
    try {
      const records = await fetchPage(oldestRecordId);
      // 在途期间切换了会话/重连对齐：过期页不得前置进当前列表
      if (seq !== historySeq) return 0;
      hasMoreHistory.value = records.length >= HISTORY_PAGE_LIMIT;
      if (records.length > 0) oldestRecordId = records[0]!.id;
      // 防御性按 id 去重（与私聊 loadOlder 同口径；游标互斥时本不重叠）
      const existing = new Set(messages.value.map((m) => m.id));
      const fresh = recordsToDisplay(records).filter((m) => !existing.has(m.id));
      messages.value = [...fresh, ...messages.value];
      return fresh.length;
    } catch {
      // 加载失败保持现状：入口仍可点击重试
      return 0;
    } finally {
      if (seq === historySeq) loadingOlder.value = false;
    }
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
      // 与私聊（stores/chat.ts）同口径的双重防御：非 string 的 delta 帧丢弃，不建槽
      if (typeof delta !== "string") {
        console.warn("dropping non-string text.delta frame", delta);
        return;
      }
      slotFor(agentId).text += delta;
    },
    onThinkingDelta: (delta: string, agentId?: string) => {
      if (typeof delta !== "string") {
        console.warn("dropping non-string thinking.delta frame", delta);
        return;
      }
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

  return {
    messages,
    isStreaming,
    hasMoreHistory,
    loadingOlder,
    handlers,
    pushUserMessage,
    pushError,
    resetStreamState,
    applyHistoryPage,
    clearHistory,
    loadOlderHistory,
  };
}
