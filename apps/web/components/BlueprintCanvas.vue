<template>
  <div class="canvas-wrapper">
    <div class="toolbar">
      <button @click="addNode('start')">+ Start</button>
      <button @click="addNode('llm')">+ LLM</button>
      <button @click="addNode('tool')">+ Tool</button>
      <button @click="addNode('end')">+ End</button>
      <button class="secondary" @click="emit('execute')">执行</button>
      <button class="secondary" @click="emit('save')">保存</button>
    </div>
    <div
      ref="canvasRef"
      class="canvas"
      tabindex="0"
      @keydown.delete="deleteSelected"
      @click="onCanvasClick"
    >
      <svg class="edges">
        <line
          v-for="edge in edges"
          :key="`${edge.source}-${edge.target}`"
          :x1="portX(edge.source, 'out')"
          :y1="portY(edge.source)"
          :x2="portX(edge.target, 'in')"
          :y2="portY(edge.target)"
          stroke="var(--mc-accent)"
          stroke-width="2"
        />
        <line
          v-if="draggingEdge"
          :x1="draggingEdge.x1"
          :y1="draggingEdge.y1"
          :x2="draggingEdge.x2"
          :y2="draggingEdge.y2"
          stroke="var(--mc-accent)"
          stroke-width="2"
          stroke-dasharray="4"
        />
      </svg>
      <div
        v-for="node in nodes"
        :key="node.id"
        class="node"
        :class="[node.type, { selected: selectedNodeId === node.id }]"
        :style="{ left: `${node.x}px`, top: `${node.y}px` }"
        @mousedown="startDrag($event, node)"
        @click.stop="selectNode(node)"
      >
        <div class="port in" data-in-port @mousedown.stop @click.stop="onInPortClick(node)"></div>
        <div class="node-label">{{ nodeLabel(node) }}</div>
        <div class="port out" @mousedown.stop @click.stop="onOutPortClick(node)"></div>
      </div>
    </div>
    <div v-if="selectedNode" class="config-panel">
      <h3>{{ nodeLabel(selectedNode) }} 配置</h3>
      <label>
        类型
        <select v-model="selectedNode.type">
          <option value="start">start</option>
          <option value="llm">llm</option>
          <option value="tool">tool</option>
          <option value="end">end</option>
        </select>
      </label>
      <label>
        名称
        <input v-model="configName" />
      </label>
      <template v-if="selectedNode.type === 'llm'">
        <label>
          Agent ID
          <input v-model="llmAgentId" />
        </label>
        <label>
          Prompt
          <textarea v-model="llmPrompt" rows="3"></textarea>
        </label>
      </template>
      <template v-if="selectedNode.type === 'tool'">
        <label>
          工具名
          <input v-model="toolName" />
        </label>
        <label>
          参数 (JSON)
          <textarea v-model="toolArgs" rows="3"></textarea>
        </label>
        <div v-if="argsError" class="args-error">{{ argsError }}</div>
      </template>
      <button @click="applyConfig">应用</button>
      <button class="danger" @click="deleteSelected">删除节点</button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, nextTick, onBeforeUnmount } from "vue";
import type { BlueprintNode, BlueprintEdge } from "@/composables/useEngineClient";

const props = defineProps<{
  nodes: BlueprintNode[];
  edges: BlueprintEdge[];
}>();

const emit = defineEmits<{
  (e: "update", nodes: BlueprintNode[], edges: BlueprintEdge[]): void;
  (e: "save"): void;
  (e: "execute"): void;
}>();

const NODE_WIDTH = 120;
const NODE_HEIGHT = 48;

const canvasRef = ref<HTMLElement | null>(null);
const selectedNodeId = ref<string | null>(null);
const dragState = ref<{ nodeId: string; offsetX: number; offsetY: number } | null>(null);
const edgeState = ref<{ sourceId: string; x1: number; y1: number } | null>(null);
const mousePos = ref({ x: 0, y: 0 });

const nodes = computed(() => props.nodes);
const edges = computed(() => props.edges);
const selectedNode = computed(() => nodes.value.find((n) => n.id === selectedNodeId.value));

const draggingEdge = computed(() => {
  if (!edgeState.value) return null;
  return {
    x1: edgeState.value.x1,
    y1: edgeState.value.y1,
    x2: mousePos.value.x,
    y2: mousePos.value.y,
  };
});

const configName = ref("");
const llmAgentId = ref("");
const llmPrompt = ref("");
const toolName = ref("");
const toolArgs = ref("{}");
const argsError = ref("");

function nodeLabel(node: BlueprintNode): string {
  const name = node.config?.name as string | undefined;
  return name || node.type.toUpperCase();
}

function selectNode(node: BlueprintNode) {
  selectedNodeId.value = node.id;
  configName.value = (node.config?.name as string) || "";
  llmAgentId.value = (node.config?.agentId as string) || "";
  llmPrompt.value = (node.config?.prompt as string) || "";
  toolName.value = (node.config?.toolName as string) || "";
  toolArgs.value = JSON.stringify((node.config?.arguments as Record<string, unknown>) || {}, null, 2);
}

function applyConfig() {
  if (!selectedNode.value) return;
  const config: Record<string, unknown> = {
    name: configName.value,
  };
  if (selectedNode.value.type === "llm") {
    config.agentId = llmAgentId.value;
    config.prompt = llmPrompt.value;
  }
  if (selectedNode.value.type === "tool") {
    config.toolName = toolName.value;
    try {
      config.arguments = JSON.parse(toolArgs.value);
      argsError.value = "";
    } catch {
      // 不静默置 {}：保留节点既有配置，提示用户修正后重试
      argsError.value = "参数 JSON 格式错误，本次修改未应用";
      return;
    }
  }
  selectedNode.value.config = config;
  emit("update", [...nodes.value], [...edges.value]);
}

function addNode(type: BlueprintNode["type"]) {
  const id = `node-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
  const rect = canvasRef.value?.getBoundingClientRect();
  const x = (rect?.width || 400) / 2 - NODE_WIDTH / 2 + Math.floor(Math.random() * 40 - 20);
  const y = (rect?.height || 300) / 2 - NODE_HEIGHT / 2 + Math.floor(Math.random() * 40 - 20);
  const newNodes = [...nodes.value, { id, type, x, y, config: {} }];
  emit("update", newNodes, [...edges.value]);
  nextTick(() => selectNode(newNodes[newNodes.length - 1]));
}

function deleteSelected() {
  if (!selectedNodeId.value) return;
  const id = selectedNodeId.value;
  const newNodes = nodes.value.filter((n) => n.id !== id);
  const newEdges = edges.value.filter((e) => e.source !== id && e.target !== id);
  selectedNodeId.value = null;
  emit("update", newNodes, newEdges);
}

function startDrag(event: MouseEvent, node: BlueprintNode) {
  event.preventDefault();
  selectedNodeId.value = node.id;
  dragState.value = {
    nodeId: node.id,
    offsetX: event.clientX - node.x,
    offsetY: event.clientY - node.y,
  };
  document.addEventListener("mousemove", onDragMove);
  document.addEventListener("mouseup", onDragEnd);
}

function onDragMove(event: MouseEvent) {
  if (!dragState.value) return;
  const node = nodes.value.find((n) => n.id === dragState.value!.nodeId);
  if (!node) return;
  node.x = event.clientX - dragState.value.offsetX;
  node.y = event.clientY - dragState.value.offsetY;
  emit("update", [...nodes.value], [...edges.value]);
}

function onDragEnd() {
  dragState.value = null;
  document.removeEventListener("mousemove", onDragMove);
  document.removeEventListener("mouseup", onDragEnd);
}

function onOutPortClick(node: BlueprintNode) {
  // 坐标统一用画布相对坐标（与静态边 portX/portY 一致），不混视口坐标
  edgeState.value = {
    sourceId: node.id,
    x1: node.x + NODE_WIDTH,
    y1: node.y + NODE_HEIGHT / 2,
  };
  document.addEventListener("mousemove", onEdgeMove);
  document.addEventListener("mouseup", onEdgeEnd);
}

function onInPortClick(node: BlueprintNode) {
  if (!edgeState.value) return;
  const sourceId = edgeState.value.sourceId;
  if (sourceId === node.id) {
    cancelEdge();
    return;
  }
  const exists = edges.value.find((e) => e.source === sourceId);
  if (exists) {
    cancelEdge();
    return;
  }
  const newEdges = [...edges.value, { source: sourceId, target: node.id }];
  cancelEdge();
  emit("update", [...nodes.value], newEdges);
}

function onEdgeMove(event: MouseEvent) {
  const rect = canvasRef.value?.getBoundingClientRect();
  if (!rect) return;
  mousePos.value = { x: event.clientX - rect.left, y: event.clientY - rect.top };
}

function onEdgeEnd(event: MouseEvent) {
  // 落在目标 in-port 上的 mouseup 不能取消连线：
  // DOM 事件序为 mouseup → click，此处先清掉 edgeState 会让随后的 onInPortClick 永远落空
  if ((event.target as HTMLElement | null)?.closest("[data-in-port]")) return;
  cancelEdge();
}

function cancelEdge() {
  edgeState.value = null;
  document.removeEventListener("mousemove", onEdgeMove);
  document.removeEventListener("mouseup", onEdgeEnd);
}

// 拖拽/连线中途组件被卸载（切路由）时，兜底移除 document 级监听
onBeforeUnmount(() => {
  document.removeEventListener("mousemove", onDragMove);
  document.removeEventListener("mouseup", onDragEnd);
  cancelEdge();
});

function onCanvasClick() {
  selectedNodeId.value = null;
}

function portX(nodeId: string, side: "in" | "out"): number {
  const node = nodes.value.find((n) => n.id === nodeId);
  if (!node) return 0;
  return side === "in" ? node.x : node.x + NODE_WIDTH;
}

function portY(nodeId: string): number {
  const node = nodes.value.find((n) => n.id === nodeId);
  if (!node) return 0;
  return node.y + NODE_HEIGHT / 2;
}
</script>

<style scoped>
.canvas-wrapper {
  display: flex;
  flex-direction: column;
  height: 100%;
  background: var(--mc-bg);
  color: var(--mc-text);
}
.toolbar {
  display: flex;
  gap: 8px;
  padding: 12px 16px;
  border-bottom: 1px solid var(--mc-border);
}
.toolbar button {
  padding: 8px 14px;
  border-radius: 6px;
  border: none;
  background: var(--mc-accent);
  color: var(--mc-bg);
  cursor: pointer;
  font-size: 13px;
}
.toolbar button.secondary {
  background: #1f2937;
  color: var(--mc-text);
  margin-left: auto;
}
.canvas {
  position: relative;
  flex: 1;
  overflow: hidden;
  outline: none;
}
.edges {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  pointer-events: none;
}
.node {
  position: absolute;
  width: 120px;
  height: 48px;
  background: #1f2937;
  border: 2px solid #374151;
  border-radius: 8px;
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: grab;
  user-select: none;
}
.node.selected {
  border-color: var(--mc-accent);
}
.node.start {
  background: #064e3b;
  border-color: var(--mc-success);
}
.node.end {
  background: #7f1d1d;
  border-color: var(--mc-danger);
}
.node.llm {
  background: #1e3a8a;
  border-color: #3b82f6;
}
.node.tool {
  background: #713f12;
  border-color: #eab308;
}
.node-label {
  font-size: 12px;
  font-weight: 600;
  pointer-events: none;
}
.port {
  position: absolute;
  width: 10px;
  height: 10px;
  border-radius: 50%;
  background: var(--mc-text);
  cursor: crosshair;
}
.port.in {
  left: -6px;
}
.port.out {
  right: -6px;
}
.config-panel {
  position: absolute;
  right: 16px;
  top: 72px;
  width: 260px;
  background: #111827;
  border: 1px solid rgba(255, 255, 255, 0.1);
  border-radius: 10px;
  padding: 16px;
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.config-panel h3 {
  margin: 0 0 4px;
  font-size: 15px;
}
.config-panel label {
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: 13px;
}
.config-panel input,
.config-panel select,
.config-panel textarea {
  padding: 8px;
  border-radius: 6px;
  border: 1px solid rgba(255, 255, 255, 0.12);
  background: var(--mc-bg);
  color: var(--mc-text);
  font-size: 13px;
}
.config-panel button {
  padding: 8px;
  border-radius: 6px;
  border: none;
  background: var(--mc-accent);
  color: var(--mc-bg);
  cursor: pointer;
  font-size: 13px;
}
.config-panel button.danger {
  background: var(--mc-danger);
  color: white;
}

.args-error {
  font-size: 12px;
  color: var(--mc-danger);
  margin-top: 6px;
}
</style>
