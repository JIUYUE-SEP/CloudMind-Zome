<template>
  <div class="sessions-page">
    <header>
      <BackButton to="/" />
      <h1>群聊</h1>
      <button @click="startCreate">新建群聊</button>
    </header>
    <div v-if="showForm" class="form-panel">
      <input v-model="newSession.name" type="text" placeholder="群聊名称" />
      <select v-model="selectedAgentId">
        <option value="">选择 Agent</option>
        <option v-for="agent in agents.list" :key="agent.id" :value="agent.id">{{ agent.name || agent.id }}</option>
      </select>
      <button @click="addAgent">添加</button>
      <div class="selected-agents">
        <span v-for="id in newSession.agentIds" :key="id" class="chip">
          {{ agentName(id) }}
          <button @click="removeAgent(id)">×</button>
        </span>
      </div>
      <div class="actions">
        <button :disabled="creating" @click="createSession">{{ creating ? "创建中..." : "创建" }}</button>
        <button @click="showForm = false">取消</button>
      </div>
      <div v-if="formError" class="form-error">{{ formError }}</div>
    </div>
    <div v-if="sessions.error" class="load-error">加载失败：{{ sessions.error }}</div>
    <div v-else-if="sessions.isLoading && !groupSessions.length" class="load-empty">加载中...</div>
    <div v-else-if="!groupSessions.length" class="load-empty">暂无群聊</div>
    <div v-if="actionError" class="load-error">{{ actionError }}</div>
    <ul class="session-list">
      <li v-for="session in groupSessions" :key="session.id">
        <template v-if="editingId === session.id">
          <input
            v-model="editingName"
            type="text"
            class="rename-input"
            @keyup.enter="confirmRename"
            @keyup.esc="editingId = ''"
          />
          <button :disabled="renaming" @click="confirmRename">{{ renaming ? "保存中..." : "保存" }}</button>
          <button class="ghost" @click="editingId = ''">取消</button>
        </template>
        <template v-else>
          <NuxtLink :to="`/sessions/${session.id}`" class="name">
            {{ session.name }} ({{ session.agentIds.length }} 人)
          </NuxtLink>
          <div class="row-actions">
            <button class="ghost" @click="startRename(session)">重命名</button>
            <button class="danger" :disabled="deletingId === session.id" @click="removeSession(session)">
              {{ deletingId === session.id ? "删除中..." : "删除" }}
            </button>
          </div>
        </template>
      </li>
    </ul>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted } from "vue";
import { useSessionsStore } from "@/stores/sessions";
import { useAgentsStore } from "@/stores/agents";
import type { Session } from "@/composables/useEngineClient";

const sessions = useSessionsStore();
const agents = useAgentsStore();
const showForm = ref(false);
const selectedAgentId = ref("");
const creating = ref(false);
const formError = ref("");
const newSession = ref<{ name: string; agentIds: string[] }>({ name: "", agentIds: [] });
// 行内重命名 / 删除的交互态（actionError 两种操作共用，谁发起谁覆盖）
const editingId = ref("");
const editingName = ref("");
const renaming = ref(false);
const deletingId = ref("");
const actionError = ref("");

// 本页只展示群聊（与 hub 的口径一致），intermind 等其他类型不混入
const groupSessions = computed(() => sessions.sessions.filter((s) => s.type === "group"));

onMounted(() => {
  sessions.load();
  agents.load();
});

function startCreate() {
  newSession.value = { name: "", agentIds: [] };
  formError.value = "";
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
  const name = newSession.value.name.trim();
  if (!name || newSession.value.agentIds.length === 0) {
    formError.value = "请填写群聊名称并至少添加一个 Agent";
    return;
  }
  creating.value = true;
  formError.value = "";
  try {
    const created = await sessions.create({
      name,
      agentIds: newSession.value.agentIds,
      type: "group",
    });
    showForm.value = false;
    navigateTo(`/sessions/${created.id}`);
  } catch (err) {
    formError.value = err instanceof Error ? err.message : "创建失败";
  } finally {
    creating.value = false;
  }
}

function agentName(id: string): string {
  const agent = agents.list.find((a) => a.id === id);
  return agent?.name || id;
}

function startRename(session: Session) {
  editingId.value = session.id;
  editingName.value = session.name;
  actionError.value = "";
}

async function confirmRename() {
  const id = editingId.value;
  const name = editingName.value.trim();
  if (!id || renaming.value) return;
  if (!name) {
    actionError.value = "群聊名称不能为空";
    return;
  }
  // 名称未变直接退出编辑态，不发 PUT
  const current = sessions.sessions.find((s) => s.id === id);
  if (current && current.name === name) {
    editingId.value = "";
    return;
  }
  renaming.value = true;
  actionError.value = "";
  try {
    await sessions.rename(id, name);
    editingId.value = "";
  } catch (err) {
    // 404 等失败透出 err.message（ensureOk 已带 engine 的 error 正文），保持编辑态可改可退
    actionError.value = err instanceof Error ? err.message : "重命名失败";
  } finally {
    renaming.value = false;
  }
}

async function removeSession(session: Session) {
  if (!confirm(`确定删除群聊「${session.name}」吗？`)) return;
  deletingId.value = session.id;
  actionError.value = "";
  try {
    await sessions.remove(session.id);
    // 删掉的正是重命名中的行：退出编辑态
    if (editingId.value === session.id) editingId.value = "";
  } catch (err) {
    actionError.value = err instanceof Error ? err.message : "删除失败";
  } finally {
    deletingId.value = "";
  }
}
</script>

<style scoped>
.sessions-page {
  position: absolute;
  inset: 0;
  padding: 24px 24px 80px;
  color: var(--mc-text);
  background: var(--mc-bg);
  overflow-y: auto;
}

.form-error,
.load-error {
  color: var(--mc-danger);
  font-size: 13px;
}

.load-empty {
  color: var(--mc-text-tertiary);
  font-size: 13px;
  padding: 24px 0;
}

header {
  display: flex;
  align-items: center;
  gap: 16px;
  margin-bottom: 16px;
}

header h1 {
  flex: 1;
  margin: 0;
  font-size: 24px;
}

.form-panel {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 12px;
  border: 1px solid rgba(255, 255, 255, 0.1);
  border-radius: 8px;
  margin-bottom: 16px;
  max-width: 720px;
}

.form-panel input,
.form-panel select {
  padding: 8px;
  border-radius: 6px;
  border: 1px solid rgba(255, 255, 255, 0.1);
  background: rgba(255, 255, 255, 0.05);
  color: var(--mc-text);
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
  max-width: 720px;
}

.session-list li {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 12px;
  border-bottom: 1px solid var(--mc-panel);
}

.session-list a {
  color: var(--mc-accent);
  text-decoration: none;
}

.session-list .name {
  flex: 1;
}

.row-actions {
  display: flex;
  gap: 8px;
}

.row-actions button {
  padding: 4px 10px;
  font-size: 12px;
}

button.ghost {
  background: transparent;
  border: 1px solid rgba(255, 255, 255, 0.1);
  color: var(--mc-text-secondary);
}

button.danger {
  background: var(--mc-danger);
  color: #fff;
}

button:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.rename-input {
  flex: 1;
  padding: 8px;
  border-radius: 6px;
  border: 1px solid rgba(255, 255, 255, 0.1);
  background: rgba(255, 255, 255, 0.05);
  color: var(--mc-text);
}

button {
  padding: 8px 16px;
  border-radius: 6px;
  border: none;
  background: var(--mc-accent);
  color: var(--mc-bg);
  cursor: pointer;
  font-size: 14px;
}
</style>
