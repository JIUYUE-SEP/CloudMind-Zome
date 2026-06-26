<template>
  <div class="edit-section">
    <section class="model-group">
      <div class="group-title">主模型</div>
      <label>
        Provider
        <select :value="agent.providerId" @change="update('providerId', $event)">
          <option value="">请选择 Provider</option>
          <option v-for="p in compute.providers" :key="p.id" :value="p.id">{{ p.displayName }}</option>
        </select>
      </label>
      <label>
        模型
        <ModelSelector
          v-model:provider-id="proxyProviderId"
          v-model:model-id="proxyModelId"
          model-type="llm"
        />
      </label>
    </section>

    <section class="model-group">
      <div class="group-title">Embedding 模型</div>
      <label>
        Provider
        <select :value="agent.embedderProviderId" @change="update('embedderProviderId', $event)">
          <option value="">请选择 Provider</option>
          <option v-for="p in compute.providers" :key="p.id" :value="p.id">{{ p.displayName }}</option>
        </select>
      </label>
      <label>
        模型
        <ModelSelector
          v-model:provider-id="proxyEmbedderProviderId"
          v-model:model-id="proxyEmbedderModelId"
          model-type="embedding"
        />
      </label>
    </section>

    <section class="model-group">
      <div class="group-title">ImageGen 模型</div>
      <label>
        Provider
        <select :value="agent.imageProviderId" @change="update('imageProviderId', $event)">
          <option value="">请选择 Provider</option>
          <option v-for="p in compute.providers" :key="p.id" :value="p.id">{{ p.displayName }}</option>
        </select>
      </label>
      <label>
        模型
        <ModelSelector
          v-model:provider-id="proxyImageProviderId"
          v-model:model-id="proxyImageModelId"
          model-type="image"
        />
      </label>
    </section>

    <section class="model-group params">
      <label>
        Temperature
        <input
          :value="agent.temperature ?? ''"
          type="number"
          step="0.1"
          min="0"
          max="2"
          placeholder="默认"
          @input="updateNumber('temperature', $event)"
        />
      </label>
      <label>
        Top P
        <input
          :value="agent.topP ?? ''"
          type="number"
          step="0.1"
          min="0"
          max="1"
          placeholder="默认"
          @input="updateNumber('topP', $event)"
        />
      </label>
    </section>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted } from "vue";
import type { AgentConfig } from "@mindcloud/shared";
import { useComputeStore } from "@/stores/compute";
import ModelSelector from "../ModelSelector.vue";

const props = defineProps<{
  agent: AgentConfig;
}>();

const emit = defineEmits<{
  (e: "update", patch: Partial<AgentConfig>): void;
}>();

const compute = useComputeStore();

onMounted(() => {
  compute.load();
});

function update(key: keyof AgentConfig, event: Event) {
  const target = event.target as HTMLSelectElement;
  const value = target.value || undefined;
  emit("update", { [key]: value } as Partial<AgentConfig>);
}

function updateNumber(key: "temperature" | "topP", event: Event) {
  const target = event.target as HTMLInputElement;
  const value = target.value === "" ? undefined : Number(target.value);
  emit("update", { [key]: value } as Partial<AgentConfig>);
}

const proxyProviderId = computed({
  get: () => props.agent.providerId || "",
  set: (value: string) => emit("update", { providerId: value || undefined }),
});

const proxyModelId = computed({
  get: () => props.agent.modelId || props.agent.model || "",
  set: (value: string) => emit("update", { modelId: value || undefined, model: value || undefined }),
});

const proxyEmbedderProviderId = computed({
  get: () => props.agent.embedderProviderId || "",
  set: (value: string) => emit("update", { embedderProviderId: value || undefined }),
});

const proxyEmbedderModelId = computed({
  get: () => props.agent.embedderModelId || "",
  set: (value: string) => emit("update", { embedderModelId: value || undefined }),
});

const proxyImageProviderId = computed({
  get: () => props.agent.imageProviderId || "",
  set: (value: string) => emit("update", { imageProviderId: value || undefined }),
});

const proxyImageModelId = computed({
  get: () => props.agent.imageModelId || "",
  set: (value: string) => emit("update", { imageModelId: value || undefined }),
});
</script>

<style scoped>
.edit-section {
  display: flex;
  flex-direction: column;
  gap: 20px;
}

.model-group {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 14px;
  background: rgba(255, 255, 255, 0.03);
  border: 1px solid var(--mc-border);
  border-radius: 8px;
}

.group-title {
  font-size: 13px;
  font-weight: 500;
  color: var(--mc-text);
  margin-bottom: 2px;
}

.edit-section label {
  display: flex;
  flex-direction: column;
  gap: 6px;
  font-size: 13px;
  color: var(--mc-text-secondary);
}

.edit-section select,
.edit-section input {
  padding: 8px 12px;
  border-radius: 6px;
  border: 1px solid var(--mc-border);
  background: rgba(255, 255, 255, 0.05);
  color: var(--mc-text);
  font-size: 13px;
}

.params {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 12px;
}

.params label {
  margin: 0;
}
</style>
