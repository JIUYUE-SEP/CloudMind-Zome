<template>
  <div class="edit-section">
    <label>
      心智侧写 / 人设
      <textarea
        :value="agent.persona"
        rows="16"
        placeholder="描述这个 Agent 的性格、说话方式、行为准则..."
        @input="onInput"
      />
    </label>
  </div>
</template>

<script setup lang="ts">
import type { AgentConfig } from "@cloudmind/shared";

defineProps<{
  agent: AgentConfig;
}>();

const emit = defineEmits<{
  (e: "update", patch: Partial<AgentConfig>): void;
}>();

function onInput(event: Event) {
  const target = event.target as HTMLTextAreaElement;
  emit("update", { persona: target.value });
}
</script>

<style scoped>
.edit-section {
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.edit-section label {
  display: flex;
  flex-direction: column;
  gap: 6px;
  font-size: 13px;
  color: var(--mc-text-secondary);
}

.edit-section textarea {
  padding: 10px 12px;
  border-radius: 6px;
  border: 1px solid var(--mc-border);
  background: rgba(255, 255, 255, 0.05);
  color: var(--mc-text);
  font-size: 13px;
  line-height: 1.6;
  resize: vertical;
}
</style>
