<template>
  <div class="message-input">
    <input v-model="text" type="text" placeholder="输入消息..." @keydown.enter="onEnter" />
    <button :disabled="!text.trim() || isLoading" @click="submit">发送</button>
  </div>
</template>

<script setup lang="ts">
import { ref } from "vue";

const props = defineProps<{
  isLoading?: boolean;
}>();

const emit = defineEmits<{ (e: "send", text: string): void }>();
const text = ref("");

function onEnter(e: KeyboardEvent) {
  // 中文输入法选词确认也是 Enter，合成态下不能把未完成的拼音发出去
  if (e.isComposing) return;
  submit();
}

function submit() {
  const trimmed = text.value.trim();
  if (!trimmed || props.isLoading) return;
  emit("send", trimmed);
  text.value = "";
}
</script>

<style scoped>
.message-input {
  display: flex;
  gap: 8px;
  padding: 12px;
  border-top: 1px solid var(--mc-border);
}
.message-input input {
  flex: 1;
  padding: 10px 14px;
  border-radius: 8px;
  border: 1px solid rgba(255, 255, 255, 0.1);
  background: rgba(255, 255, 255, 0.05);
  color: #d8e1ec;
}
.message-input button {
  padding: 10px 18px;
  border-radius: 8px;
  border: none;
  background: #00e5c9;
  color: #0b0f17;
  cursor: pointer;
}
.message-input button:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
</style>
