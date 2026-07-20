<template>
  <div class="session-detail-page">
    <header class="page-header">
      <BackButton />
      <span class="page-title">{{ session?.name || "群聊" }}</span>
    </header>
    <div v-if="notFound" class="not-found">会话不存在或已被删除</div>
    <GroupChatView
      v-else
      :session="session"
      :messages="messages"
      :agents="agents.list"
      :is-connected="isConnected"
      :is-streaming="isStreaming"
      @send="onSend"
      @approval-respond="onApprovalRespond"
    />
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted, onUnmounted, computed } from "vue";
import { useRoute } from "vue-router";
import { useSessionsStore } from "@/stores/sessions";
import { useAgentsStore } from "@/stores/agents";
import { useEngineClient } from "@/composables/useEngineClient";
import { useChatRecords, setToolCallStatus, type DisplayMessage } from "@/composables/useChatRecords";
import type { Session } from "@/composables/useEngineClient";
import BackButton from "@/components/BackButton.vue";
import {
  createApprovalMessage,
  findPendingApproval,
  settleApproval,
  expireApprovalByToolCallId,
  type ApprovalResponsePayload,
} from "@/utils/approval";

const route = useRoute();
const sessions = useSessionsStore();
const agents = useAgentsStore();
const client = useEngineClient();
const { recordsToDisplay } = useChatRecords();
const sessionId = computed(() => route.params.id as string);
const session = ref<Session | undefined>(undefined);
const messages = ref<DisplayMessage[]>([]);
const isConnected = ref(false);
const isStreaming = ref(false);
const notFound = ref(false);
let connection: ReturnType<typeof client.connectSession> | null = null;
// Date.now() 同毫秒会撞 id（v-for key 冲突），挂自增序号
let msgSeq = 0;
const nextMsgId = (prefix: string) => `${prefix}_${Date.now()}_${msgSeq++}`;

onMounted(async () => {
  // store 内部已捕获加载错误并写入 error：列表没拉下来时不做存在性判断，继续尝试连接
  await sessions.load();
  await agents.load();
  session.value = sessions.sessions.find((s) => s.id === sessionId.value);
  if (!sessions.error && !session.value) {
    notFound.value = true;
    return;
  }
  try {
    await loadMessages();
  } catch {
    // 历史加载失败则从空会话开始
  }
  connect();
});

onUnmounted(() => {
  connection?.close();
});

async function loadMessages() {
  const records = await client.getSessionMessages(sessionId.value, 100);
  messages.value = recordsToDisplay(records);
}

function connect() {
  if (connection) connection.close();
  isConnected.value = false;
  isStreaming.value = false;

  connection = client.connectSession(sessionId.value, {
    onOpen: () => {
      isConnected.value = true;
    },
    onTextDelta: (delta) => {
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

function onSend(text: string) {
  if (!connection) return;
  // 先确认帧真的发出去了再乐观上屏，避免 WS 未就绪时静默吞消息、isStreaming 永不复位
  const sent = connection.send(text);
  if (!sent) {
    messages.value.push({
      id: nextMsgId("err"),
      role: "assistant",
      text: "发送失败：连接未就绪，请稍后重试",
      thinking: "",
      toolCalls: [],
      isStreaming: false,
    });
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

// 审批卡片点击后回执引擎；remember 表示本会话对同名工具不再询问
function onApprovalRespond(payload: ApprovalResponsePayload) {
  if (!connection) return;
  if (!findPendingApproval(messages.value, payload.approvalId)) return;
  const sent = connection.sendRaw({
    type: "tool.approval",
    approvalId: payload.approvalId,
    approved: payload.approved,
    remember: payload.remember,
  });
  if (sent) {
    settleApproval(messages.value, payload.approvalId, payload.approved ? "approved" : "denied");
  } else {
    // 发送失败必须让用户感知：卡片闩锁已置位，静默失败会把卡片锁成死态
    messages.value.push({
      id: nextMsgId("err"),
      role: "assistant",
      text: "审批回执发送失败：连接未就绪，请重试",
      thinking: "",
      toolCalls: [],
      isStreaming: false,
    });
  }
}
</script>

<style scoped>
.session-detail-page {
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  bottom: 56px;
  display: flex;
  flex-direction: column;
  background: var(--mc-bg);
  color: var(--mc-text);
}

.page-header {
  height: 48px;
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 0 14px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.06);
  flex-shrink: 0;
}

.page-title {
  font-size: 14px;
  font-weight: 500;
}

.not-found {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--mc-text-tertiary);
  font-size: 14px;
}
</style>
