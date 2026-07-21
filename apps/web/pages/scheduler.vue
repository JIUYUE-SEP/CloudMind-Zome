<template>
  <div class="scheduler">
    <header class="header">
      <BackButton to="/" />
      <h1>定时任务</h1>
    </header>
    <main class="main">
      <div class="controls">
        <label>
          Agent
          <select v-model="selectedAgentId" @change="onSelectAgent">
            <option value="">请选择 Agent</option>
            <option v-for="agent in agents.list" :key="agent.id" :value="agent.id">
              {{ agent.name || agent.id }}
            </option>
          </select>
        </label>
      </div>

      <section v-if="selectedAgentId" class="panel">
        <h2>任务列表</h2>
        <div v-if="scheduler.error" class="op-error">加载失败：{{ scheduler.error }}</div>
        <div v-else-if="scheduler.tasks.length === 0" class="empty">暂无定时任务</div>
        <ul class="task-list">
          <li v-for="task in scheduler.tasks" :key="task.id" class="task-item">
            <div class="task-info">
              <div class="task-desc">{{ task.description }}</div>
              <div class="task-meta">
                <code>{{ task.cron }}</code>
                <span v-if="task.nextRunAt">下次: {{ formatTime(task.nextRunAt) }}</span>
                <span v-if="task.lastRunAt">上次: {{ formatTime(task.lastRunAt) }}</span>
              </div>
            </div>
            <div class="task-actions">
              <button @click="toggleEnabled(task)">
                {{ task.enabled ? "禁用" : "启用" }}
              </button>
              <button class="danger" @click="remove(task)">删除</button>
            </div>
          </li>
        </ul>

        <h2>添加任务</h2>
        <form class="form" @submit.prevent="submit">
          <label>
            描述
            <input v-model="form.description" required />
          </label>
          <label>
            Cron 表达式
            <input v-model="form.cron" placeholder="0 9 * * *" required />
          </label>
          <label>
            Prompt
            <textarea v-model="form.prompt" rows="4" required></textarea>
          </label>
          <button type="submit" :disabled="loading">添加</button>
          <div v-if="opError" class="op-error">{{ opError }}</div>
        </form>
      </section>

      <div v-else class="empty">请先选择一个 Agent</div>
    </main>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted } from "vue";
import { useAgentsStore } from "@/stores/agents";
import { useSchedulerStore } from "@/stores/scheduler";

const agents = useAgentsStore();
const scheduler = useSchedulerStore();
const selectedAgentId = ref("");
const loading = ref(false);
const opError = ref("");

const form = ref({
  description: "",
  cron: "",
  prompt: "",
  enabled: true,
});

onMounted(() => {
  agents.load();
});

async function onSelectAgent() {
  opError.value = "";
  if (selectedAgentId.value) {
    await scheduler.load(selectedAgentId.value);
  } else {
    scheduler.tasks = [];
  }
}

async function submit() {
  if (!selectedAgentId.value) return;
  opError.value = "";
  // 与 engine cron-parser 的 5 段式（分 时 日 月 周）口径一致的前端预校验，
  // 非法表达式不必等后端 400 才发现
  if (!/^\S+( +\S+){4}$/.test(form.value.cron.trim())) {
    opError.value = "Cron 表达式需为 5 段格式（分 时 日 月 周），例如：0 9 * * *";
    return;
  }
  loading.value = true;
  try {
    await scheduler.create(selectedAgentId.value, { ...form.value, cron: form.value.cron.trim() });
    form.value = { description: "", cron: "", prompt: "", enabled: true };
  } catch (err) {
    opError.value = err instanceof Error ? err.message : "创建失败";
  } finally {
    loading.value = false;
  }
}

async function toggleEnabled(task: { id: string; enabled: boolean }) {
  if (!selectedAgentId.value) return;
  opError.value = "";
  try {
    await scheduler.update(selectedAgentId.value, task.id, { enabled: !task.enabled });
  } catch (err) {
    opError.value = err instanceof Error ? err.message : "操作失败";
  }
}

async function remove(task: { id: string }) {
  if (!selectedAgentId.value) return;
  if (!confirm("确定删除这个定时任务吗？")) return;
  opError.value = "";
  try {
    await scheduler.remove(selectedAgentId.value, task.id);
  } catch (err) {
    opError.value = err instanceof Error ? err.message : "删除失败";
  }
}

function formatTime(iso: string) {
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}
</script>

<style scoped>
.scheduler {
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
  margin-top: 8px;
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
  margin-bottom: 24px;
}

label {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin-bottom: 16px;
  font-size: 14px;
}

select,
input,
textarea {
  padding: 8px 12px;
  border-radius: 6px;
  border: 1px solid rgba(255, 255, 255, 0.12);
  background: #111827;
  color: var(--mc-text);
  font-size: 14px;
}

.panel {
  background: #111827;
  border-radius: 12px;
  padding: 20px;
}

.empty {
  color: var(--mc-text-secondary);
  padding: 24px 0;
}

.task-list {
  list-style: none;
  padding: 0;
  margin: 0 0 24px;
}

.task-item {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 12px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.06);
}

.task-desc {
  font-weight: 500;
}

.task-meta {
  display: flex;
  gap: 12px;
  margin-top: 6px;
  font-size: 12px;
  color: var(--mc-text-secondary);
}

.task-actions {
  display: flex;
  gap: 8px;
}

button {
  padding: 8px 12px;
  border-radius: 6px;
  border: none;
  background: var(--mc-accent);
  color: var(--mc-bg);
  cursor: pointer;
  font-size: 14px;
}

button:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

button.danger {
  background: #ff5c5c;
  color: white;
}

.form {
  margin-top: 16px;
}
</style>
