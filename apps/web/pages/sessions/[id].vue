<template>
  <div class="session-detail-page">
    <header class="page-header">
      <BackButton to="/sessions" />
      <span class="page-title">{{ session?.name || "群聊" }}</span>
    </header>
    <div v-if="sessions.error" class="not-found">加载失败：{{ sessions.error }}</div>
    <div v-if="notFound" class="not-found">会话不存在或已被删除</div>
    <GroupChatView
      v-else
      :session="session"
      :messages="messages"
      :agents="agents.list"
      :is-connected="isConnected"
      :is-streaming="isStreaming"
      :status-hint="statusHint"
      @send="onSend"
      @approval-respond="onApprovalRespond"
      @approval-expired="onApprovalExpired"
    />
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted, onUnmounted, computed } from "vue";
import { useRoute } from "vue-router";
import { useSessionsStore } from "@/stores/sessions";
import { useAgentsStore } from "@/stores/agents";
import { useEngineClient } from "@/composables/useEngineClient";
import { useChatRecords } from "@/composables/useChatRecords";
import { useGroupChatStream } from "@/composables/useGroupChatStream";
import type { Session } from "@/composables/useEngineClient";
import BackButton from "@/components/BackButton.vue";
import {
  findPendingApproval,
  settleApproval,
  expireApproval,
  expireAllPendingApprovals,
  type ApprovalResponsePayload,
} from "@/utils/approval";

const route = useRoute();
const sessions = useSessionsStore();
const agents = useAgentsStore();
const client = useEngineClient();
const { recordsToDisplay } = useChatRecords();
const sessionId = computed(() => route.params.id as string);
const session = ref<Session | undefined>(undefined);
const {
  messages,
  isStreaming,
  handlers: streamHandlers,
  pushUserMessage,
  pushError,
  resetStreamState,
} = useGroupChatStream();
const isConnected = ref(false);
const notFound = ref(false);
// 断线重连状态（P0-3）：>0 表示正在第 N 次重试
const reconnectAttempts = ref(0);
const statusHint = computed(() => {
  if (reconnectAttempts.value > 0) return `连接已断开，重连中（第 ${reconnectAttempts.value} 次）…`;
  return "";
});
let connection: ReturnType<typeof client.connectSession> | null = null;

// 组件卸载在途：后续 await 返回后不得落地数据或建立连接
let alive = true;

onMounted(async () => {
  // store 内部已捕获加载错误并写入 error：列表没拉下来时不做存在性判断，继续尝试连接
  await sessions.load();
  await agents.load();
  if (!alive) return;
  session.value = sessions.sessions.find((s) => s.id === sessionId.value);
  if (!sessions.error && !session.value) {
    notFound.value = true;
    return;
  }
  try {
    const records = await client.getSessionMessages(sessionId.value, { limit: 100 });
    if (!alive) return;
    messages.value = recordsToDisplay(records);
  } catch {
    // 历史加载失败则从空会话开始
  }
  if (!alive) return;
  connect();
});

onUnmounted(() => {
  alive = false;
  connection?.close();
});

function connect() {
  if (connection) connection.close();
  isConnected.value = false;
  reconnectAttempts.value = 0;
  resetStreamState();

  connection = client.connectSession(sessionId.value, {
    onOpen: () => {
      isConnected.value = true;
      reconnectAttempts.value = 0;
    },
    ...streamHandlers,
    onReconnecting: (attempt) => {
      isConnected.value = false;
      reconnectAttempts.value = attempt;
      resetStreamState();
      // M44：断线即失效——engine 在 socket close 时已把 pending 审批按拒绝收尾，
      // 重连后也没有回执路径，卡片不得永远 pending
      expireAllPendingApprovals(messages.value);
    },
    onReconnected: () => {
      // 重连成功：拉取最新消息列表对齐断线期间的状态
      reconnectAttempts.value = 0;
      client
        .getSessionMessages(sessionId.value, { limit: 100 })
        .then((records) => {
          if (alive) messages.value = recordsToDisplay(records);
        })
        .catch(() => {
          // 对齐失败不阻塞连接态
        });
    },
    onClose: () => {
      isConnected.value = false;
      reconnectAttempts.value = 0;
      resetStreamState();
      // M44：终态关闭同样断线即失效（engine 侧 pending 审批已随连接收尾）
      expireAllPendingApprovals(messages.value);
    },
  });
}

function onSend(text: string) {
  if (!connection) return;
  // 先确认帧真的发出去了再乐观上屏，避免 WS 未就绪时静默吞消息、isStreaming 永不复位
  const sent = connection.send(text);
  if (!sent) {
    pushError("发送失败：连接未就绪，请稍后重试");
    return;
  }
  pushUserMessage(text);
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
    pushError("审批回执发送失败：连接未就绪，请重试");
  }
}

// 审批卡片 60s 倒计时到点（M44，engine 同刻按超时拒绝）：本地标失效
function onApprovalExpired(approvalId: string) {
  expireApproval(messages.value, approvalId);
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
  border-bottom: 1px solid var(--mc-panel);
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
