<template>
  <div class="message-input">
    <input v-model="text" type="text" placeholder="输入消息..." @keydown.enter="onEnter" />
    <!-- 流式期间同一个位置换成「停止」：发送无意义（正在生成），用户此刻
         真正想做的就是打断。按钮不 disabled——否则没法点 -->
    <button v-if="isLoading" class="stop" @click="stop">停止</button>
    <button v-else :disabled="!text.trim()" @click="submit">发送</button>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from "vue";

const props = defineProps<{
  isLoading?: boolean;
}>();

const emit = defineEmits<{
  (e: "send", text: string): void;
  (e: "stop"): void;
}>();
const text = ref("");
const isLoading = computed(() => props.isLoading === true);

function onEnter(e: KeyboardEvent) {
  // 中文输入法选词确认也是 Enter，合成态下不能把未完成的拼音发出去
  if (e.isComposing) return;
  submit();
}

function submit() {
  const trimmed = text.value.trim();
  if (!trimmed || isLoading.value) return;
  emit("send", trimmed);
  text.value = "";
}

function stop() {
  emit("stop");
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
/* 停止用危险色：与发送同位置但语义相反，靠颜色区分避免误触 */
.message-input button.stop {
  background: var(--mc-danger);
  color: #fff;
}
</style>
