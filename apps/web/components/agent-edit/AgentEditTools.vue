<template>
  <div class="edit-section">
    <div v-if="loading" class="hint">加载工具列表中...</div>
    <div v-else-if="error" class="hint error">{{ error }}</div>
    <div v-else-if="!tools.length" class="hint">暂无可用工具</div>
    <div v-else class="tools-list">
      <label v-for="tool in tools" :key="tool.name" class="tool-item">
        <input
          type="checkbox"
          :checked="isSelected(tool.name)"
          @change="toggle(tool.name)"
        />
        <div class="tool-info">
          <div class="tool-name">{{ tool.name }}</div>
          <div class="tool-meta">{{ tool.toolset }}{{ tool.safeToParallel ? " · 可并行" : "" }}</div>
        </div>
      </label>
    </div>
    <!-- 已勾选但不在可选列表（engine 已下架或列表加载失败）的工具：保留可见，可取消勾选 -->
    <div v-if="missingTools.length" class="tools-list">
      <label v-for="name in missingTools" :key="name" class="tool-item missing">
        <input type="checkbox" checked @change="toggle(name)" />
        <div class="tool-info">
          <div class="tool-name">{{ name }}</div>
          <div class="tool-meta">已下架</div>
        </div>
      </label>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted } from "vue";
import type { AgentConfig } from "@mindcloud/shared";
import { useEngineClient, type ToolInfo } from "@/composables/useEngineClient";

const props = defineProps<{
  agent: AgentConfig;
}>();

const emit = defineEmits<{
  (e: "update", patch: Partial<AgentConfig>): void;
}>();

const client = useEngineClient();
const tools = ref<ToolInfo[]>([]);
const loading = ref(false);
const error = ref("");

const selected = computed(() => new Set(props.agent.tools || []));

// 已勾选但不在 engine 可选列表里的工具（下架或列表加载失败）
const missingTools = computed(() =>
  [...selected.value].filter((name) => !tools.value.some((t) => t.name === name)),
);

onMounted(async () => {
  loading.value = true;
  try {
    tools.value = await client.getTools();
  } catch (e) {
    error.value = e instanceof Error ? e.message : "加载工具失败";
  } finally {
    loading.value = false;
  }
});

function isSelected(name: string) {
  return selected.value.has(name);
}

function toggle(name: string) {
  const next = new Set(selected.value);
  if (next.has(name)) {
    next.delete(name);
  } else {
    next.add(name);
  }
  emit("update", { tools: Array.from(next) });
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

.hint.error {
  color: var(--mc-danger);
  border-color: rgba(239, 68, 68, 0.3);
}

.tools-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.tool-item {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  padding: 10px 12px;
  background: rgba(255, 255, 255, 0.03);
  border: 1px solid var(--mc-border);
  border-radius: 8px;
  cursor: pointer;
  transition: background 0.15s;
}

.tool-item:hover {
  background: var(--mc-panel);
}

.tool-item.missing {
  border-style: dashed;
  opacity: 0.75;
}

.tool-item input[type="checkbox"] {
  margin-top: 2px;
  accent-color: var(--mc-accent);
}

.tool-info {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.tool-name {
  font-size: 13px;
  color: var(--mc-text);
}

.tool-meta {
  font-size: 11px;
  color: var(--mc-text-tertiary);
}
</style>
