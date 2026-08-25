<template>
  <div class="chat-view">
    <div ref="messagesEl" class="messages">
      <div v-if="chat.loadingOlder" class="load-older">加载中…</div>
      <button v-else-if="chat.hasMore" type="button" class="load-older" @click="onLoadOlder">加载更早</button>
      <div v-else-if="chat.messages.length" class="load-older done">没有更早的消息了</div>
      <div v-if="!chat.messages.length" class="empty">暂无消息，开始对话吧</div>
      <template v-for="msg in chat.messages" :key="msg.id">
        <ApprovalCard
          v-if="msg.approval"
          :approval-id="msg.approval.approvalId"
          :tool-name="msg.approval.toolName"
          :args="msg.approval.arguments"
          :status="msg.approval.status"
          @respond="onApprovalRespond"
          @expired="chat.expireApproval"
        />
        <MessageBubble
          v-else
          :role="msg.role"
          :text="msg.text"
          :thinking="msg.thinking"
          :tool-calls="msg.toolCalls"
          :is-streaming="msg.isStreaming"
          :agent-id="agentId"
        />
      </template>
    </div>
    <div v-if="handoffText" class="handoff-banner">{{ handoffText }}</div>
    <div class="status">{{ statusText }}</div>
    <MessageInput :is-loading="chat.isStreaming && !handoffActive" @send="onSend" />
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch, nextTick, onUnmounted } from "vue";
import { useChatStore } from "@/stores/chat";
import type { ApprovalResponsePayload } from "@/utils/approval";
import ApprovalCard from "./ApprovalCard.vue";
import MessageBubble from "./MessageBubble.vue";
import MessageInput from "./MessageInput.vue";

const props = defineProps<{
  agentId: string;
}>();

const chat = useChatStore();
const messagesEl = ref<HTMLElement | null>(null);
// 防快速切换/卸载后过期 watch 继续建立连接
let connectSeq = 0;

const statusText = computed(() => {
  if (chat.reconnectAttempts > 0) return `连接已断开，重连中（第 ${chat.reconnectAttempts} 次）…`;
  if (!chat.isConnected) return "未连接";
  if (chat.isStreaming) return "生成中...";
  return "已连接";
});

watch(
  () => props.agentId,
  async (id) => {
    if (!id) return;
    const seq = ++connectSeq;
    // switchTo 先认领新 agent：旧 ChatView 迟到的 onUnmounted 不会清掉本会话
    chat.switchTo(id);
    try {
      await chat.loadMessages(id);
    } catch {
      // 历史消息加载失败（engine 不在线等）不阻塞连接；失败会体现在"未连接"状态上
    }
    // await 期间组件卸载或又切换了 agent：不得为过期视图建立连接
    if (seq !== connectSeq) return;
    chat.connect(id);
  },
  { immediate: true },
);

// 流式输出时自动滚动到底部（正文/思考/工具卡片增量都触发）；
// 「加载更早」的前置合并不滚底：凭首条消息 id 变化识别前置插入并跳过，
// 由 onLoadOlder 把视口锚定回原位置（锚记先于 await 挂出，流式增量
// 抢先在同一帧触发 watch 时首条 id 未变，锚记保留、本次照常滚底）
let firstMsgIdBeforePrepend: string | null = null;

watch(
  () => [
    chat.messages.length,
    chat.messages[chat.messages.length - 1]?.text,
    chat.messages[chat.messages.length - 1]?.thinking,
    chat.messages[chat.messages.length - 1]?.toolCalls.length,
  ],
  async () => {
    await nextTick();
    const el = messagesEl.value;
    if (!el) return;
    if (firstMsgIdBeforePrepend !== null) {
      if (chat.messages[0]?.id !== firstMsgIdBeforePrepend) {
        // 本次长度变化来自前置合并
        firstMsgIdBeforePrepend = null;
        return;
      }
    }
    el.scrollTop = el.scrollHeight;
  },
);

async function onLoadOlder() {
  const el = messagesEl.value;
  const prevHeight = el?.scrollHeight ?? 0;
  const prevTop = el?.scrollTop ?? 0;
  firstMsgIdBeforePrepend = chat.messages[0]?.id ?? "";
  const prepended = await chat.loadOlder(props.agentId);
  if (!prepended) {
    // 无新消息插入：watch 不会触发，锚记直接复位
    firstMsgIdBeforePrepend = null;
    return;
  }
  await nextTick();
  // 视口锚定原首条消息：滚动位置下移新插入的高度
  if (el) el.scrollTop = el.scrollHeight - prevHeight + prevTop;
  firstMsgIdBeforePrepend = null;
}

onUnmounted(() => {
  connectSeq++;
  // 只清理仍然当前的视图：切换后旧组件卸载是迟到回调，不得清掉新会话
  chat.disconnectFor(props.agentId);
});

// 换班移交（水位撞顶自动续跑）：scheduled/running 期间输入框保持可打断，
// 用户发送消息即 abort 续跑链（engine 侧 cancel + signal abort）
const handoffActive = computed(() => {
  const s = chat.handoffStatus?.status;
  return s === "pending" || s === "scheduled" || s === "running";
});

const handoffText = computed(() => {
  const h = chat.handoffStatus;
  if (!h) return "";
  const base = `水位撞顶换班移交 · 第 ${h.shift}/${h.maxShifts} 棒`;
  if (h.status === "pending" || h.status === "scheduled" || h.status === "running") {
    return `${base} · 自动续跑中（发送消息可打断）`;
  }
  if (h.status === "fused") return `${base} · 已达棒数上限，自动续跑停止`;
  return "";
});

function onSend(text: string) {
  chat.send(text);
}

function onApprovalRespond(payload: ApprovalResponsePayload) {
  chat.respondApproval(payload.approvalId, payload.approved, payload.remember);
}
</script>

<style scoped>
.chat-view {
  display: flex;
  flex-direction: column;
  height: 100%;
}
.messages {
  flex: 1;
  overflow-y: auto;
  padding: 16px;
}
.empty {
  color: var(--mc-text-tertiary, #5a6a7a);
  text-align: center;
  padding: 40px 0;
  font-size: 13px;
}
.load-older {
  display: block;
  margin: 0 auto 8px;
  padding: 4px 12px;
  font-size: 12px;
  color: var(--mc-text-tertiary, #5a6a7a);
  background: none;
  border: none;
  text-align: center;
}
button.load-older {
  cursor: pointer;
  color: var(--mc-accent, #00e5c9);
}
button.load-older:hover {
  text-decoration: underline;
}
.status {
  padding: 4px 12px;
  font-size: 12px;
  color: #8899aa;
}
.handoff-banner {
  margin: 0 12px 4px;
  padding: 6px 10px;
  border-radius: 8px;
  font-size: 12px;
  color: #e8b86a;
  background: rgba(232, 184, 106, 0.12);
  border: 1px solid rgba(232, 184, 106, 0.35);
}
</style>
