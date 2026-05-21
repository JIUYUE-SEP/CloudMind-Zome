<template>
  <div class="action-edit">
    <!-- Header -->
    <header class="ae-header">
      <BackButton />
      <input v-model="form.name" class="ae-title-input" placeholder="行动名称" />
      <button class="primary-btn" @click="save">保存</button>
    </header>

    <!-- Body: 3 columns -->
    <div class="ae-body">
      <!-- Left: Node palette -->
      <aside class="ae-palette">
        <div class="palette-title">节点库</div>
        <div
          v-for="t in nodeTypes"
          :key="t.type"
          class="palette-item"
          @click="addNode(t.type)"
        >
          <span class="p-icon" :style="{ color: t.color }"">{{ t.icon }}</span>
          <span class="p-label"
>{{ t.label }}</span>
        </div>
      </aside>

      <!-- Center: Blueprint canvas -->
      <main class="ae-canvas-wrap">
        <BlueprintCanvas
          :nodes="form.nodes"
          :edges="form.edges"
          :agents="agents"
          @update:nodes="form.nodes = $event"
          @update:edges="form.edges = $event"
          @select="selectedNodeId = $event"
        />
      </main>

      <!-- Right: Properties panel -->
      <aside v-if="selectedNode" class="ae-props">
        <div class="props-header"
>
          {{ nodeTypeLabel(selectedNode.type) }} 属性
          <button class="props-close" @click="selectedNodeId = ''"
>×</button>
        </div>

        <div class="props-body"
>
          <!-- Common: instruction -->
          <label v-if="selectedNode.type !== 'start' && selectedNode.type !== 'end'"
>指令</label>
          <textarea
            v-if="selectedNode.type !== 'start' && selectedNode.type !== 'end'"
            v-model="selectedNode.config.instruction"
            rows="4"
            placeholder="输入节点执行指令..."
          />

          <!-- Agent selector -->
          <label v-if="selectedNode.type === 'agent'"
>执行心智</label>
          <select v-if="selectedNode.type === 'agent'" v-model="selectedNode.config.agent_id"
>
            <option v-for="a in agents" :key="a.id" :value="a.id"
>{{ a.name }}</option>
          </select>

          <!-- Tool selector -->
          <label v-if="selectedNode.type === 'tool'"
>工具</label>
          <input
            v-if="selectedNode.type === 'tool'"
            v-model="selectedNode.config.tool_name"
            placeholder="如 search_web"
          />

          <!-- Condition expression -->
          <label v-if="selectedNode.type === 'condition'"
>判断表达式</label>
          <input
            v-if="selectedNode.type === 'condition'"
            v-model="selectedNode.config.expression"
            placeholder="如 result.success === true"
          />

          <!-- Toggles -->
          <div v-if="selectedNode.type === 'agent' || selectedNode.type === 'tool'" class="prop-row"
>
            <input type="checkbox" v-model="selectedNode.config.requires_approval" id="req-appr" />
            <label for="req-appr"
>需要审批</label>
          </div>
          <div v-if="selectedNode.type === 'agent' || selectedNode.type === 'tool'" class="prop-row"
>
            <input type="checkbox" v-model="selectedNode.config.is_critical" id="is-crit" />
            <label for="is-crit"
>关键节点</label>
          </div>

          <div v-if="selectedNode.type === 'agent' || selectedNode.type === 'tool'" class="prop-row"
>
            <label>超时（秒）</label>
            <input v-model.number="selectedNode.config.timeout_seconds" type="number" min="10" max="3600" />
          </div>
        </div>
      </aside>
    </div>
  </div>
</template>

<script setup lang="ts"
>
import { ref, computed, onMounted } from 'vue'
import { useRouter, useRoute } from 'vue-router'
import { useAgentsStore } from '@/stores/agents'
import { api } from '@/api/client'
import BackButton from '@/components/BackButton.vue'
import BlueprintCanvas from '@/components/BlueprintCanvas.vue'

const router = useRouter()
const route = useRoute()
const agentStore = useAgentsStore()
const actionId = route.params.id as string | undefined
const isCreate = ref(!actionId)
const agents = ref<any[]>([])
const selectedNodeId = ref('')

const form = ref<any>({
  name: '',
  nodes: [],
  edges: [],
})

const nodeTypes = [
  { type: 'start', label: '开始', icon: '▶', color: '#10B981' },
  { type: 'agent', label: '心智执行', icon: '◉', color: '#00E5C9' },
  { type: 'tool', label: '工具调用', icon: '🔧', color: '#3B82F6' },
  { type: 'condition', label: '条件分支', icon: '◈', color: '#F59E0B' },
  { type: 'approval', label: '审批', icon: '✓', color: '#8B5CF6' },
  { type: 'end', label: '结束', icon: '■', color: '#EF4444' },
]

const selectedNode = computed(() => {
  if (!selectedNodeId.value) return null
  return form.value.nodes.find((n: any) => n.id === selectedNodeId.value)
})

onMounted(async () => {
  await agentStore.fetchList()
  agents.value = agentStore.list
  if (actionId) {
    const json = await api.get(`/actions/${actionId}`)
    if (json.code === 0) {
      form.value.name = json.data.name
      form.value.nodes = (json.data.nodes || []).map((n: any) => ({
        id: n.id,
        type: n.type || 'agent',
        x: n.x ?? 100,
        y: n.y ?? 100,
        config: {
          agent_id: n.agent_id || '',
          instruction: n.instruction || '',
          tool_name: n.tool_name || '',
          expression: n.expression || '',
          timeout_seconds: n.timeout_seconds ?? 300,
          requires_approval: n.requires_approval || false,
          is_critical: n.is_critical || false,
        },
      }))
      form.value.edges = json.data.edges || []
    }
  } else {
    // New action: add start + end
    form.value.nodes = [
      { id: 'start_1', type: 'start', x: 100, y: 200, config: {} },
      { id: 'end_1', type: 'end', x: 500, y: 200, config: {} },
    ]
  }
})

function nodeTypeLabel(t: string) {
  const map: Record<string, string> = {
    start: '开始', agent: '心智执行', tool: '工具调用',
    condition: '条件分支', approval: '审批', end: '结束',
  }
  return map[t] || t
}

function addNode(type: string) {
  const id = `${type}_${Date.now()}`
  const x = 200 + Math.random() * 200
  const y = 100 + Math.random() * 200
  form.value.nodes.push({
    id,
    type,
    x,
    y,
    config: {
      agent_id: agents.value[0]?.id || '',
      instruction: '',
      tool_name: '',
      expression: '',
      timeout_seconds: 300,
      requires_approval: false,
      is_critical: false,
    },
  })
}

async function save() {
  const payload = {
    name: form.value.name || '未命名行动',
    nodes: form.value.nodes.map((n: any) => ({
      id: n.id,
      type: n.type,
      x: n.x,
      y: n.y,
      ...n.config,
    })),
    edges: form.value.edges,
  }
  if (isCreate.value) {
    const json = await api.post('/actions', payload)
    if (json.code === 0) router.back()
  } else {
    const json = await api.put(`/actions/${actionId}`, payload)
    if (json.code === 0) router.back()
  }
}
</script>

<style scoped>
.action-edit {
  position: fixed; inset: 0;
  background: #0B0F17;
  z-index: 900;
  display: flex;
  flex-direction: column;
  color: #D8E1EC;
}
.ae-header {
  height: 56px;
  display: flex; align-items: center; gap: 16px;
  padding: 0 20px;
  border-bottom: 1px solid rgba(255,255,255,0.06);
  flex-shrink: 0;
}
.ae-title-input {
  flex: 1;
  background: transparent;
  border: none;
  color: #D8E1EC;
  font-size: 16px;
  font-weight: 500;
  padding: 4px 0;
  outline: none;
}
.ae-title-input::placeholder { color: #5A6A7A; }
.primary-btn {
  padding: 8px 16px; background: #00E5C9; color: #0B0F17;
  border: none; border-radius: 6px; font-weight: 600; cursor: pointer;
}

.ae-body {
  flex: 1;
  display: flex;
  overflow: hidden;
}

/* Left palette */
.ae-palette {
  width: 160px;
  flex-shrink: 0;
  border-right: 1px solid rgba(255,255,255,0.06);
  background: rgba(11,15,23,0.8);
  display: flex; flex-direction: column;
}
.palette-title {
  padding: 14px 12px 8px;
  font-size: 12px; color: #5A6A7A; font-weight: 500;
  text-transform: uppercase; letter-spacing: 0.5px;
}
.palette-item {
  display: flex; align-items: center; gap: 8px;
  padding: 8px 12px;
  margin: 2px 8px;
  border-radius: 6px;
  cursor: pointer;
  transition: all 0.15s;
  border: 1px solid transparent;
}
.palette-item:hover {
  background: rgba(255,255,255,0.04);
  border-color: rgba(0,229,201,0.2);
}
.p-icon { font-size: 13px; }
.p-label { font-size: 12px; color: #D8E1EC; }

/* Center canvas */
.ae-canvas-wrap {
  flex: 1;
  position: relative;
  overflow: hidden;
}

/* Right props */
.ae-props {
  width: 260px;
  flex-shrink: 0;
  border-left: 1px solid rgba(255,255,255,0.06);
  background: rgba(11,15,23,0.95);
  display: flex; flex-direction: column;
}
.props-header {
  height: 48px;
  display: flex; align-items: center; justify-content: space-between;
  padding: 0 16px;
  border-bottom: 1px solid rgba(255,255,255,0.06);
  font-size: 13px; font-weight: 500;
}
.props-close {
  background: transparent; border: none;
  color: #5A6A7A; font-size: 18px; cursor: pointer;
}
.props-close:hover { color: #D8E1EC; }
.props-body {
  flex: 1; overflow-y: auto;
  padding: 14px 16px;
  display: flex; flex-direction: column; gap: 10px;
}
.props-body label {
  font-size: 11px; color: #8899AA;
}
.props-body input,
.props-body textarea,
.props-body select {
  width: 100%; padding: 8px;
  background: #141B24; border: 1px solid #1E2731;
  border-radius: 6px; color: #D8E1EC; font-size: 12px;
  box-sizing: border-box;
}
.props-body input:focus,
.props-body textarea:focus,
.props-body select:focus {
  outline: none; border-color: rgba(0,229,201,0.4);
}
.prop-row {
  display: flex; align-items: center; gap: 8px;
  padding: 4px 0;
}
.prop-row input[type="checkbox"] { width: auto; }
.prop-row label { margin: 0; }
</style>
