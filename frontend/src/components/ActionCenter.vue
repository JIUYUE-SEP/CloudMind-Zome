<template>
  <div class="action-center">
    <header class="ac-header">
      <BackButton />
      <h2>行动中心</h2>
      <button class="primary-btn" @click="createAction">+ 新建行动</button>
    </header>

    <div class="ac-tabs">
      <button
        v-for="t in tabs"
        :key="t.value"
        :class="{ active: activeTab === t.value }"
        @click="activeTab = t.value"
      >{{ t.label }}</button>
    </div>

    <div class="ac-list">
      <div
        v-for="action in filteredActions"
        :key="action.id"
        class="action-card"
        @click="openAction(action)"
      >
        <div class="ac-top">
          <span class="ac-name">{{ action.name }}</span>
          <span class="ac-status" :class="action.status">{{ statusLabel(action.status) }}</span>
        </div>
        <div class="ac-meta">
          {{ action.node_count }} 节点 · {{ action.run_count }} 次执行 · {{ action.updated_at }}
        </div>
        <div class="ac-actions">
          <button @click.stop="runAction(action.id)">运行</button>
          <button @click.stop="editAction(action.id)">编辑</button>
          <button class="danger" @click.stop="deleteAction(action.id)">删除</button>
        </div>
      </div>
    </div>

    <!-- Mini panel for running execution -->
    <ActionRunPanel
      v-if="activeRun"
      :run-id="activeRun.run_id"
      :action-id="activeRun.action_id"
      @close="activeRun = null"
    />
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { api } from '@/api/client'
import ActionRunPanel from './ActionRunPanel.vue'
import BackButton from '@/components/BackButton.vue'

const router = useRouter()

const tabs = [
  { label: '全部', value: 'all' },
  { label: '草稿', value: 'draft' },
  { label: '活跃', value: 'active' },
  { label: '已归档', value: 'archived' },
]
const activeTab = ref('all')
const actions = ref<any[]>([])
const activeRun = ref<{ run_id: string; action_id: string } | null>(null)

const filteredActions = computed(() => {
  if (activeTab.value === 'all') return actions.value
  return actions.value.filter(a => a.status === activeTab.value)
})

onMounted(fetchActions)

async function fetchActions() {
  const json = await api.get('/actions')
  if (json.code === 0) {
    actions.value = json.data.items
  }
}

function statusLabel(s: string) {
  const map: Record<string, string> = { draft: '草稿', active: '活跃', archived: '已归档' }
  return map[s] || s
}

async function runAction(actionId: string) {
  const json = await api.post(`/actions/${actionId}/run`)
  if (json.code === 0) {
    activeRun.value = { run_id: json.data.run_id, action_id: actionId }
  }
}

async function deleteAction(actionId: string) {
  if (!confirm('确定要删除这个行动吗？')) return
  const json = await api.delete(`/actions/${actionId}`)
  if (json.code === 0) {
    await fetchActions()
  }
}

function createAction() {
  router.push('/actions/new')
}

function editAction(id: string) {
  router.push(`/actions/${id}/edit`)
}

function openAction(action: any) {
  router.push(`/actions/${action.id}/edit`)
}
</script>

<style scoped>
.action-center {
  position: fixed; inset: 0;
  background: #0B0F17;
  z-index: 900;
  display: flex; flex-direction: column;
}
.ac-header {
  height: 56px;
  display: flex; align-items: center; gap: 16px;
  padding: 0 20px;
  border-bottom: 1px solid rgba(255,255,255,0.06);
}

h2 { flex: 1; font-size: 18px; margin: 0; color: #D8E1EC; }
.primary-btn {
  padding: 8px 16px; background: #00E5C9; color: #0B0F17;
  border: none; border-radius: 6px; font-weight: 600; cursor: pointer;
}

.ac-tabs {
  display: flex; gap: 4px; padding: 12px 20px;
  border-bottom: 1px solid rgba(255,255,255,0.04);
}
.ac-tabs button {
  padding: 6px 14px; background: transparent;
  border: none; color: #8899AA; font-size: 13px;
  border-radius: 6px; cursor: pointer;
}
.ac-tabs button.active {
  background: rgba(0,229,201,0.12); color: #00E5C9;
}

.ac-list {
  flex: 1; overflow-y: auto;
  padding: 16px 20px;
  display: flex; flex-direction: column; gap: 10px;
}
.action-card {
  background: rgba(20,27,36,0.6);
  border: 1px solid rgba(255,255,255,0.04);
  border-radius: 10px; padding: 16px;
  cursor: pointer; transition: transform 0.15s;
}
.action-card:hover {
  transform: translateY(-2px);
  border-color: rgba(0,229,201,0.2);
}
.ac-top {
  display: flex; justify-content: space-between; align-items: center;
}
.ac-name { font-size: 15px; color: #D8E1EC; font-weight: 500; }
.ac-status {
  font-size: 11px; padding: 2px 8px;
  border-radius: 12px; background: #1E2731; color: #8899AA;
}
.ac-status.active { background: rgba(0,229,201,0.15); color: #00E5C9; }
.ac-meta { font-size: 12px; color: #5A6A7A; margin-top: 6px; }
.ac-actions {
  display: flex; gap: 8px; margin-top: 12px;
}
.ac-actions button {
  padding: 6px 12px; font-size: 12px;
  background: transparent; border: 1px solid #1E2731;
  color: #8899AA; border-radius: 6px; cursor: pointer;
}
.ac-actions button:hover { border-color: #00E5C9; color: #00E5C9; }
.ac-actions button.danger { border-color: rgba(239,68,68,0.3); color: #EF4444; }
.ac-actions button.danger:hover { border-color: #EF4444; color: #EF4444; }
</style>
