<template>
  <div class="blueprint-canvas" @mousemove="onMouseMove" @mouseup="onMouseUp">
    <!-- Grid background -->
    <div class="bp-grid" />

    <!-- SVG connections layer -->
    <svg class="bp-svg">
      <!-- Existing edges -->
      <g v-for="edge in edges" :key="edgeKey(edge)">
        <path
          :d="edgePath(edge)"
          class="bp-edge"
          @click="removeEdge(edge)"
        />
        <text
          v-if="edge.label"
          :x="edgeLabelPos(edge).x"
          :y="edgeLabelPos(edge).y"
          class="bp-edge-label"
        >{{ edge.label }}</text>
      </g>
      <!-- Dragging new edge -->
      <path
        v-if="draggingEdge"
        :d="dragEdgePath"
        class="bp-edge dragging"
      />
    </svg>

    <!-- Nodes -->
    <div
      v-for="node in nodes"
      :key="node.id"
      class="bp-node"
      :class="[node.type, { selected: selectedId === node.id }]"
      :style="nodeStyle(node)"
      @mousedown.stop="onNodeDown($event, node)"
      @click.stop="selectNode(node)"
    >
      <div class="bp-node-header">
        <span class="bp-node-icon">{{ typeIcon(node.type) }}</span>
        <span class="bp-node-title">{{ nodeTitle(node) }}</span>
        <button class="bp-node-del" @click.stop="removeNode(node.id)">×</button>
      </div>
      <div class="bp-node-body">
        <div v-if="node.type === 'agent'" class="bp-node-hint">{{ agentName(node.config?.agent_id) || '未指定心智' }}</div>
        <div v-else-if="node.type === 'tool'" class="bp-node-hint">{{ node.config?.tool_name || '未指定工具' }}</div>
        <div v-else-if="node.type === 'condition'" class="bp-node-hint">条件判断</div>
      </div>

      <!-- Input port -->
      <div
        v-if="hasInput(node.type)"
        class="bp-port input"
        @mouseup.stop="onPortUp(node.id, 'input')"
      />

      <!-- Output ports -->
      <div
        v-if="hasOutput(node.type)"
        class="bp-port output"
        @mousedown.stop="onPortDown($event, node.id, 'output')"
      />
      <div
        v-if="node.type === 'condition'"
        class="bp-port output yes"
        title="Yes"
        @mousedown.stop="onPortDown($event, node.id, 'output', 'yes')"
      >Y</div>
      <div
        v-if="node.type === 'condition'"
        class="bp-port output no"
        title="No"
        @mousedown.stop="onPortDown($event, node.id, 'output', 'no')"
      >N</div>
    </div>

    <!-- Empty hint -->
    <div v-if="!nodes.length" class="bp-empty">从左侧添加节点，拖拽连接端口编排流程</div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed } from 'vue'

export interface BlueprintNode {
  id: string
  type: 'start' | 'agent' | 'tool' | 'condition' | 'approval' | 'end'
  x: number
  y: number
  config?: Record<string, any>
}

export interface BlueprintEdge {
  source: string
  target: string
  label?: string
}

const props = defineProps<{
  nodes: BlueprintNode[]
  edges: BlueprintEdge[]
  agents: { id: string; name: string }[]
}>()

const emit = defineEmits<{
  (e: 'update:nodes', v: BlueprintNode[]): void
  (e: 'update:edges', v: BlueprintEdge[]): void
  (e: 'select', id: string): void
}>()

const selectedId = ref('')
const draggingNode = ref<{ id: string; ox: number; oy: number } | null>(null)
const draggingEdge = ref<{ source: string; sx: number; sy: number; mx: number; my: number; label?: string } | null>(null)

const GRID = 20

function snap(n: number) {
  return Math.round(n / GRID) * GRID
}

function nodeStyle(n: BlueprintNode) {
  return {
    left: `${n.x}px`,
    top: `${n.y}px`,
  }
}

function nodeTitle(n: BlueprintNode) {
  const titles: Record<string, string> = {
    start: '开始', agent: '心智执行', tool: '工具调用',
    condition: '条件分支', approval: '审批', end: '结束',
  }
  return titles[n.type] || n.type
}

function typeIcon(t: string) {
  const icons: Record<string, string> = {
    start: '▶', agent: '◉', tool: '🔧', condition: '◈', approval: '✓', end: '■',
  }
  return icons[t] || '●'
}

function agentName(id?: string) {
  if (!id) return ''
  return props.agents.find(a => a.id === id)?.name || ''
}

function hasInput(t: string) {
  return t !== 'start'
}

function hasOutput(t: string) {
  return t !== 'end'
}

function selectNode(n: BlueprintNode) {
  selectedId.value = n.id
  emit('select', n.id)
}

function onNodeDown(e: MouseEvent, n: BlueprintNode) {
  if ((e.target as HTMLElement).classList.contains('bp-port')) return
  draggingNode.value = { id: n.id, ox: e.clientX - n.x, oy: e.clientY - n.y }
}

function onMouseMove(e: MouseEvent) {
  if (draggingNode.value) {
    const list = props.nodes.map(n => {
      if (n.id === draggingNode.value!.id) {
        return { ...n, x: snap(e.clientX - draggingNode.value!.ox), y: snap(e.clientY - draggingNode.value!.oy) }
      }
      return n
    })
    emit('update:nodes', list)
  }
  if (draggingEdge.value) {
    draggingEdge.value.mx = e.clientX
    draggingEdge.value.my = e.clientY
  }
}

function onMouseUp() {
  draggingNode.value = null
  draggingEdge.value = null
}

function onPortDown(e: MouseEvent, nodeId: string, _type: string, label?: string) {
  const node = props.nodes.find(n => n.id === nodeId)
  if (!node) return
  draggingEdge.value = {
    source: nodeId,
    sx: node.x + 140,
    sy: node.y + (label === 'no' ? 70 : label === 'yes' ? 50 : 40),
    mx: e.clientX,
    my: e.clientY,
    label,
  }
}

function onPortUp(targetId: string, _type: string) {
  if (!draggingEdge.value) return
  const sourceId = draggingEdge.value.source
  if (sourceId === targetId) {
    draggingEdge.value = null
    return
  }
  // Avoid duplicate
  const exists = props.edges.some(
    e => e.source === sourceId && e.target === targetId && e.label === draggingEdge.value?.label
  )
  if (!exists) {
    const newEdge: BlueprintEdge = {
      source: sourceId,
      target: targetId,
      label: draggingEdge.value.label,
    }
    emit('update:edges', [...props.edges, newEdge])
  }
  draggingEdge.value = null
}

function removeNode(id: string) {
  emit('update:nodes', props.nodes.filter(n => n.id !== id))
  emit('update:edges', props.edges.filter(e => e.source !== id && e.target !== id))
  if (selectedId.value === id) {
    selectedId.value = ''
    emit('select', '')
  }
}

function removeEdge(edge: BlueprintEdge) {
  emit('update:edges', props.edges.filter(
    e => !(e.source === edge.source && e.target === edge.target && e.label === edge.label)
  ))
}

function edgeKey(e: BlueprintEdge) {
  return `${e.source}-${e.target}-${e.label || ''}`
}

function getNodePos(id: string, isSource: boolean, label?: string) {
  const n = props.nodes.find(x => x.id === id)
  if (!n) return { x: 0, y: 0 }
  if (isSource) {
    return { x: n.x + 140, y: n.y + (label === 'no' ? 70 : label === 'yes' ? 50 : 40) }
  }
  return { x: n.x, y: n.y + 40 }
}

function edgePath(edge: BlueprintEdge) {
  const s = getNodePos(edge.source, true, edge.label)
  const t = getNodePos(edge.target, false)
  const dx = Math.abs(t.x - s.x)
  const c1x = s.x + dx * 0.5
  const c2x = t.x - dx * 0.5
  return `M ${s.x} ${s.y} C ${c1x} ${s.y}, ${c2x} ${t.y}, ${t.x} ${t.y}`
}

function edgeLabelPos(edge: BlueprintEdge) {
  const s = getNodePos(edge.source, true, edge.label)
  const t = getNodePos(edge.target, false)
  return { x: (s.x + t.x) / 2, y: (s.y + t.y) / 2 - 4 }
}

const dragEdgePath = computed(() => {
  const d = draggingEdge.value
  if (!d) return ''
  const dx = Math.abs(d.mx - d.sx)
  const c1x = d.sx + dx * 0.5
  const c2x = d.mx - dx * 0.5
  return `M ${d.sx} ${d.sy} C ${c1x} ${d.sy}, ${c2x} ${d.my}, ${d.mx} ${d.my}`
})
</script>

<style scoped>
.blueprint-canvas {
  position: relative;
  width: 100%;
  height: 100%;
  overflow: hidden;
  background: #0B0F17;
  cursor: grab;
}
.blueprint-canvas:active {
  cursor: grabbing;
}

.bp-grid {
  position: absolute;
  inset: 0;
  background-image:
    radial-gradient(circle, rgba(255,255,255,0.04) 1px, transparent 1px);
  background-size: 20px 20px;
  pointer-events: none;
}

.bp-svg {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  pointer-events: none;
  z-index: 1;
}
.bp-svg .bp-edge {
  fill: none;
  stroke: rgba(0, 229, 201, 0.4);
  stroke-width: 2;
  pointer-events: stroke;
  cursor: pointer;
}
.bp-svg .bp-edge:hover {
  stroke: #EF4444;
}
.bp-svg .bp-edge.dragging {
  stroke: rgba(0, 229, 201, 0.7);
  stroke-dasharray: 6 4;
}
.bp-edge-label {
  font-size: 10px;
  fill: #5A6A7A;
  text-anchor: middle;
  pointer-events: none;
}

.bp-node {
  position: absolute;
  width: 140px;
  background: rgba(20, 27, 36, 0.95);
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: 8px;
  z-index: 10;
  cursor: grab;
  user-select: none;
  transition: box-shadow 0.15s, border-color 0.15s;
}
.bp-node:hover {
  border-color: rgba(0, 229, 201, 0.3);
}
.bp-node.selected {
  border-color: #00E5C9;
  box-shadow: 0 0 0 2px rgba(0, 229, 201, 0.15);
}
.bp-node.start { border-left: 3px solid #10B981; }
.bp-node.agent { border-left: 3px solid #00E5C9; }
.bp-node.tool { border-left: 3px solid #3B82F6; }
.bp-node.condition { border-left: 3px solid #F59E0B; }
.bp-node.approval { border-left: 3px solid #8B5CF6; }
.bp-node.end { border-left: 3px solid #EF4444; }

.bp-node-header {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 8px 10px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.04);
}
.bp-node-icon {
  font-size: 12px;
  color: #00E5C9;
}
.bp-node-title {
  flex: 1;
  font-size: 12px;
  color: #D8E1EC;
  font-weight: 500;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.bp-node-del {
  background: transparent;
  border: none;
  color: #5A6A7A;
  font-size: 14px;
  cursor: pointer;
  padding: 0 2px;
}
.bp-node-del:hover {
  color: #EF4444;
}
.bp-node-body {
  padding: 8px 10px;
}
.bp-node-hint {
  font-size: 11px;
  color: #5A6A7A;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.bp-port {
  position: absolute;
  width: 10px;
  height: 10px;
  border-radius: 50%;
  background: #1E2731;
  border: 1px solid rgba(255, 255, 255, 0.15);
  cursor: crosshair;
  z-index: 20;
  pointer-events: all;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 7px;
  color: #5A6A7A;
}
.bp-port:hover {
  background: #00E5C9;
  border-color: #00E5C9;
}
.bp-port.input {
  left: -5px;
  top: 50%;
  transform: translateY(-50%);
}
.bp-port.output {
  right: -5px;
  top: 50%;
  transform: translateY(-50%);
}
.bp-port.output.yes {
  right: -5px;
  top: 36px;
  background: rgba(16, 185, 129, 0.2);
  border-color: #10B981;
  color: #10B981;
}
.bp-port.output.no {
  right: -5px;
  top: 56px;
  background: rgba(239, 68, 68, 0.2);
  border-color: #EF4444;
  color: #EF4444;
}

.bp-empty {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  color: #5A6A7A;
  font-size: 14px;
  pointer-events: none;
}
</style>
