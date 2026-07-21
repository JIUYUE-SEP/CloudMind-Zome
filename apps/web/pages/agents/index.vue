<template>
  <div class="agents-page">
    <header class="page-header">
      <div class="page-header-left">
        <BackButton to="/" />
        <h1 class="page-title">心智整备</h1>
      </div>
      <button class="btn-primary" @click="navigateTo('/agents/new')">+ 新建心智</button>
    </header>

    <div v-if="opError" class="error-message">{{ opError }}</div>

    <div v-if="agents.isLoading && !agents.list.length" class="empty-state">
      <div class="empty-text">加载中...</div>
    </div>
    <div v-else-if="agents.error && !agents.list.length" class="error-message">
      加载失败：{{ agents.error }}
      <button class="retry-btn" @click="agents.load()">重试</button>
    </div>
    <div v-else-if="!agents.list.length" class="empty-state">
      <div class="empty-icon">
        <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
          <rect x="4" y="8" width="16" height="12" rx="2" />
          <path d="M12 8V4" />
          <circle cx="12" cy="3" r="1" />
          <circle cx="9" cy="13" r="0.5" fill="currentColor" />
          <circle cx="15" cy="13" r="0.5" fill="currentColor" />
          <path d="M9 17h6" />
        </svg>
      </div>
      <div class="empty-text">还没有心智</div>
      <div class="empty-hint">点击"新建心智"创建你的第一个数字生命</div>
    </div>

    <template v-else>
      <!-- 刷新失败但手里有数据：顶部错误条 + 保留列表，不整页替换 -->
      <div v-if="agents.error" class="error-message">
        刷新失败：{{ agents.error }}
        <button class="retry-btn" @click="agents.load()">重试</button>
      </div>
      <div class="agent-grid">
      <div
        v-for="a in agents.list"
        :key="a.id"
        class="agent-card"
        @click="openEdit(a.id)"
      >
        <div class="agent-card-header">
          <div class="agent-avatar" :style="avatarStyle(a)">{{ a.name?.charAt(0) || "?" }}</div>
          <div class="agent-info">
            <div class="agent-name">{{ a.name || a.id }}</div>
            <div class="agent-id">{{ a.id }}</div>
          </div>
        </div>
        <div class="agent-desc">{{ a.description || "暂无描述" }}</div>
        <div class="agent-meta">
          <span v-if="modelLabel(a)" class="tag model">{{ modelLabel(a) }}</span>
          <span v-for="tag in a.tags || []" :key="tag" class="tag">{{ tag }}</span>
          <span class="tag">{{ a.tools?.length || 0 }} 工具</span>
          <span class="tag">{{ a.skills?.length || 0 }} 技能</span>
        </div>
        <div class="card-actions">
          <button class="action-btn" @click.stop="openEdit(a.id)">编辑</button>
          <button class="action-btn danger" @click.stop="onDelete(a)">删除</button>
        </div>
      </div>
      </div>
    </template>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted } from "vue";
import type { AgentConfig } from "@mindcloud/shared";
import { useAgentsStore } from "@/stores/agents";
import BackButton from "@/components/BackButton.vue";

const agents = useAgentsStore();
const opError = ref("");

onMounted(() => {
  agents.load();
});

function modelLabel(a: AgentConfig): string {
  const model = a.modelId || a.model || "";
  return a.providerId && model ? `${a.providerId}/${model}` : model;
}

function avatarStyle(a: AgentConfig) {
  // 默认用原型的高亮色底；配置了代表色时改为实色底 + 深色字
  return a.representColor ? { backgroundColor: a.representColor, color: "#0b0f17" } : {};
}

function openEdit(id: string) {
  navigateTo(`/agents/${encodeURIComponent(id)}/edit`);
}

async function onDelete(a: AgentConfig) {
  if (!confirm("确定要删除这个心智吗？")) return;
  opError.value = "";
  try {
    await agents.remove(a.id);
  } catch (err) {
    opError.value = err instanceof Error ? err.message : "删除失败";
  }
}
</script>

<style scoped>
.agents-page {
  position: absolute;
  inset: 0;
  overflow-y: auto;
  padding: 32px;
  background: var(--mc-bg);
  color: var(--mc-text);
}

.page-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 28px;
}

.page-header-left {
  display: flex;
  align-items: center;
  gap: 16px;
}

.page-title {
  margin: 0;
  font-size: 24px;
  font-weight: 600;
}

.btn-primary {
  background: var(--mc-accent);
  color: #0b0f17;
  border: none;
  padding: 10px 20px;
  border-radius: 8px;
  font-size: 14px;
  font-weight: 600;
  cursor: pointer;
  transition: opacity 0.2s;
}

.btn-primary:hover {
  opacity: 0.9;
}

.agent-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));
  gap: 20px;
}

.agent-card {
  background: var(--mc-panel);
  border: 1px solid var(--mc-border);
  border-radius: 12px;
  padding: 20px;
  cursor: pointer;
  transition: all 0.2s;
}

.agent-card:hover {
  border-color: rgba(0, 229, 201, 0.3);
  transform: translateY(-2px);
}

.agent-card-header {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 12px;
}

.agent-avatar {
  width: 44px;
  height: 44px;
  border-radius: 50%;
  background: rgba(0, 229, 201, 0.15);
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 18px;
  font-weight: 600;
  color: var(--mc-accent);
  flex-shrink: 0;
}

.agent-info {
  flex: 1;
  min-width: 0;
}

.agent-name {
  font-size: 16px;
  font-weight: 600;
  margin-bottom: 4px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.agent-id {
  font-size: 12px;
  color: var(--mc-text-tertiary);
  font-family: monospace;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.agent-desc {
  font-size: 13px;
  color: var(--mc-text-secondary);
  line-height: 1.5;
  margin-bottom: 12px;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
  min-height: 2.6em;
}

.agent-meta {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}

.tag {
  font-size: 11px;
  padding: 4px 8px;
  border-radius: 4px;
  background: var(--mc-panel);
  color: var(--mc-text-secondary);
}

.tag.model {
  background: rgba(0, 229, 201, 0.1);
  color: var(--mc-accent);
}

.card-actions {
  display: flex;
  gap: 8px;
  margin-top: 16px;
  padding-top: 12px;
  border-top: 1px solid var(--mc-border);
}

.action-btn {
  padding: 6px 14px;
  background: transparent;
  border: 1px solid var(--mc-border);
  border-radius: 6px;
  color: var(--mc-text-secondary);
  font-size: 12px;
  cursor: pointer;
  transition: all 0.15s;
}

.action-btn:hover {
  border-color: var(--mc-accent);
  color: var(--mc-accent);
}

.action-btn.danger:hover {
  border-color: var(--mc-danger);
  color: var(--mc-danger);
}

.empty-state {
  text-align: center;
  padding: 80px 20px;
  color: var(--mc-text-tertiary);
}

.empty-icon {
  margin-bottom: 16px;
  opacity: 0.5;
}

.empty-text {
  font-size: 16px;
  margin-bottom: 8px;
}

.empty-hint {
  font-size: 13px;
  color: var(--mc-text-tertiary);
}

.retry-btn {
  margin-left: 12px;
  padding: 4px 12px;
  background: transparent;
  border: 1px solid currentColor;
  border-radius: 6px;
  color: inherit;
  font-size: 12px;
  cursor: pointer;
}

.error-message {
  margin-bottom: 16px;
  padding: 10px 12px;
  border-radius: 8px;
  background: rgba(239, 68, 68, 0.12);
  border: 1px solid rgba(239, 68, 68, 0.25);
  color: var(--mc-danger);
  font-size: 13px;
  line-height: 1.5;
}
</style>
