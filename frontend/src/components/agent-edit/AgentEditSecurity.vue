<template>
  <div class="ae-panel-section">
    <label class="ae-label">额外可访问路径</label>
    <div class="ae-hint" style="margin-bottom: 8px">
      默认允许 workspace/ 和 ~/.cloudmind-zome/。此处添加的路径会扩展该 Agent 的文件访问权限。
      读操作额外允许项目源码目录；写/删操作仍受系统敏感路径黑名单限制。
    </div>

    <div class="tag-input">
      <span
        v-for="(p, i) in paths"
        :key="i"
        class="ae-tag"
        :title="p"
      >
        {{ p }}
        <button @click="remove(i)">×</button>
      </span>
      <input
        v-model="input"
        placeholder="+ 添加绝对路径（如 /home/user/projects）"
        @keydown.enter.prevent="add"
      />
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, watch } from 'vue'
import { pushLog } from '@/composables/useWebSocket'

interface AgentSecurity {
  allowed_paths?: string[]
}

const props = defineProps<{
  agent: AgentSecurity
  loading?: boolean
}>()

const emit = defineEmits<{
  'update:agent': [data: Partial<AgentSecurity>]
  save: [field: string]
  reset: [field: string]
}>()

const paths = ref<string[]>([...(props.agent.allowed_paths || [])])
const input = ref('')

watch(() => props.agent.allowed_paths, (v) => {
  paths.value = [...(v || [])]
}, { deep: true })

function isAbsolute(p: string) {
  return p.startsWith('/') || p.startsWith('~') || /^[A-Za-z]:\\/.test(p)
}

function add() {
  const p = input.value.trim()
  if (!p) return
  if (!isAbsolute(p)) {
    pushLog({ type: 'error', source: 'AgentEditSecurity', message: '路径必须是绝对路径（如 /home/user/dir 或 C:\\path）' })
    return
  }
  if (!paths.value.includes(p)) {
    paths.value = [...paths.value, p]
    emit('update:agent', { allowed_paths: [...paths.value] })
  }
  input.value = ''
}

function remove(i: number) {
  const next = [...paths.value]
  next.splice(i, 1)
  paths.value = next
  emit('update:agent', { allowed_paths: next })
}
</script>

<style scoped>
@import '@/styles/agent-edit.css';

.tag-input {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  align-items: center;
  padding: 8px;
  background: var(--ae-input-bg);
  border: 1px solid var(--ae-input-border);
  border-radius: 8px;
}

.tag-input input {
  flex: 1;
  min-width: 200px;
  background: transparent;
  border: none;
  color: var(--ae-text);
  font-size: 13px;
  padding: 4px;
}

.tag-input input:focus {
  outline: none;
}
</style>
