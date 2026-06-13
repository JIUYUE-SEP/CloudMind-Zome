<template>
  <div class="ae-panel-section">
    <div class="persona-actions">
      <button class="ae-mini-btn" :disabled="!agent.id || loading" @click="openMemory">查看记忆</button>
      <button class="ae-mini-btn" :disabled="!agent.id || loading" @click="analyzePersonality">自动分析人格</button>
      <button class="ae-mini-btn" :disabled="!agent.id || loading" @click="openImportHistory">导入对话历史</button>
    </div>

    <div class="file-editor" v-for="file in mindFiles" :key="file">
      <div class="file-header">
        <span class="file-name">{{ file }}.md</span>
        <span class="file-hint">{{ fileHint(file) }}</span>
      </div>
      <MarkdownEditor
        :model-value="contents[file]"
        :placeholder="placeholder(file)"
        @update:model-value="updateFile(file, $event)"
        @save="saveFile(file)"
      />
      <div class="file-actions">
        <button class="ae-mini-btn" :disabled="!agent.id || saving[file] || loading" @click="saveFile(file)">
          {{ saving[file] ? '保存中...' : '保存' }}
        </button>
        <button class="ae-mini-btn secondary" :disabled="!agent.id || loading" @click="resetFile(file)">恢复默认</button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, watch, reactive } from 'vue'
import { api } from '@/api/client'
import { pushLog } from '@/composables/useWebSocket'
import MarkdownEditor from '@/components/ui/MarkdownEditor.vue'

interface AgentPersona {
  id?: string | null
  name?: string
}

const props = defineProps<{
  agent: AgentPersona
  loading?: boolean
}>()

const emit = defineEmits<{
  'update:agent': [data: Partial<AgentPersona>]
  save: [field: string]
  reset: [field: string]
}>()

const mindFiles = ['SOUL', 'AGENT', 'USER', 'MEMORY'] as const
type MindFile = typeof mindFiles[number]

const contents = reactive<Record<MindFile, string>>({
  SOUL: '',
  AGENT: '',
  USER: '',
  MEMORY: '',
})

const saving = reactive<Record<MindFile, boolean>>({
  SOUL: false,
  AGENT: false,
  USER: false,
  MEMORY: false,
})

const loadingFiles = reactive<Record<MindFile, boolean>>({
  SOUL: false,
  AGENT: false,
  USER: false,
  MEMORY: false,
})

watch(() => props.agent.id, (id) => {
  if (id) loadAllFiles()
}, { immediate: true })

function fileHint(file: MindFile) {
  const map: Record<MindFile, string> = {
    SOUL: '心智的灵魂内核——定义它是谁、怎么说话',
    AGENT: '工作规则和行为准则',
    USER: '心智对你的理解和认知',
    MEMORY: '长期记忆',
  }
  return map[file]
}

function placeholder(file: MindFile) {
  return props.agent.id
    ? `编辑 ${file}.md...`
    : '先保存或选择一个心智后再编辑'
}

async function loadAllFiles() {
  for (const file of mindFiles) {
    await loadFile(file)
  }
}

async function loadFile(file: MindFile) {
  if (!props.agent.id) return
  loadingFiles[file] = true
  try {
    const json = await api.get(`/agents/${props.agent.id}/mind/${file}`)
    contents[file] = json.code === 0 ? json.data?.content ?? '' : ''
  } catch (e: any) {
    contents[file] = ''
    pushLog({ type: 'error', source: 'AgentEditPersona', message: `加载 ${file}.md 失败: ${e}` })
  } finally {
    loadingFiles[file] = false
  }
}

async function saveFile(file: MindFile) {
  if (!props.agent.id) return
  saving[file] = true
  try {
    const json = await api.put(`/agents/${props.agent.id}/mind/${file}`, { content: contents[file] })
    if (json.code === 0) {
      pushLog({ type: 'success', source: 'AgentEditPersona', message: `${file}.md 已保存` })
      emit('save', file)
    } else {
      pushLog({ type: 'error', source: 'AgentEditPersona', message: `保存 ${file}.md 失败: ${json.message}` })
    }
  } catch (e: any) {
    pushLog({ type: 'error', source: 'AgentEditPersona', message: `保存 ${file}.md 失败: ${e}` })
  } finally {
    saving[file] = false
  }
}

function resetFile(file: MindFile) {
  emit('reset', file)
  loadFile(file)
}

function updateFile(file: MindFile, value: string) {
  contents[file] = value
}

function openMemory() {
  emit('update:agent', { __openMemory: true } as any)
}

async function analyzePersonality() {
  if (!props.agent.id) return
  try {
    const json = await api.post(`/agents/${props.agent.id}/analyze-personality`)
    if (json.code === 0) {
      emit('update:agent', { __personaResult: json.data } as any)
    } else {
      pushLog({ type: 'error', source: 'AgentEditPersona', message: `人格分析失败: ${json.message}` })
    }
  } catch (e: any) {
    pushLog({ type: 'error', source: 'AgentEditPersona', message: `人格分析失败: ${e}` })
  }
}

function openImportHistory() {
  emit('update:agent', { __openImportHistory: true } as any)
}
</script>

<style scoped>
@import '@/styles/agent-edit.css';

.persona-actions {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
  margin-bottom: 8px;
}

.file-editor {
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

.ae-mini-btn.secondary {
  background: transparent;
  border-color: var(--ae-input-border);
  color: var(--ae-text-muted);
}
</style>
