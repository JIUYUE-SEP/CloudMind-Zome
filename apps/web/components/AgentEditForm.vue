<template>
  <form class="agent-form" @submit.prevent="submit">
    <label>
      ID
      <input v-model="form.id" :disabled="isEdit" required />
    </label>
    <label>
      名称
      <input v-model="form.name" required />
    </label>
    <label>
      模型
      <input v-model="form.model" required />
    </label>
    <label>
      人设
      <textarea v-model="form.persona" rows="4" />
    </label>
    <div class="actions">
      <button type="submit">{{ isEdit ? "保存" : "创建" }}</button>
      <button type="button" @click="emit('cancel')">取消</button>
    </div>
  </form>
</template>

<script setup lang="ts">
import { reactive, computed } from "vue";
import type { AgentConfig } from "@mindcloud/shared";

const props = defineProps<{
  agent?: AgentConfig;
}>();

const emit = defineEmits<{
  (e: "save", agent: AgentConfig): void;
  (e: "cancel"): void;
}>();

const isEdit = computed(() => !!props.agent);
const form = reactive<AgentConfig>({
  id: props.agent?.id || "",
  name: props.agent?.name || "",
  persona: props.agent?.persona || "",
  model: props.agent?.model || "",
  skills: props.agent?.skills || [],
  tools: props.agent?.tools || [],
});

function submit() {
  emit("save", { ...form });
}
</script>

<style scoped>
.agent-form {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 16px;
  color: #d8e1ec;
}
.agent-form label {
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: 13px;
}
.agent-form input,
.agent-form textarea {
  padding: 8px 12px;
  border-radius: 6px;
  border: 1px solid rgba(255, 255, 255, 0.1);
  background: rgba(255, 255, 255, 0.05);
  color: #d8e1ec;
}
.actions {
  display: flex;
  gap: 8px;
}
.actions button {
  padding: 8px 16px;
  border-radius: 6px;
  border: none;
  cursor: pointer;
}
.actions button[type="submit"] {
  background: #00e5c9;
  color: #0b0f17;
}
</style>
