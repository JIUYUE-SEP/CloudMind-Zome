<template>
  <div class="commission-center">
    <header class="cc-header">
      <BackButton />
      <h2>自动委托</h2>
      <button class="primary-btn" @click="showCreate = true">+ 新建委托</button>
    </header>

    <div class="cc-list">
      <div v-for="c in commissions" :key="c.id" class="cc-card">
        <div class="cc-top">
          <span class="cc-name">{{ c.name }}</span>
          <span class="cc-status" :class="c.status">{{ statusLabel(c.status) }}</span>
        </div>
        <div class="cc-meta">触发: {{ c.trigger_type }} · 下次: {{ c.next_run_at || '—' }}</div>
        <div class="cc-actions">
          <button v-if="c.status === 'active'" @click="toggle(c.id, 'paused')">暂停</button>
          <button v-else @click="toggle(c.id, 'active')">启用</button>
          <button @click="showLogs(c.id)">日志</button>
          <button class="danger" @click="del(c.id)">删除</button>
        </div>
      </div>
      <div v-if="!commissions.length" class="cc-empty">暂无委托</div>
    </div>

    <!-- Create Modal -->
    <div v-if="showCreate" class="modal-overlay" @click="showCreate = false">
      <div class="modal-card" @click.stop>
        <h3>新建委托</h3>
        <input v-model="form.name" placeholder="委托名称" />
        <select v-model="form.agent_id">
          <option v-for="a in agents" :key="a.id" :value="a.id">{{ a.name }}</option>
        </select>
        <select v-model="form.trigger_type">
          <option value="cron">定时 (Cron)</option>
          <option value="manual">手动触发</option>
        </select>
        <input v-if="form.trigger_type === 'cron'" v-model="form.cron" placeholder="Cron 表达式，如 0 9 * * *" />
        <textarea v-model="form.prompt" rows="3" placeholder="每次触发时发送给心智的指令" />
        <div class="modal-actions">
          <button @click="submit">保存</button>
          <button class="secondary" @click="showCreate = false">取消</button>
        </div>
      </div>
    </div>

    <!-- Logs Modal -->
    <div v-if="logId" class="modal-overlay" @click="logId = null">
      <div class="modal-card" @click.stop>
        <h3>执行日志</h3>
        <div class="log-list">
          <div v-for="l in logs" :key="l.id" class="log-row">
            <span :class="l.status">{{ l.status }}</span>
            <span>{{ l.result_summary }}</span>
            <span class="log-time">{{ l.executed_at }}</span>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { useAgentsStore } from '@/stores/agents'
import { api } from '@/api/client'
import BackButton from '@/components/BackButton.vue'

const emit = defineEmits(['close'])
const commissions = ref<any[]>([])
const agents = ref<any[]>([])
const showCreate = ref(false)
const logId = ref<string | null>(null)
const logs = ref<any[]>([])
const form = ref({ name: '', agent_id: '', trigger_type: 'cron', cron: '', prompt: '' })

onMounted(async () => {
  await fetchCommissions()
  const aStore = useAgentsStore()
  await aStore.fetchList()
  agents.value = aStore.list
})

async function fetchCommissions() {
  const json = await api.get('/commissions')
  if (json.code === 0) commissions.value = json.data.items
}

async function submit() {
  const body = {
    name: form.value.name,
    agent_id: form.value.agent_id,
    trigger_type: form.value.trigger_type,
    trigger_config: form.value.trigger_type === 'cron' ? { expression: form.value.cron } : {},
    action_type: 'preset_chat',
    action_config: { preset_id: form.value.prompt },
  }
  await api.post('/commissions', body)
  showCreate.value = false
  await fetchCommissions()
}

async function toggle(id: string, status: string) {
  await api.put(`/commissions/${id}`, { status })
  await fetchCommissions()
}

async function del(id: string) {
  await api.delete(`/commissions/${id}`)
  await fetchCommissions()
}

async function showLogs(id: string) {
  logId.value = id
  const json = await api.get(`/commissions/${id}/logs`)
  if (json.code === 0) logs.value = json.data.items
}

function statusLabel(s: string) {
  const map: Record<string, string> = { active: '活跃', paused: '暂停', ended: '已结束', error: '错误' }
  return map[s] || s
}
</script>

<style scoped>
.commission-center { position: fixed; inset: 0; background: #0B0F17; z-index: 900; display: flex; flex-direction: column; }
.cc-header { height: 56px; display: flex; align-items: center; gap: 16px; padding: 0 20px; border-bottom: 1px solid rgba(255,255,255,0.06); }
h2 { flex: 1; font-size: 18px; margin: 0; color: #D8E1EC; }
.primary-btn { padding: 8px 16px; background: #00E5C9; color: #0B0F17; border: none; border-radius: 6px; font-weight: 600; cursor: pointer; }
.cc-list { flex: 1; overflow-y: auto; padding: 16px 20px; display: flex; flex-direction: column; gap: 10px; }
.cc-card { background: rgba(20,27,36,0.6); border-radius: 10px; padding: 16px; }
.cc-top { display: flex; justify-content: space-between; align-items: center; }
.cc-name { font-size: 15px; color: #D8E1EC; font-weight: 500; }
.cc-status { font-size: 11px; padding: 2px 8px; border-radius: 12px; background: #1E2731; color: #8899AA; }
.cc-status.active { background: rgba(0,229,201,0.15); color: #00E5C9; }
.cc-meta { font-size: 12px; color: #5A6A7A; margin-top: 6px; }
.cc-actions { display: flex; gap: 8px; margin-top: 12px; }
.cc-actions button { padding: 6px 12px; font-size: 12px; background: transparent; border: 1px solid #1E2731; color: #8899AA; border-radius: 6px; cursor: pointer; }
.cc-actions button:hover { border-color: #00E5C9; color: #00E5C9; }
.cc-actions button.danger:hover { border-color: #EF4444; color: #EF4444; }
.cc-empty { text-align: center; padding: 40px; color: #5A6A7A; }

.modal-overlay { position: fixed; inset: 0; background: rgba(0,0,0,0.6); display: flex; align-items: center; justify-content: center; z-index: 800; }
.modal-card { width: 400px; max-height: 70vh; overflow-y: auto; padding: 24px; background: rgba(20,27,36,0.95); border: 1px solid rgba(0,229,201,0.2); border-radius: 12px; }
.modal-card h3 { margin: 0 0 16px; font-size: 16px; color: #D8E1EC; }
.modal-card input, .modal-card select, .modal-card textarea { width: 100%; margin: 8px 0; padding: 10px; background: #0B0F17; border: 1px solid #1E2731; border-radius: 6px; color: #D8E1EC; }
.modal-actions { display: flex; gap: 10px; margin-top: 12px; }
.modal-actions button { flex: 1; padding: 10px; background: #00E5C9; color: #0B0F17; border: none; border-radius: 6px; cursor: pointer; font-weight: 600; }
.modal-actions button.secondary { background: transparent; border: 1px solid #1E2731; color: #8899AA; }

.log-list { display: flex; flex-direction: column; gap: 8px; }
.log-row { display: flex; justify-content: space-between; align-items: center; font-size: 13px; color: #D8E1EC; padding: 8px; background: #0B0F17; border-radius: 6px; }
.log-row .success { color: #10B981; }
.log-row .failed { color: #EF4444; }
.log-time { font-size: 11px; color: #5A6A7A; }
</style>
