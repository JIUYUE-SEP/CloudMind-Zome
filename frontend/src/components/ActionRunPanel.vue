<template>
  <div class="run-panel">
    <div class="rp-header">
      <span class="rp-title">执行中</span>
      <button class="rp-close" @click="emit('close')">x</button>
    </div>

    <div class="rp-progress">
      <div class="rp-bar">
        <div class="rp-fill" :style="{ width: progressPercent + '%' }"></div>
      </div>
      <div class="rp-stats">
        节点 {{ currentNode }} / {{ totalNodes }} · {{ elapsed }}
      </div>
    </div>

    <div class="rp-nodes">
      <div
        v-for="(n, idx) in nodeStates"
        :key="idx"
        class="rp-node"
        :class="n.status"
      >
        <div class="rp-dot"></div>
        <div class="rp-info">
          <div class="rp-node-name">{{ n.node_id }}</div>
          <div class="rp-node-status">{{ statusText(n.status) }}</div>
        </div>
      </div>
    </div>

    <div class="rp-logs" v-if="logs">
      <pre>{{ logs }}</pre>
    </div>

    <div class="rp-controls">
      <button v-if="runStatus === 'running'" class="stop-btn" @click="stopRun">停止</button>
      <button v-else class="done-btn" @click="emit('close')">关闭</button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted, onBeforeUnmount, computed } from 'vue'
import { api } from '@/api/client'
import { useWebSocket } from '@/composables/useWebSocket'

const props = defineProps<{ runId: string; actionId: string }>()
const emit = defineEmits(['close'])

const ws = useWebSocket()
const runStatus = ref('running')
const nodeStates = ref<any[]>([])
const logs = ref('')
const currentNode = ref(0)
const totalNodes = ref(0)
const startTime = ref(Date.now())

const progressPercent = computed(() => {
  if (!totalNodes.value) return 0
  return (currentNode.value / totalNodes.value) * 100
})

const elapsed = computed(() => {
  const sec = Math.floor((Date.now() - startTime.value) / 1000)
  const m = Math.floor(sec / 60)
  const s = sec % 60
  return `${m}m${s.toString().padStart(2, '0')}s`
})

let pollTimer: ReturnType<typeof setInterval>

onMounted(() => {
  pollTimer = setInterval(pollRun, 2000)
  pollRun()
  // Listen for WS progress events
  window.addEventListener('ws:action.progress', onWsProgress as any)
})

onBeforeUnmount(() => {
  clearInterval(pollTimer)
  window.removeEventListener('ws:action.progress', onWsProgress as any)
})

function onWsProgress(e: any) {
  const p = e.detail?.payload
  if (p?.run_id !== props.runId) return
  currentNode.value = p.current || 0
  totalNodes.value = p.total || 0
  if (p.node_status === 'completed' && p.current === p.total) {
    runStatus.value = 'completed'
  }
}

async function pollRun() {
  const json = await api.get(`/actions/${props.actionId}/runs/${props.runId}`)
  if (json.code === 0) {
    runStatus.value = json.data.status
    nodeStates.value = json.data.node_states || []
    logs.value = json.data.logs || ''
    if (nodeStates.value.length) {
      currentNode.value = nodeStates.value.filter((n: any) => n.status === 'completed').length
      totalNodes.value = nodeStates.value.length
    }
    if (['completed', 'failed', 'stopped'].includes(runStatus.value)) {
      clearInterval(pollTimer)
    }
  }
}

async function stopRun() {
  await api.post(`/actions/${props.actionId}/runs/${props.runId}/stop`)
  runStatus.value = 'stopped'
}

function statusText(s: string) {
  const map: Record<string, string> = {
    pending: '等待', running: '运行中', completed: '完成',
    failed: '失败', waiting_approval: '待审批', stopped: '已停止',
  }
  return map[s] || s
}
</script>

<style scoped>
.run-panel {
  position: fixed;
  right: 20px; bottom: 76px;
  width: 360px;
  background: rgba(11,15,23,0.95);
  border: 1px solid rgba(255,255,255,0.08);
  border-radius: 12px;
  padding: 16px;
  z-index: 950;
  display: flex; flex-direction: column; gap: 12px;
  max-height: 60vh;
}
.rp-header {
  display: flex; justify-content: space-between; align-items: center;
}
.rp-title { font-size: 14px; font-weight: 600; color: #D8E1EC; }
.rp-close { background: transparent; border: none; color: #8899AA; cursor: pointer; }

.rp-bar {
  height: 6px; background: #1E2731; border-radius: 3px; overflow: hidden;
}
.rp-fill {
  height: 100%; background: linear-gradient(90deg, #00E5C9, #00BFA0);
  transition: width 0.3s ease;
}
.rp-stats { font-size: 11px; color: #5A6A7A; margin-top: 6px; }

.rp-nodes {
  display: flex; flex-direction: column; gap: 6px;
  max-height: 200px; overflow-y: auto;
}
.rp-node {
  display: flex; align-items: center; gap: 10px;
  padding: 8px 10px; border-radius: 6px; background: rgba(255,255,255,0.02);
}
.rp-dot {
  width: 8px; height: 8px; border-radius: 50%;
  background: #4A5568;
}
.rp-node.running .rp-dot { background: #3B82F6; animation: pulse 1.5s infinite; }
.rp-node.completed .rp-dot { background: #10B981; }
.rp-node.failed .rp-dot { background: #EF4444; }
.rp-node.waiting_approval .rp-dot { background: #FF6B35; animation: pulse 2s infinite; }
@keyframes pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.4; }
}
.rp-node-name { font-size: 12px; color: #D8E1EC; }
.rp-node-status { font-size: 11px; color: #5A6A7A; }

.rp-logs {
  flex: 1; min-height: 60px;
  background: #0B0F17; border-radius: 6px; padding: 8px;
  overflow-y: auto;
}
.rp-logs pre {
  margin: 0; font-size: 11px; color: #5A6A7A; white-space: pre-wrap;
  font-family: monospace;
}

.rp-controls {
  display: flex; justify-content: flex-end;
}
.stop-btn {
  padding: 8px 16px; background: #EF4444; color: #fff;
  border: none; border-radius: 6px; cursor: pointer; font-size: 12px;
}
.done-btn {
  padding: 8px 16px; background: #1E2731; color: #D8E1EC;
  border: none; border-radius: 6px; cursor: pointer; font-size: 12px;
}
</style>
