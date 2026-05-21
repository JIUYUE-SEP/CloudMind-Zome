<template>
  <div class="approval-log">
    <header class="al-header">
      <BackButton />
      <h2>审批队列</h2>
    </header>

    <div class="al-tabs">
      <button :class="{ active: tab === 'pending' }" @click="tab = 'pending'">待审批</button>
      <button :class="{ active: tab === 'resolved' }" @click="tab = 'resolved'">已处理</button>
    </div>

    <div class="al-list">
      <div v-for="item in filtered" :key="item.approval_id" class="al-card">
        <div class="al-top">
          <span class="al-agent">{{ item.agent_name }}</span>
          <span class="al-status" :class="item.status">{{ statusText(item.status) }}</span>
        </div>
        <div class="al-tool">{{ item.tool }}</div>
        <pre class="al-cmd">{{ item.command }}</pre>
        <div class="al-meta">来源: {{ item.source }} #{{ item.source_id }}</div>
        <div v-if="item.status === 'pending'" class="al-actions">
          <button class="approve" @click="respond(item.approval_id, 'approve')">批准</button>
          <button class="reject" @click="respond(item.approval_id, 'reject')">拒绝</button>
        </div>
        <div v-else class="al-resolved">
          {{ item.resolved_at }}
          <span v-if="item.reason">— {{ item.reason }}</span>
        </div>
      </div>
      <div v-if="!filtered.length" class="al-empty">暂无记录</div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { api } from '@/api/client'
import BackButton from '@/components/BackButton.vue'

const emit = defineEmits(['close'])
const tab = ref('pending')
const items = ref<any[]>([])

const filtered = computed(() => items.value.filter(i => tab.value === 'pending' ? i.status === 'pending' : i.status !== 'pending'))

onMounted(fetchItems)

async function fetchItems() {
  const json = await api.get('/approvals')
  if (json.code === 0) items.value = json.data.items
}

async function respond(id: string, action: string) {
  await api.post(`/approvals/${id}/${action}`)
  await fetchItems()
}

function statusText(s: string) {
  const map: Record<string, string> = { pending: '待审批', approved: '已批准', rejected: '已拒绝', timeout: '超时' }
  return map[s] || s
}
</script>

<style scoped>
.approval-log { position: fixed; inset: 0; background: #0B0F17; z-index: 900; display: flex; flex-direction: column; }
.al-header { height: 56px; display: flex; align-items: center; gap: 16px; padding: 0 20px; border-bottom: 1px solid rgba(255,255,255,0.06); }
h2 { flex: 1; font-size: 18px; margin: 0; color: #D8E1EC; }
.al-tabs { display: flex; gap: 4px; padding: 12px 20px; border-bottom: 1px solid rgba(255,255,255,0.04); }
.al-tabs button { padding: 6px 14px; background: transparent; border: none; color: #8899AA; font-size: 13px; border-radius: 6px; cursor: pointer; }
.al-tabs button.active { background: rgba(0,229,201,0.12); color: #00E5C9; }
.al-list { flex: 1; overflow-y: auto; padding: 16px 20px; display: flex; flex-direction: column; gap: 10px; }
.al-card { background: rgba(20,27,36,0.6); border-radius: 10px; padding: 16px; }
.al-top { display: flex; justify-content: space-between; align-items: center; }
.al-agent { font-size: 14px; color: #D8E1EC; font-weight: 500; }
.al-status { font-size: 11px; padding: 2px 8px; border-radius: 12px; background: #1E2731; color: #8899AA; }
.al-status.pending { background: rgba(255,107,53,0.15); color: #FF6B35; }
.al-status.approved { background: rgba(16,185,129,0.15); color: #10B981; }
.al-status.rejected { background: rgba(239,68,68,0.15); color: #EF4444; }
.al-tool { font-size: 12px; color: #5A6A7A; margin-top: 6px; }
.al-cmd { margin: 8px 0; padding: 10px; background: #0B0F17; border-radius: 6px; font-size: 12px; color: #8899AA; white-space: pre-wrap; word-break: break-word; font-family: monospace; }
.al-meta { font-size: 11px; color: #5A6A7A; }
.al-actions { display: flex; gap: 8px; margin-top: 12px; }
.al-actions button { flex: 1; padding: 8px; border: none; border-radius: 6px; cursor: pointer; font-weight: 600; }
.al-actions .approve { background: #10B981; color: #fff; }
.al-actions .reject { background: transparent; border: 1px solid #EF4444; color: #EF4444; }
.al-resolved { font-size: 11px; color: #5A6A7A; margin-top: 8px; }
.al-empty { text-align: center; padding: 40px; color: #5A6A7A; }
</style>
