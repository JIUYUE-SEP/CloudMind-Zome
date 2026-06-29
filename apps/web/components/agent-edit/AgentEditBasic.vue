<template>
  <div class="edit-section">
    <label>
      ID
      <input :value="agent.id" :disabled="!isNew" @input="update('id', $event)" />
    </label>
    <label>
      名称
      <input :value="agent.name" @input="update('name', $event)" />
    </label>
    <label>
      代号
      <input :value="agent.codename" @input="update('codename', $event)" />
    </label>
    <label>
      描述
      <textarea :value="agent.description" rows="3" @input="update('description', $event)" />
    </label>
    <div class="tags-field">
      <div class="tags-label">标签</div>
      <div class="tags-list">
        <span v-for="tag in tags" :key="tag" class="tag">
          {{ tag }}
          <button type="button" class="tag-remove" @click="removeTag(tag)">×</button>
        </span>
      </div>
      <input
        v-model="tagInput"
        type="text"
        placeholder="按 Enter 添加标签"
        @keydown.enter.prevent="addTag"
      />
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed } from "vue";
import type { AgentConfig } from "@mindcloud/shared";

const props = defineProps<{
  agent: AgentConfig;
  isNew?: boolean;
}>()

const emit = defineEmits<{
  (e: "update", patch: Partial<AgentConfig>): void;
}>();

const tagInput = ref("");

const tags = computed(() => props.agent.tags || []);

function update<K extends keyof AgentConfig>(key: K, event: Event) {
  const target = event.target as HTMLInputElement | HTMLTextAreaElement;
  emit("update", { [key]: target.value } as Partial<AgentConfig>);
}

function addTag() {
  const value = tagInput.value.trim();
  if (!value) return;
  const current = new Set(tags.value);
  if (current.has(value)) return;
  emit("update", { tags: [...tags.value, value] });
  tagInput.value = "";
}

function removeTag(tag: string) {
  emit("update", { tags: tags.value.filter((t) => t !== tag) });
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

.edit-section input,
.edit-section textarea {
  padding: 8px 12px;
  border-radius: 6px;
  border: 1px solid var(--mc-border);
  background: rgba(255, 255, 255, 0.05);
  color: var(--mc-text);
  font-size: 13px;
  resize: vertical;
}

.edit-section input:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

.tags-field {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.tags-label {
  font-size: 13px;
  color: var(--mc-text-secondary);
}

.tags-list {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.tag {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 4px 8px;
  background: rgba(0, 229, 201, 0.12);
  border: 1px solid rgba(0, 229, 201, 0.2);
  border-radius: 6px;
  font-size: 12px;
  color: var(--mc-accent);
}

.tag-remove {
  background: transparent;
  border: none;
  color: inherit;
  cursor: pointer;
  font-size: 14px;
  line-height: 1;
  padding: 0;
}
</style>
