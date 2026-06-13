<template>
  <div class="ae-panel-section">
    <div class="memory-editor">
      <div class="file-header">
        <span class="file-name">MEMORY.md</span>
        <span class="file-hint">长期记忆</span>
      </div>
      <MarkdownEditor
        :model-value="memoryContent"
        placeholder="编辑 MEMORY.md..."
        @update:model-value="memoryContent = $event"
        @save="saveMemory"
      />
      <div class="file-actions">
        <button class="ae-mini-btn" :disabled="!agent.id || saving" @click="saveMemory">
          {{ saving ? '保存中...' : '保存' }}
        </button>
      </div>
    </div>

    <div class="compressed-section">
      <div class="section-title">话题摘要</div>
      <div v-if="loading" class="ae-hint">加载中...</div>
      <div v-else-if="!topics.length" class="ae-hint">暂无话题摘要</div>
      <div v-for="t in topics" :key="t.id" class="topic-card">
        <div class="topic-name">
          {{ t.name }}<span v-if="t.subtopic_name"> / {{ t.subtopic_name }}</span>
        </div>
        <div class="topic-meta">
          重要性: {{ t.importance }} · 回合 {{ t.start_round }}-{{ t.end_round }}
        </div>
        <div class="topic-summary">{{ t.summary }}</div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, watch } from 'vue'
import { api } from '@/api/client'
import { pushLog } from '@/composables/useWebSocket'
import MarkdownEditor from '@/components/ui/MarkdownEditor.vue'

interface AgentMemory {
  id?: string | null
}

const props = defineProps<{
  agent: AgentMemory
  loading?: boolean
}>()

const emit = defineEmits<{
  'update:agent': [data: Partial<AgentMemory>]
  save: [field: string]
  reset: [field: string]
}>()

const memoryContent = ref('')
const saving = ref(false)
const topics = ref<any[]>([])
const loading = ref(false)

watch(() => props.agent.id, (id) => {
  if (id) {
    loadMemory()
    loadTopics()
  }
}, { immediate: true })

async function loadMemory() {
  if (!props.agent.id) return
  try {
    const json = await api.get(`/agents/${props.agent.id}/mind/MEMORY`)
    memoryContent.value = json.code === 0 ? json.data?.content ?? '' : ''
  } catch (e: any) {
    memoryContent.value = ''
    pushLog({ type: 'error', source: 'AgentEditMemory', message: `加载 MEMORY.md 失败: ${e}` })
  }
}

async function saveMemory() {
  if (!props.agent.id) return
  saving.value = true
  try {
    const json = await api.put(`/agents/${props.agent.id}/mind/MEMORY`, { content: memoryContent.value })
    if (json.code === 0) {
      pushLog({ type: 'success', source: 'AgentEditMemory', message: 'MEMORY.md 已保存' })
      emit('save', 'MEMORY')
    } else {
      pushLog({ type: 'error', source: 'AgentEditMemory', message: `保存 MEMORY.md 失败: ${json.message}` })
    }
  } catch (e: any) {
    pushLog({ type: 'error', source: 'AgentEditMemory', message: `保存 MEMORY.md 失败: ${e}` })
  } finally {
    saving.value = false
  }
}

async function loadTopics() {
  if (!props.agent.id) return
  loading.value = true
  try {
    const json = await api.get(`/agents/${props.agent.id}/memory`)
    topics.value = json.code === 0 ? json.data?.topics || [] : []
  } catch (e: any) {
    topics.value = []
    pushLog({ type: 'error', source: 'AgentEditMemory', message: `加载话题摘要失败: ${e}` })
  } finally {
    loading.value = false
  }
}
</script>

<style scoped>
@import '@/styles/agent-edit.css';

.memory-editor {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 12px;
  background: rgba(255, 255, 255, 0.02);
  border: 1px solid var(--ae-input-border);
  border-radius: 8px;
}

.file-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.file-name {
  font-size: 13px;
  color: var(--ae-text);
  font-weight: 600;
}

.file-hint {
  font-size: 11px;
  color: var(--ae-text-dim);
}

.file-actions {
  display: flex;
  gap: 8px;
  justify-content: flex-end;
}

.compressed-section {
  margin-top: 16px;
}

.section-title {
  font-size: 13px;
  color: var(--ae-text-muted);
  margin-bottom: 8px;
}

.topic-card {
  padding: 10px 12px;
  background: var(--ae-input-bg);
  border: 1px solid var(--ae-input-border);
  border-radius: 8px;
  margin-bottom: 8px;
}

.topic-name {
  font-size: 13px;
  color: var(--ae-text);
  font-weight: 600;
}

.topic-meta {
  font-size: 11px;
  color: var(--ae-text-dim);
  margin-top: 2px;
}

.topic-summary {
  font-size: 12px;
  color: var(--ae-text-muted);
  margin-top: 6px;
  line-height: 1.5;
}
</style>
