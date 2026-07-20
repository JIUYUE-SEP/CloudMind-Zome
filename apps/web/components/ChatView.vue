<template>
  <div class="chat-view">
    <div ref="messagesEl" class="messages">
      <div v-if="!chat.messages.length" class="empty">暂无消息，开始对话吧</div>
      <template v-for="msg in chat.messages" :key="msg.id">
        <ApprovalCard
          v-if="msg.approval"
          :approval-id="msg.approval.approvalId"
          :tool-name="msg.approval.toolName"
          :args="msg.approval.arguments"
          :status="msg.approval.status"
          @respond="onApprovalRespond"
        />
        <MessageBubble
          v-else
          :role="msg.role"
          :text="msg.text"
          :thinking="msg.thinking"
          :tool-calls="msg.toolCalls"
        />
      </template>
    </div>
    <div class="status">{{ statusText }}</div>
    <MessageInput :is-loading="chat.isStreaming" @send="onSend" />
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
  if (!chat.isConnected) return "未连接";
  if (chat.isStreaming) return "生成中...";
  return "已连接";
});

watch(
  () => props.agentId,
  async (id) => {
    if (!id) return;
    const seq = ++connectSeq;
    chat.disconnect();
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

// 流式输出时自动滚动到底部（正文/思考增量都触发）
watch(
  () => [
    chat.messages.length,
    chat.messages[chat.messages.length - 1]?.text,
    chat.messages[chat.messages.length - 1]?.thinking,
  ],
  async () => {
    await nextTick();
    const el = messagesEl.value;
    if (el) el.scrollTop = el.scrollHeight;
  },
);

onUnmounted(() => {
  connectSeq++;
  chat.disconnect();
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
.status {
  padding: 4px 12px;
  font-size: 12px;
  color: #8899aa;
}
</style>
