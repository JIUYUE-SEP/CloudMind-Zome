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
      Provider
      <select v-model="form.providerId">
        <option value="">Mock Provider</option>
        <option v-for="p in compute.providers" :key="p.id" :value="p.id">{{ p.displayName }}</option>
      </select>
    </label>
    <label>
      主模型
      <ModelSelector
        v-model:provider-id="form.providerId"
        v-model:model-id="form.modelId"
        model-type="llm"
      />
    </label>
    <label>
      Embedding 模型
      <ModelSelector
        v-model:provider-id="form.embeddingProviderId"
        v-model:model-id="form.embeddingModelId"
        model-type="embedding"
      />
    </label>
    <label>
      ImageGen 模型
      <ModelSelector
        v-model:provider-id="form.imageProviderId"
        v-model:model-id="form.imageModelId"
        model-type="image"
      />
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
import { reactive, computed, onMounted } from "vue";
import type { AgentConfig } from "@mindcloud/shared";
import { useComputeStore } from "@/stores/compute";
import ModelSelector from "./ModelSelector.vue";

const props = defineProps<{
  agent?: AgentConfig;
}>();

const emit = defineEmits<{
  (e: "save", agent: AgentConfig): void;
  (e: "cancel"): void;
}>();

const compute = useComputeStore();

onMounted(() => {
  compute.load();
});

const isEdit = computed(() => !!props.agent);
const form = reactive({
  id: props.agent?.id || "",
  name: props.agent?.name || "",
  persona: props.agent?.persona || "",
  providerId: props.agent?.providerId || "",
  modelId: props.agent?.modelId || props.agent?.model || "",
  embeddingProviderId: "",
  embeddingModelId: "",
  imageProviderId: "",
  imageModelId: "",
  skills: props.agent?.skills || [],
  tools: props.agent?.tools || [],
});

function submit() {
  const agent: AgentConfig = {
    id: form.id,
    name: form.name,
    persona: form.persona,
    providerId: form.providerId || undefined,
    modelId: form.modelId || undefined,
    model: form.modelId || undefined,
    skills: form.skills,
    tools: form.tools,
  };
  emit("save", agent);
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
.agent-form textarea,
.agent-form select {
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
