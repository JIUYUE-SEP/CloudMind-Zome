<template>
  <div class="message-bubble" :class="roleClass">
    <div class="message-content">
      <p v-if="text">{{ text }}</p>
      <details v-if="thinking" class="thinking-block">
        <summary>思考过程</summary>
        <pre>{{ thinking }}</pre>
      </details>
      <div v-for="tool in toolCalls" :key="tool.toolCallId" class="tool-call">
        <span class="tool-name">{{ tool.name }}</span>
        <pre>{{ JSON.stringify(tool.arguments, null, 2) }}</pre>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from "vue";

const props = defineProps<{
  role: "user" | "assistant" | "tool";
  text: string;
  thinking?: string;
  toolCalls?: { toolCallId: string; name: string; arguments: unknown }[];
}>();

const roleClass = computed(() => `role-${props.role}`);
</script>

<style scoped>
.message-bubble {
  display: flex;
  margin: 8px 0;
}
.role-user {
  justify-content: flex-end;
}
.role-user .message-content {
  background: rgba(0, 229, 201, 0.15);
}
.message-content {
  max-width: 80%;
  padding: 10px 14px;
  border-radius: 12px;
  background: rgba(255, 255, 255, 0.06);
  color: #d8e1ec;
}
.message-content p {
  white-space: pre-wrap;
  word-break: break-word;
  margin: 0;
}
/* 工具结果消息弱化显示，避免与用户/助手气泡混淆 */
.role-tool .message-content {
  background: rgba(255, 255, 255, 0.03);
  color: #8899aa;
  font-size: 12px;
}
.thinking-block {
  margin-top: 8px;
  font-size: 12px;
  color: #8899aa;
}
.tool-call {
  margin-top: 8px;
  font-size: 12px;
  background: rgba(0, 0, 0, 0.2);
  padding: 8px;
  border-radius: 6px;
}
.tool-name {
  color: #00e5c9;
}
</style>
