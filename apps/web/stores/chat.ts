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
  // 历史加载代际：每次加载/断连自增，迟到的过期响应不得覆盖当前会话
  let loadSeq = 0;
  // Date.now() 同毫秒会撞 id（v-for key 冲突），挂自增序号
  let msgSeq = 0;
  const nextMsgId = (prefix: string) => `${prefix}_${Date.now()}_${msgSeq++}`;

  async function loadMessages(agentId: string) {
    const seq = ++loadSeq;
    const records = await client.getMessages(agentId, sessionId.value, 100);
    if (seq !== loadSeq) return;
    messages.value = recordsToDisplay(records);
  }

  function connect(agentId: string) {
    if (connection) connection.close();
    isConnected.value = false;
    isStreaming.value = false;

    // 流式中断（turn 结束/出错/断连）时复位最后一条气泡的 streaming 态，
    // 否则光标与打字机永不停止
    const sealLastAssistant = () => {
      const last = messages.value[messages.value.length - 1];
      if (last && last.role === "assistant") {
        last.isStreaming = false;
      }
    };

    // 旧 socket 在关闭握手完成前仍可能触发 onmessage/onclose：
    // 代际比对，过期连接的帧一律丢弃，防止写脏新会话状态
    const stale = () => conn !== connection;

    const conn = client.connect(agentId, sessionId.value, {
      onOpen: () => {
        if (stale()) return;
        isConnected.value = true;
      },
      onTextDelta: (delta) => {
        if (stale()) return;
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
        if (stale()) return;
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
        if (stale()) return;
        const last = messages.value[messages.value.length - 1];
        if (last && last.role === "assistant") {
          last.toolCalls.push(toolCall);
        }
      },
      onToolResult: (result) => {
        if (stale()) return;
        // 工具结果返回时，若审批卡片还未处理，说明已超时或在他端处理过
        expireApprovalByToolCallId(messages.value, result.toolCallId);
        setToolCallStatus(messages.value, result.toolCallId, "done");
      },
      onApprovalRequest: (request) => {
        if (stale()) return;
        setToolCallStatus(messages.value, request.toolCallId, "awaiting-approval");
        messages.value.push(createApprovalMessage(request));
      },
      onTurnEnd: () => {
        if (stale()) return;
        // 一轮生成结束才复位流式态；step.end 每个 ReAct step 都发，
        // 若在 step 边界复位，工具执行期间输入框会提前解锁
        sealLastAssistant();
        isStreaming.value = false;
      },
      onError: (error) => {
        if (stale()) return;
        sealLastAssistant();
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
        if (stale()) return;
        sealLastAssistant();
        isConnected.value = false;
        isStreaming.value = false;
      },
    });
    connection = conn;
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
    // 作废在途的历史加载：否则切走后迟到的响应会把消息列表写回已离开的会话
    loadSeq++;
    connection?.close();
    connection = null;
    isConnected.value = false;
    isStreaming.value = false;
    // store 是单例：清空消息，避免切换 agent 时短暂残留上一个会话的内容
    messages.value = [];
  }

  return { sessionId, messages, isConnected, isStreaming, loadMessages, connect, send, respondApproval, disconnect };
});
