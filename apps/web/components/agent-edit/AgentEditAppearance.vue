<template>
  <div class="edit-section">
    <div class="appearance-preview">
      <div
        class="appearance-avatar"
        :style="{ backgroundColor: props.agent.representColor || DEFAULT_ACCENT_COLOR }"
      >
        {{ avatarInitial }}
      </div>
      <div class="appearance-meta">
        <div class="appearance-name">{{ props.agent.name || "未命名心智" }}</div>
        <div class="appearance-color">{{ props.agent.representColor || DEFAULT_ACCENT_COLOR }}</div>
      </div>
    </div>

    <label class="color-field">
      代表色
      <input
        type="color"
        :value="props.agent.representColor || DEFAULT_ACCENT_COLOR"
        @input="update('representColor', $event)"
      />
      <span class="color-value">{{ props.agent.representColor || DEFAULT_ACCENT_COLOR }}</span>
    </label>

  </div>
</template>

<script setup lang="ts">
import { computed } from "vue";
import type { AgentConfig } from "@cloudmind/shared";
import { DEFAULT_ACCENT_COLOR } from "@/utils/theme";

const props = defineProps<{
  agent: AgentConfig;
}>();

const emit = defineEmits<{
  (e: "update", patch: Partial<AgentConfig>): void;
}>();

const avatarInitial = computed(() => props.agent.name?.charAt(0) || "?");

function update<K extends keyof AgentConfig>(key: K, event: Event) {
  const target = event.target as HTMLInputElement;
  emit("update", { [key]: target.value } as Partial<AgentConfig>);
}
</script>

<style scoped>
.edit-section {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.appearance-preview {
  display: flex;
  align-items: center;
  gap: 14px;
  padding: 16px;
  background: rgba(255, 255, 255, 0.03);
  border: 1px solid var(--mc-border);
  border-radius: 12px;
}

.appearance-avatar {
  width: 64px;
  height: 64px;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 28px;
  font-weight: 600;
  color: #0b0f17;
  flex-shrink: 0;
}

.appearance-meta {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
}

.appearance-name {
  font-size: 15px;
  font-weight: 500;
  color: var(--mc-text);
}

.appearance-color {
  font-size: 12px;
  color: var(--mc-text-secondary);
  font-family: monospace;
}

.edit-section label {
  display: flex;
  flex-direction: column;
  gap: 6px;
  font-size: 13px;
  color: var(--mc-text-secondary);
}

.color-field {
  flex-direction: row !important;
  align-items: center;
  gap: 12px !important;
}

.color-field input[type="color"] {
  width: 40px;
  height: 40px;
  padding: 2px;
  border-radius: 6px;
  cursor: pointer;
}

.color-value {
  font-family: monospace;
  color: var(--mc-text);
}
</style>
