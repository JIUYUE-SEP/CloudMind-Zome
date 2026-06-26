<template>
  <div class="blueprints">
    <header class="header">
      <BackButton />
      <h1>蓝图工作流</h1>
    </header>
    <main class="main">
      <div class="controls">
        <input v-model="newName" placeholder="新蓝图名称" @keyup.enter="createBlueprint" />
        <button @click="createBlueprint">创建蓝图</button>
      </div>
      <div v-if="store.isLoading" class="empty">加载中...</div>
      <ul v-else-if="store.blueprints.length" class="blueprint-list">
        <li v-for="bp in store.blueprints" :key="bp.id" class="blueprint-item">
          <NuxtLink :to="`/blueprints/${bp.id}`" class="name">{{ bp.name }}</NuxtLink>
          <span class="meta">{{ bp.nodes.length }} 节点 · {{ bp.edges.length }} 连线</span>
          <button class="danger" @click.prevent="store.remove(bp.id)">删除</button>
        </li>
      </ul>
      <div v-else class="empty">暂无蓝图</div>
    </main>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted } from "vue";
import { useBlueprintsStore } from "@/stores/blueprints";

const store = useBlueprintsStore();
const newName = ref("");

onMounted(() => {
  store.load();
});

async function createBlueprint() {
  if (!newName.value.trim()) return;
  await store.create({ name: newName.value.trim(), nodes: [], edges: [] });
  newName.value = "";
}
</script>

<style scoped>
.blueprints {
  position: absolute;
  inset: 0;
  background: var(--mc-bg);
  color: var(--mc-text);
  padding: 24px 196px 80px 24px;
  overflow-y: auto;
}

.header {
  display: flex;
  align-items: center;
  gap: 16px;
  margin-bottom: 24px;
}

.header h1 {
  margin: 0;
  font-size: 24px;
}

.main {
  max-width: 960px;
}

.controls {
  display: flex;
  gap: 12px;
  margin-bottom: 24px;
}

.controls input {
  flex: 1;
  padding: 10px 12px;
  border-radius: 6px;
  border: 1px solid rgba(255, 255, 255, 0.12);
  background: #111827;
  color: var(--mc-text);
  font-size: 14px;
}

button {
  padding: 10px 16px;
  border-radius: 6px;
  border: none;
  background: var(--mc-accent);
  color: var(--mc-bg);
  cursor: pointer;
  font-size: 14px;
}

button.danger {
  background: #ff5c5c;
  color: white;
}

.blueprint-list {
  list-style: none;
  padding: 0;
  margin: 0;
}

.blueprint-item {
  display: flex;
  align-items: center;
  gap: 16px;
  padding: 14px;
  background: #111827;
  border-radius: 10px;
  margin-bottom: 12px;
}

.name {
  flex: 1;
  color: var(--mc-text);
  text-decoration: none;
  font-weight: 500;
}

.meta {
  color: var(--mc-text-secondary);
  font-size: 13px;
}

.empty {
  color: var(--mc-text-secondary);
  padding: 24px 0;
}
</style>
