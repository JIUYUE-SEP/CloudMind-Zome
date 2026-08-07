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
  // 断线重连状态（P0-3）：>0 表示正在第 N 次重试，UI 显示"重连中"而非静默
  const reconnectAttempts = ref(0);
  const engineTerminated = client.sidecarTerminated;
  let connection: ReturnType<typeof client.connect> | null = null;
  // 历史加载代际：每次加载/断连自增，迟到的过期响应不得覆盖当前会话
  let loadSeq = 0;
  // 当前视图所属 agent：切换/卸载时区分「当前会话」与「已被替换的旧视图」。
  // 真机 #6 根因：Vue 替换 keyed ChatView 时先挂新组件、后跑旧组件 onUnmounted，
  // 旧组件卸载的 disconnect() 会作废新 agent 正在加载的历史并清空 messages——
  // 与 A 聊完切到 B 再切回 A，A 的消息列表变空。switchTo 先认领新 agent，
  // 旧组件迟到的卸载清理因 agentId 不匹配直接跳过。
  let currentAgentId = "";
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
    currentAgentId = agentId;
    if (connection) connection.close();
    isConnected.value = false;
    isStreaming.value = false;
    reconnectAttempts.value = 0;

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
        reconnectAttempts.value = 0;
      },
      onReconnecting: (attempt) => {
        if (stale()) return;
        // 断线瞬间复位流式态，并进入"重连中"的可感知状态
        sealLastAssistant();
        isConnected.value = false;
        isStreaming.value = false;
        reconnectAttempts.value = attempt;
      },
      onReconnected: () => {
        if (stale()) return;
        // 重连成功：拉取最新消息列表对齐断线期间的状态
        reconnectAttempts.value = 0;
        loadMessages(agentId).catch(() => {
          // 对齐失败不阻塞连接态；历史会在下次手动刷新时补齐
        });
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
        } else {
          // engine 通常先流思考再流正文：thinking.delta 先于 text.delta 到达时
          // 没有现成气泡可挂，照 text.delta 的管道先建一个流式助手气泡承载思考，
          // 正文到达后追加进同一气泡（真机 #11）
          messages.value.push({
            id: nextMsgId("stream"),
            role: "assistant",
            text: "",
            thinking: delta,
            toolCalls: [],
            isStreaming: true,
          });
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
      onClose: (_code, reason) => {
        if (stale()) return;
        sealLastAssistant();
        isConnected.value = false;
        isStreaming.value = false;
        reconnectAttempts.value = 0;
        // engine 主动关闭会带原因（4001 agent 不存在、4002 session 不存在、4403 冲突等）
        if (reason) {
          pushErrorMessage(`连接已关闭：${reason}`);
        }
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

  /** 切换到目标 agent（ChatView 挂载/切换）：先认领新 agent 再清旧状态 */
  function switchTo(agentId: string) {
    currentAgentId = agentId;
    disconnectInternal();
  }

  /**
   * 离开当前会话/组件卸载。传入 agentId 时只清理「仍然当前」的视图：
   * 被替换的旧 ChatView 卸载是迟到回调，不得清掉新会话的状态。
   */
  function disconnectFor(agentId: string) {
    if (agentId !== currentAgentId) return;
    disconnectInternal();
  }

  function disconnect() {
    disconnectInternal();
  }

  function disconnectInternal() {
    // 作废在途的历史加载：否则切走后迟到的响应会把消息列表写回已离开的会话
    loadSeq++;
    connection?.close();
    connection = null;
    isConnected.value = false;
    isStreaming.value = false;
    reconnectAttempts.value = 0;
    // store 是单例：清空消息，避免切换 agent 时短暂残留上一个会话的内容
    messages.value = [];
  }

  return {
    sessionId,
    messages,
    isConnected,
    isStreaming,
    reconnectAttempts,
    engineTerminated,
    loadMessages,
    connect,
    switchTo,
    disconnect,
    disconnectFor,
    send,
    respondApproval,
  };
});
