<template>
  <div class="hub">
    <aside class="sidebar">
      <h2>Agents</h2>
      <button @click="startCreate">新建 Agent</button>
      <ul>
        <li
          v-for="agent in agents.list"
          :key="agent.id"
          :class="{ active: agents.currentId === agent.id }"
          @click="select(agent.id)"
        >
          {{ agent.name }}
        </li>
      </ul>
      <nav class="nav-links">
        <NuxtLink to="/sessions">群聊</NuxtLink>
        <NuxtLink to="/compute">算力中枢</NuxtLink>
        <NuxtLink to="/scheduler">定时任务</NuxtLink>
        <NuxtLink to="/settings">系统设置</NuxtLink>
      </nav>
    </aside>
    <main class="main">
      <div v-if="showForm" class="form-panel">
        <AgentEditForm :agent="editingAgent" @save="onSave" @cancel="showForm = false" />
      </div>
      <ChatView v-else-if="agents.currentId" :agent-id="agents.currentId" />
      <div v-else class="empty">请选择一个 Agent</div>
    </main>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted } from "vue";
import { useAgentsStore } from "@/stores/agents";
import type { AgentConfig } from "@mindcloud/shared";

const agents = useAgentsStore();
const showForm = ref(false);
const editingAgent = ref<AgentConfig | undefined>(undefined);

onMounted(() => {
  agents.load();
});

function select(id: string) {
  showForm.value = false;
  agents.select(id);
}

function startCreate() {
  editingAgent.value = undefined;
  showForm.value = true;
}

async function onSave(agent: AgentConfig) {
  if (editingAgent.value) {
    await agents.update(agent.id, agent);
  } else {
    await agents.create(agent);
  }
  showForm.value = false;
  agents.select(agent.id);
}
</script>

<style scoped>
.hub {
  display: flex;
  height: 100vh;
  background: #0b0f17;
  color: #d8e1ec;
}
.sidebar {
  width: 240px;
  border-right: 1px solid rgba(255, 255, 255, 0.08);
  padding: 16px;
}
.sidebar ul {
  list-style: none;
  padding: 0;
  margin: 12px 0 0;
}
.sidebar li {
  padding: 10px 12px;
  border-radius: 6px;
  cursor: pointer;
}
.sidebar li.active,
.sidebar li:hover {
  background: rgba(255, 255, 255, 0.06);
}
.nav-links {
  margin-top: 24px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.nav-links a {
  color: #00e5c9;
  text-decoration: none;
  font-size: 14px;
}
.main {
  flex: 1;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
.empty {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  color: #8899aa;
}
</style>
