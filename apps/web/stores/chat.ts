import { defineStore } from "pinia";
import { ref } from "vue";
import { useEngineClient } from "@/composables/useEngineClient";
import { useChatRecords, setToolCallStatus, type DisplayMessage } from "@/composables/useChatRecords";
import {
  createApprovalMessage,
  findPendingApproval,
  settleApproval,
  expireApprovalByToolCallId,
} from "@/utils/approval";

const { recordsToDisplay } = useChatRecords();

export const useChatStore = defineStore("chat", () => {
  const client = useEngineClient();
  const sessionId = ref<string>("default");
  const messages = ref<DisplayMessage[]>([]);
  const isConnected = ref(false);
  const isStreaming = ref(false);
  let connection: ReturnType<typeof client.connect> | null = null;
  // Date.now() 同毫秒会撞 id（v-for key 冲突），挂自增序号
  let msgSeq = 0;
  const nextMsgId = (prefix: string) => `${prefix}_${Date.now()}_${msgSeq++}`;

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
        // 防御：非 string 的 delta 帧直接丢弃（engine 侧已校验，这里双重防御）
        if (typeof delta !== "string") {
          console.warn("dropping non-string text.delta frame", delta);
          return;
        }
        const last = messages.value[messages.value.length - 1];
        if (last && last.role === "assistant" && last.isStreaming) {
          last.text += delta;
        } else {
          messages.value.push({
            id: nextMsgId("stream"),
            role: "assistant",
            text: delta,
            thinking: "",
            toolCalls: [],
            isStreaming: true,
          });
        }
      },
      onThinkingDelta: (delta) => {
        if (typeof delta !== "string") {
          console.warn("dropping non-string thinking.delta frame", delta);
          return;
        }
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
        setToolCallStatus(messages.value, result.toolCallId, "done");
      },
      onApprovalRequest: (request) => {
        setToolCallStatus(messages.value, request.toolCallId, "awaiting-approval");
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
        // 错误中断流时，最后一条消息的 streaming 态也要复位，否则加载动画永不消失
        const last = messages.value[messages.value.length - 1];
        if (last && last.role === "assistant") {
          last.isStreaming = false;
        }
        isStreaming.value = false;
        messages.value.push({
          id: nextMsgId("err"),
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
    // 先确认帧真的发出去了再乐观上屏：WS 未就绪时 send 返回 false，
    // 先 push 再发会静默吞消息，且 isStreaming 永不复位导致输入框卡死
    const sent = connection?.send(text) ?? false;
    if (!sent) {
      pushErrorMessage("发送失败：连接未就绪，请稍后重试");
      return;
    }
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

  function pushErrorMessage(text: string) {
    messages.value.push({
      id: nextMsgId("err"),
      role: "assistant",
      text,
      thinking: "",
      toolCalls: [],
      isStreaming: false,
    });
  }

  // 审批卡片点击后回执引擎；remember 表示本会话对同名工具不再询问
  function respondApproval(approvalId: string, approved: boolean, remember: boolean) {
    if (!findPendingApproval(messages.value, approvalId)) return;
    const sent = connection?.sendRaw({ type: "tool.approval", approvalId, approved, remember }) ?? false;
    if (sent) {
      settleApproval(messages.value, approvalId, approved ? "approved" : "denied");
    } else {
      // 发送失败必须让用户感知：卡片闩锁已置位，静默失败会把卡片锁成不可恢复的死态
      pushErrorMessage("审批回执发送失败：连接未就绪，请重试");
    }
  }

  function disconnect() {
    connection?.close();
    connection = null;
    isConnected.value = false;
    isStreaming.value = false;
    // store 是单例：清空消息，避免切换 agent 时短暂残留上一个会话的内容
    messages.value = [];
  }

  return { sessionId, messages, isConnected, isStreaming, loadMessages, connect, send, respondApproval, disconnect };
});
