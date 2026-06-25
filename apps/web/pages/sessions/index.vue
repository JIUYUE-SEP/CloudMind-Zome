<template>
  <div class="sessions-page">
    <header>
      <h1>群聊</h1>
      <button @click="startCreate">新建群聊</button>
    </header>
    <div v-if="showForm" class="form-panel">
      <input v-model="newSession.name" type="text" placeholder="群聊名称" />
      <select v-model="selectedAgentId">
        <option value="">选择 Agent</option>
        <option v-for="agent in agents.list" :key="agent.id" :value="agent.id">{{ agent.name }}</option>
      </select>
      <button @click="addAgent">添加</button>
      <div class="selected-agents">
        <span v-for="id in newSession.agentIds" :key="id" class="chip">
          {{ agentName(id) }}
          <button @click="removeAgent(id)">×</button>
        </span>
      </div>
      <div class="actions">
        <button @click="createSession">创建</button>
        <button @click="showForm = false">取消</button>
      </div>
    </div>
    <ul class="session-list">
      <li v-for="session in sessions.sessions" :key="session.id">
        <NuxtLink :to="`/sessions/${session.id}`">
          {{ session.name }} ({{ session.agentIds.length }} 人)
        </NuxtLink>
      </li>
    </ul>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted } from "vue";
import { useSessionsStore } from "@/stores/sessions";
import { useAgentsStore } from "@/stores/agents";

const sessions = useSessionsStore();
const agents = useAgentsStore();
const showForm = ref(false);
const selectedAgentId = ref("");
const newSession = ref<{ name: string; agentIds: string[] }>({ name: "", agentIds: [] });

onMounted(() => {
  sessions.load();
  agents.load();
});

function startCreate() {
  newSession.value = { name: "", agentIds: [] };
  showForm.value = true;
}

function addAgent() {
  if (!selectedAgentId.value) return;
  if (!newSession.value.agentIds.includes(selectedAgentId.value)) {
    newSession.value.agentIds.push(selectedAgentId.value);
  }
  selectedAgentId.value = "";
}

function removeAgent(id: string) {
  newSession.value.agentIds = newSession.value.agentIds.filter((x) => x !== id);
}

async function createSession() {
  if (!newSession.value.name || newSession.value.agentIds.length === 0) return;
  await sessions.create({
    name: newSession.value.name,
    agentIds: newSession.value.agentIds,
    type: "group",
  });
  showForm.value = false;
}

function agentName(id: string): string {
  return agents.list.find((a) => a.id === id)?.name || id;
}
</script>

<style scoped>
.sessions-page {
  padding: 16px;
  max-width: 720px;
  margin: 0 auto;
}
header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 16px;
}
.form-panel {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 12px;
  border: 1px solid rgba(255, 255, 255, 0.1);
  border-radius: 8px;
  margin-bottom: 16px;
}
.form-panel input,
.form-panel select {
  padding: 8px;
  border-radius: 6px;
  border: 1px solid rgba(255, 255, 255, 0.1);
  background: rgba(255, 255, 255, 0.05);
  color: #d8e1ec;
}
.selected-agents {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.chip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 4px 8px;
  border-radius: 12px;
  background: rgba(0, 229, 201, 0.15);
  font-size: 12px;
}
.actions {
  display: flex;
  gap: 8px;
}
.session-list {
  list-style: none;
  padding: 0;
}
.session-list li {
  padding: 12px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.06);
}
.session-list a {
  color: #00e5c9;
  text-decoration: none;
}
</style>
