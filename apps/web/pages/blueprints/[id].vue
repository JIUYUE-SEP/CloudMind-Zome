<template>
  <div class="blueprint-page">
    <header class="header">
      <NuxtLink to="/blueprints" class="back">← 蓝图列表</NuxtLink>
      <input v-model="name" class="title-input" @change="save" />
      <button class="secondary" @click="save">保存</button>
    </header>
    <BlueprintCanvas
      :nodes="nodes"
      :edges="edges"
      @update="onUpdate"
      @save="save"
      @execute="execute"
    />
    <div class="execution-panel">
      <h3>执行</h3>
      <textarea v-model="initialInput" rows="2" placeholder="初始输入"></textarea>
      <button :disabled="running" @click="execute">{{ running ? "执行中..." : "执行" }}</button>
      <div v-if="result" class="result">
        <div class="status" :class="result.status">状态: {{ result.status }}</div>
        <pre>{{ resultText }}</pre>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted } from "vue";
import { useRoute } from "vue-router";
import { useBlueprintsStore } from "@/stores/blueprints";
import { useEngineClient } from "@/composables/useEngineClient";
import type { Blueprint, BlueprintNode, BlueprintEdge, BlueprintExecution } from "@/composables/useEngineClient";

const route = useRoute();
const store = useBlueprintsStore();
const client = useEngineClient();

const blueprint = ref<Blueprint | null>(null);
const name = ref("");
const nodes = ref<BlueprintNode[]>([]);
const edges = ref<BlueprintEdge[]>([]);
const initialInput = ref("");
const result = ref<BlueprintExecution | null>(null);
const running = ref(false);

const resultText = computed(() => {
  if (!result.value) return "";
  return [
    `logs:`,
    ...result.value.logs,
    ``,
    `outputs:`,
    JSON.stringify(result.value.outputs, null, 2),
  ].join("\n");
});

onMounted(async () => {
  const id = route.params.id as string;
  blueprint.value = await client.getBlueprint(id);
  name.value = blueprint.value.name;
  nodes.value = blueprint.value.nodes;
  edges.value = blueprint.value.edges;
});

function onUpdate(newNodes: BlueprintNode[], newEdges: BlueprintEdge[]) {
  nodes.value = newNodes;
  edges.value = newEdges;
}

async function save() {
  if (!blueprint.value) return;
  await store.update(blueprint.value.id, {
    name: name.value,
    nodes: nodes.value,
    edges: edges.value,
  });
}

async function execute() {
  if (!blueprint.value || running.value) return;
  running.value = true;
  try {
    result.value = await store.execute(blueprint.value.id, initialInput.value);
  } finally {
    running.value = false;
  }
}
</script>

<style scoped>
.blueprint-page {
  display: flex;
  flex-direction: column;
  height: 100vh;
  background: #0b0f17;
  color: #d8e1ec;
}
.header {
  display: flex;
  align-items: center;
  gap: 16px;
  padding: 12px 16px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.08);
}
.back {
  color: #00e5c9;
  text-decoration: none;
}
.title-input {
  flex: 1;
  padding: 8px 12px;
  border-radius: 6px;
  border: 1px solid rgba(255, 255, 255, 0.12);
  background: #111827;
  color: #d8e1ec;
  font-size: 16px;
}
button {
  padding: 8px 16px;
  border-radius: 6px;
  border: none;
  background: #00e5c9;
  color: #0b0f17;
  cursor: pointer;
  font-size: 14px;
}
button.secondary {
  background: #1f2937;
  color: #d8e1ec;
}
button:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}
.execution-panel {
  position: fixed;
  right: 16px;
  bottom: 16px;
  width: 320px;
  max-height: 40vh;
  overflow: auto;
  background: #111827;
  border: 1px solid rgba(255, 255, 255, 0.1);
  border-radius: 10px;
  padding: 16px;
}
.execution-panel h3 {
  margin: 0 0 12px;
  font-size: 15px;
}
.execution-panel textarea {
  width: 100%;
  padding: 8px;
  border-radius: 6px;
  border: 1px solid rgba(255, 255, 255, 0.12);
  background: #0b0f17;
  color: #d8e1ec;
  font-size: 13px;
  margin-bottom: 8px;
  box-sizing: border-box;
}
.result {
  margin-top: 12px;
}
.status {
  font-size: 13px;
  margin-bottom: 6px;
}
.status.completed {
  color: #10b981;
}
.status.failed {
  color: #ef4444;
}
pre {
  background: #0b0f17;
  padding: 10px;
  border-radius: 6px;
  font-size: 12px;
  overflow: auto;
  white-space: pre-wrap;
  word-break: break-word;
}
</style>
