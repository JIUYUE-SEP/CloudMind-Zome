<template>
  <div class="edit-section">
    <div class="hint">输入技能名称，按 Enter 添加为标签。</div>
    <div class="tags-list">
      <span v-for="skill in skills" :key="skill" class="skill-tag">
        {{ skill }}
        <button type="button" class="tag-remove" @click="removeSkill(skill)">×</button>
      </span>
    </div>
    <input
      v-model="skillInput"
      type="text"
      placeholder="按 Enter 添加技能"
      @keydown.enter.prevent="addSkill"
    />
  </div>
</template>

<script setup lang="ts">
import { ref, computed } from "vue";
import type { AgentConfig } from "@mindcloud/shared";

const props = defineProps<{
  agent: AgentConfig;
}>();

const emit = defineEmits<{
  (e: "update", patch: Partial<AgentConfig>): void;
}>();

const skillInput = ref("");

const skills = computed(() => props.agent.skills || []);

function addSkill(e: KeyboardEvent) {
  // 中文输入法选词确认也是 Enter，合成态下不误添加
  if (e.isComposing) return;
  const value = skillInput.value.trim();
  if (!value) return;
  const current = new Set(skills.value);
  if (current.has(value)) return;
  emit("update", { skills: [...skills.value, value] });
  skillInput.value = "";
}

function removeSkill(skill: string) {
  emit("update", { skills: skills.value.filter((s) => s !== skill) });
}
</script>

<style scoped>
.edit-section {
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.hint {
  font-size: 12px;
  color: var(--mc-text-tertiary);
  padding: 10px 12px;
  background: rgba(255, 255, 255, 0.03);
  border: 1px solid var(--mc-border);
  border-radius: 6px;
}

.tags-list {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.skill-tag {
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

.edit-section input {
  padding: 8px 12px;
  border-radius: 6px;
  border: 1px solid var(--mc-border);
  background: rgba(255, 255, 255, 0.05);
  color: var(--mc-text);
  font-size: 13px;
}
</style>
