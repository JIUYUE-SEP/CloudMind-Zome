import { defineStore } from "pinia";
import { ref } from "vue";
import type { HandoffUpdateFrame } from "@mindcloud/shared";
import { useEngineClient } from "@/composables/useEngineClient";
import { useChatRecords, setToolCallStatus, type DisplayMessage } from "@/composables/useChatRecords";
import {
  createApprovalMessage,
  findPendingApproval,
  settleApproval,
  expireApprovalByToolCallId,
  expireApproval as expireApprovalById,
  expireAllPendingApprovals,
} from "@/utils/approval";

const { recordsToDisplay } = useChatRecords();

/** 历史分页大小：与群聊（useGroupChatStream）同口径，服务端满页截断语义 */
const HISTORY_PAGE_LIMIT = 100;

export const useChatStore = defineStore("chat", () => {
  const client = useEngineClient();
  const sessionId = ref<string>("default");
  const messages = ref<DisplayMessage[]>([]);
  const isConnected = ref(false);
  const isStreaming = ref(false);
  // 「加载更早」翻页状态：hasMore=false 表示没有更早历史；loadingOlder 闸住并发翻页
  const hasMore = ref(false);
  const loadingOlder = ref(false);
  /** 换班移交状态（水位撞顶自动续跑：scheduled/running 时输入框保持可打断） */
  const handoffStatus = ref<HandoffUpdateFrame | null>(null);
  // 断线重连状态（P0-3）：>0 表示正在第 N 次重试，UI 显示"重连中"而非静默
  const reconnectAttempts = ref(0);
  let connection: ReturnType<typeof client.connect> | null = null;
  // 历史加载代际：每次加载/断连自增，迟到的过期响应不得覆盖当前会话
  let loadSeq = 0;
  // 「加载更早」游标：当前已加载最早一条 engine 记录的 id。
  // 不能用 messages[0].id——本地消息（流式/审批卡片/错误条）是本地生成的 id，
  // 且 recordsToDisplay 会丢掉 tool 记录，游标必须是记录级的 id
  let oldestRecordId: string | undefined;
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
    const records = await client.getMessages(agentId, sessionId.value, { limit: HISTORY_PAGE_LIMIT });
    if (seq !== loadSeq) return;
    messages.value = recordsToDisplay(records);
    // 整页替换即复位翻页状态：不满一页即没有更早历史（服务端满页截断语义，
    // 满页只代表「可能还有」，下一页空页收口）
    oldestRecordId = records[0]?.id;
    hasMore.value = records.length >= HISTORY_PAGE_LIMIT;
    loadingOlder.value = false;
  }

  /**
   * 加载更早的一页历史并前置合并（「加载更早」入口）。
   * 返回实际前置的消息条数（0 = 没有更早/在途/失败），供视图层决定是否做滚动锚定。
   * 只在列表头部插入，不触碰尾部流式气泡——流式进行中翻页不打断生成。
   */
  async function loadOlder(agentId: string): Promise<number> {
    if (loadingOlder.value || !hasMore.value || !oldestRecordId) return 0;
    // 代际不自增（不得作废在途的 loadMessages），只快照：在途期间切换/重载则丢弃本页
    const seq = loadSeq;
    loadingOlder.value = true;
    try {
      const records = await client.getMessages(agentId, sessionId.value, {
        limit: HISTORY_PAGE_LIMIT,
        before: oldestRecordId,
      });
      if (seq !== loadSeq) return 0;
      hasMore.value = records.length >= HISTORY_PAGE_LIMIT;
      if (records.length > 0) oldestRecordId = records[0]!.id;
      // 防御性按 id 去重：游标互斥时本页与列表本不重叠，但未知游标
      // （服务端按无游标返回最新页）等边界不得让消息重复上屏
      const existing = new Set(messages.value.map((m) => m.id));
      const fresh = recordsToDisplay(records).filter((m) => !existing.has(m.id));
      messages.value = [...fresh, ...messages.value];
      return fresh.length;
    } catch {
      // 加载失败保持现状：入口仍可点击重试
      return 0;
    } finally {
      // 过期代际的 loadingOlder 已由 disconnectInternal/loadMessages 复位，不重复动
      if (seq === loadSeq) loadingOlder.value = false;
    }
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

    // 重连成功后的换班控制面对账（R5）：断连/重启期间的状态变化以 engine
    // handoff-state.json 为准回填横幅（aborted/lost 也会被拉到，横幅按状态决定显隐）
    const refreshHandoff = (agentId: string) => {
      client
        .listHandoffs(agentId, sessionId.value)
        .then((records) => {
          if (stale()) return;
          const latest = records[records.length - 1];
          if (!latest) {
            handoffStatus.value = null;
            return;
          }
          handoffStatus.value = {
            type: "handoff.update",
            agentId,
            status: latest.status,
            shift: latest.shift,
            maxShifts: latest.maxShifts,
            ...(latest.bookMessageId !== undefined ? { bookMessageId: latest.bookMessageId } : {}),
            ...(latest.abortReason !== undefined ? { reason: latest.abortReason } : {}),
          };
        })
        .catch(() => {
          // 对账失败不阻塞连接态；横幅保持断连时清空后的状态
        });
    };

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
        // M44：断线即失效——engine 在 socket close 时已把 pending 审批按拒绝收尾，
        // 重连后也没有回执路径，卡片不得永远 pending
        expireAllPendingApprovals(messages.value);
      },
      onReconnected: () => {
        if (stale()) return;
        // 重连成功：拉取最新消息列表对齐断线期间的状态
        reconnectAttempts.value = 0;
        loadMessages(agentId).catch(() => {
          // 对齐失败不阻塞连接态；历史会在下次手动刷新时补齐
        });
        refreshHandoff(agentId);
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
        // F13：零文本直接 tool.call 时 last 还是 user 气泡，徽章会静默丢失——
        // 照群聊 slotFor 语义：找不到当前 turn 的流式 assistant 槽就自动建槽。
        // 槽位口径与 onTextDelta 一致（isStreaming 的 assistant 才算本 turn 的槽，
        // 审批卡片/历史气泡等非流式 assistant 不算），后到的 text.delta 因 last
        // 已是流式 assistant 而合并进同一槽
        const last = messages.value[messages.value.length - 1];
        if (last && last.role === "assistant" && last.isStreaming) {
          last.toolCalls.push(toolCall);
        } else {
          messages.value.push({
            id: nextMsgId("stream"),
            role: "assistant",
            text: "",
            thinking: "",
            toolCalls: [toolCall],
            isStreaming: true,
          });
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
        handoffStatus.value = null;
        // M44：终态关闭同样断线即失效（engine 侧 pending 审批已随连接收尾）
        expireAllPendingApprovals(messages.value);
        // engine 主动关闭会带原因（4001 agent 不存在、4002 session 不存在、4403 冲突等）
        if (reason) {
          pushErrorMessage(`连接已关闭：${reason}`);
        }
      },
      onHandoffUpdate: (update) => {
        if (stale()) return;
        handoffStatus.value = update;
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
    // 用户消息 = abort 打断：先清换班状态（engine 收到消息即取消续跑链）
    handoffStatus.value = null;
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

  // 审批卡片 60s 倒计时到点（M44，engine 同刻按超时拒绝）：本地标失效
  function expireApproval(approvalId: string) {
    expireApprovalById(messages.value, approvalId);
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
    handoffStatus.value = null;
    // 翻页状态随会话一并复位：切换 agent 后游标/hasMore 不得带入新会话
    oldestRecordId = undefined;
    hasMore.value = false;
    loadingOlder.value = false;
    // store 是单例：清空消息，避免切换 agent 时短暂残留上一个会话的内容
    messages.value = [];
  }

  return {
    sessionId,
    messages,
    isConnected,
    isStreaming,
    handoffStatus,
    reconnectAttempts,
    hasMore,
    loadingOlder,
    loadMessages,
    loadOlder,
    connect,
    switchTo,
    disconnect,
    disconnectFor,
    send,
    respondApproval,
    expireApproval,
  };
});
