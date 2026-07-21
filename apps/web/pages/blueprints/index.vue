<template>
  <div class="blueprints">
    <header class="header">
      <BackButton to="/" />
      <h1>蓝图工作流</h1>
    </header>
    <main class="main">
      <div class="controls">
        <input v-model="newName" placeholder="新蓝图名称" @keyup.enter="createBlueprint" />
        <button :disabled="creating" @click="createBlueprint">{{ creating ? "创建中..." : "创建蓝图" }}</button>
      </div>
      <div v-if="opError" class="op-error">{{ opError }}</div>
      <div v-if="store.isLoading" class="empty">加载中...</div>
      <div v-else-if="store.error" class="op-error">加载失败：{{ store.error }}</div>
      <ul v-else-if="store.blueprints.length" class="blueprint-list">
        <li v-for="bp in store.blueprints" :key="bp.id" class="blueprint-item">
          <NuxtLink :to="`/blueprints/${bp.id}`" class="name">{{ bp.name }}</NuxtLink>
          <span class="meta">{{ bp.nodes.length }} 节点 · {{ bp.edges.length }} 连线</span>
          <button class="danger" @click.prevent="removeBlueprint(bp.id)">删除</button>
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
const creating = ref(false);
const opError = ref("");

onMounted(() => {
  store.load();
});

async function createBlueprint() {
  const name = newName.value.trim();
  if (!name || creating.value) return;
  creating.value = true;
  opError.value = "";
  try {
    const created = await store.create({ name, nodes: [], edges: [] });
    newName.value = "";
    navigateTo(`/blueprints/${created.id}`);
  } catch (err) {
    opError.value = err instanceof Error ? err.message : "创建失败";
  } finally {
    creating.value = false;
  }
}

async function removeBlueprint(id: string) {
  if (!confirm("确定删除这个蓝图吗？")) return;
  opError.value = "";
  try {
    await store.remove(id);
  } catch (err) {
    opError.value = err instanceof Error ? err.message : "删除失败";
  }
}
</script>

<style scoped>
.blueprints {
  position: absolute;
  inset: 0;
  background: var(--mc-bg);
  color: var(--mc-text);
  padding: 24px 24px 80px;
  overflow-y: auto;
}

.op-error {
  color: var(--mc-danger);
  font-size: 13px;
  margin-bottom: 12px;
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
