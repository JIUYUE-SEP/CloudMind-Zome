<template>
  <div class="edit-section">
    <div v-if="compute.error" class="load-error">模型列表加载失败：{{ compute.error }}</div>
    <section class="model-group">
      <div class="group-title">主模型</div>
      <ModelSelector
        v-model:provider-id="proxyProviderId"
        v-model:model-id="proxyModelId"
        model-type="llm"
      />
    </section>

    <section class="model-group">
      <div class="group-title">Embedding 模型</div>
      <ModelSelector
        v-model:provider-id="proxyEmbedderProviderId"
        v-model:model-id="proxyEmbedderModelId"
        model-type="embedding"
      />
    </section>

    <section class="model-group">
      <div class="group-title">ImageGen 模型</div>
      <ModelSelector
        v-model:provider-id="proxyImageProviderId"
        v-model:model-id="proxyImageModelId"
        model-type="image"
      />
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
          @change="updateNumber('temperature', $event)"
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
          @change="updateNumber('topP', $event)"
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

function clampNumber(value: unknown, min: number, max: number): number | undefined {
  const num = Number(value);
  if (!Number.isFinite(num)) return undefined;
  return Math.max(min, Math.min(max, num));
}

function updateNumber(key: "temperature" | "topP", event: Event) {
  const target = event.target as HTMLInputElement;
  const raw = target.value;
  if (raw === "") {
    emit("update", { [key]: undefined } as Partial<AgentConfig>);
    return;
  }
  const clamped = clampNumber(raw, 0, key === "temperature" ? 2 : 1);
  emit("update", { [key]: clamped } as Partial<AgentConfig>);
}

const proxyProviderId = computed({
  get: () => props.agent.providerId || "",
  set: (value: string) => emit("update", { providerId: value || undefined }),
});

const proxyModelId = computed({
  get: () => props.agent.modelId || props.agent.model || "",
  set: (value: string) => {
    if (value) {
      emit("update", { modelId: value });
    } else {
      emit("update", { modelId: undefined, model: undefined });
    }
  },
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

.load-error {
  color: var(--mc-danger);
  font-size: 13px;
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
