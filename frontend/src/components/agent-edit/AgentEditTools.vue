<template>
  <div class="ae-panel-section">
    <div class="tools-actions">
      <button class="ae-mini-btn" @click="selectAll">全选</button>
      <button class="ae-mini-btn" @click="clearAll">全部取消</button>
    </div>

    <div
      v-for="(info, ts) in availableTools"
      :key="ts"
      class="toolset-group"
    >
      <div
        class="toolset-header"
        @click="toggleExpand(ts as string)"
      >
        <span class="toolset-name">{{ info.label }} ({{ info.tools?.length || 0 }})</span>
        <span class="toolset-meta">
          已选 {{ selectedCount(ts as string) }}/{{ info.tools?.length || 0 }}
          {{ expanded.has(ts as string) ? '▼' : '▶' }}
        </span>
      </div>

      <div v-if="expanded.has(ts as string)" class="toolset-body">
        <div
          v-for="tool in info.tools"
          :key="tool.name"
          class="tool-row"
          :title="tool.description || tool.label"
        >
          <input
            type="checkbox"
            :checked="isChecked(ts as string)"
            @change="toggle(ts as string)"
          />
          <span>{{ tool.label }}</span>
        </div>
      </div>
    </div>

    <div v-if="!Object.keys(availableTools).length" class="ae-hint">
      暂无可用工具集
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted, watch } from 'vue'
import { api } from '@/api/client'

interface AgentToolsData {
  toolsets?: string[]
}

const props = defineProps<{
  agent: AgentToolsData
  loading?: boolean
}>()

const emit = defineEmits<{
  'update:agent': [data: Partial<AgentToolsData>]
  save: [field: string]
  reset: [field: string]
}>()

const availableTools = ref<Record<string, any>>({})
const expanded = ref<Set<string>>(new Set())

const toolsets = ref<string[]>([...(props.agent.toolsets || [])])

watch(() => props.agent.toolsets, (v) => {
  toolsets.value = [...(v || [])]
}, { deep: true })

onMounted(async () => {
  const json = await api.get('/tools/available')
  if (json.code === 0) {
    availableTools.value = json.data?.toolsets || {}
  }
})

function isChecked(toolset: string) {
  return toolsets.value.includes(toolset)
}

function selectedCount(toolset: string) {
  return isChecked(toolset) ? (availableTools.value[toolset]?.tools?.length || 0) : 0
}

function toggle(toolset: string) {
  const has = toolsets.value.includes(toolset)
  const next = has
    ? toolsets.value.filter((t) => t !== toolset)
    : [...toolsets.value, toolset]
  toolsets.value = next
  emit('update:agent', { toolsets: next })
}

function selectAll() {
  toolsets.value = Object.keys(availableTools.value)
  emit('update:agent', { toolsets: [...toolsets.value] })
}

function clearAll() {
  toolsets.value = []
  emit('update:agent', { toolsets: [] })
}

function toggleExpand(toolset: string) {
  const next = new Set(expanded.value)
  if (next.has(toolset)) next.delete(toolset)
  else next.add(toolset)
  expanded.value = next
}
</script>

<style scoped>
@import '@/styles/agent-edit.css';

.tools-actions {
  display: flex;
  gap: 8px;
  margin-bottom: 4px;
}

.toolset-group {
  margin-bottom: 12px;
  border: 1px solid var(--ae-input-border);
  border-radius: 8px;
  overflow: hidden;
}

.toolset-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 12px;
  background: rgba(255, 255, 255, 0.03);
  cursor: pointer;
}

.toolset-name {
  font-size: 13px;
  font-weight: 600;
  color: var(--ae-text);
}

.toolset-meta {
  font-size: 12px;
  color: var(--ae-text-dim);
}

.toolset-body {
  padding: 8px 12px;
}

.tool-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 4px 0;
  font-size: 13px;
  color: var(--ae-text);
  cursor: pointer;
}

.tool-row input[type='checkbox'] {
  width: auto;
}
</style>
