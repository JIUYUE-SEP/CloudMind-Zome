<template>
  <div class="chat-view">
    <div class="messages">
      <MessageBubble
        v-for="msg in chat.messages"
        :key="msg.id"
        :role="msg.role"
        :text="msg.text"
        :thinking="msg.thinking"
        :tool-calls="msg.toolCalls"
      />
    </div>
    <div class="status">{{ statusText }}</div>
    <MessageInput :is-loading="chat.isStreaming" @send="onSend" />
  </div>
</template>

<script setup lang="ts">
import { computed, watch, onUnmounted } from "vue";
import { useChatStore } from "@/stores/chat";
import MessageBubble from "./MessageBubble.vue";
import MessageInput from "./MessageInput.vue";

const props = defineProps<{
  agentId: string;
}>();

const chat = useChatStore();

const statusText = computed(() => {
  if (!chat.isConnected) return "未连接";
  if (chat.isStreaming) return "生成中...";
  return "已连接";
});

watch(
  () => props.agentId,
  async (id) => {
    if (!id) return;
    chat.disconnect();
    await chat.loadMessages(id);
    chat.connect(id);
  },
  { immediate: true },
);

onUnmounted(() => {
  chat.disconnect();
});

function onSend(text: string) {
  chat.send(text);
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
.status {
  padding: 4px 12px;
  font-size: 12px;
  color: #8899aa;
}
</style>
