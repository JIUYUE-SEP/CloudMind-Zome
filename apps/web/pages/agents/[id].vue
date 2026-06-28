<template>
  <div class="agent-edit">
    <aside class="ae-sidebar">
      <div class="sidebar-header">
        <BackButton />
        <h3>心智整备</h3>
        <button class="sidebar-add" @click="navigateTo('/agents/new')">+ 新建</button>
      </div>
      <div class="sidebar-list">
        <div
          v-for="a in agents.list"
          :key="a.id"
          class="agent-row"
          :class="{ active: selectedId === a.id }"
          @click="selectAgent(a.id)"
        >
          <div
            class="agent-avatar fallback"
            :style="{ backgroundColor: agentForm.representColor || '#00e5c9' }"
          >
            {{ a.name?.charAt(0) || '?' }}
          </div>
          <div class="agent-meta">
            <div class="agent-name">{{ a.name }}</div>
            <div class="agent-code">{{ a.codename || a.id }}</div>
          </div>
        </div>
        <div v-if="!agents.list.length" class="sidebar-empty">暂无心智</div>
      </div>
    </aside>

    <main class="ae-center">
      <div class="center-info">
        <div class="info-avatar" :style="{ backgroundColor: agentForm.representColor || '#00e5c9' }">
          {{ agentForm.name?.charAt(0) || '?' }}
        </div>
        <div class="info-name">{{ agentForm.name || '未命名心智' }}</div>
        <div class="info-code">{{ agentForm.codename || '---' }}</div>
        <div v-if="agentForm.description" class="info-desc">{{ agentForm.description }}</div>
      </div>
    </main>

    <aside class="ae-right">
      <div class="right-tabs">
        <button
          v-for="tab in tabs"
          :key="tab.key"
          class="tab-btn"
          :class="{ active: activeTab === tab.key }"
          @click="activeTab = tab.key"
        >
          <span class="tab-icon">{{ tab.icon }}</span>
          <span class="tab-label">{{ tab.label }}</span>
        </button>
      </div>
      <div class="settings-panel">
        <div class="panel-header">{{ currentTab?.label }}</div>
        <div class="panel-scroll">
          <Component :is="currentComponent" :agent="agentForm" :is-new="isNew" @update="onUpdate" />
          <div class="panel-actions">
            <button v-if="!isNew" class="danger-btn" @click="deleteAgent">删除心智</button>
            <button class="save-btn" :disabled="saving" @click="save">
              {{ saving ? '保存中...' : '保存' }}
            </button>
          </div>
        </div>
      </div>
    </aside>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, watch } from "vue";
import { useRoute } from "vue-router";
import type { AgentConfig } from "@mindcloud/shared";
import { useAgentsStore } from "@/stores/agents";
import BackButton from "@/components/BackButton.vue";
import AgentEditBasic from "@/components/agent-edit/AgentEditBasic.vue";
import AgentEditPersona from "@/components/agent-edit/AgentEditPersona.vue";
import AgentEditModel from "@/components/agent-edit/AgentEditModel.vue";
import AgentEditSkills from "@/components/agent-edit/AgentEditSkills.vue";
import AgentEditTools from "@/components/agent-edit/AgentEditTools.vue";
import AgentEditAppearance from "@/components/agent-edit/AgentEditAppearance.vue";

const route = useRoute();
const agents = useAgentsStore();

const activeTab = ref("basic");
const saving = ref(false);

const tabs = [
  { key: "basic", label: "基础", icon: "◈", comp: AgentEditBasic },
  { key: "persona", label: "人设", icon: "◉", comp: AgentEditPersona },
  { key: "model", label: "模型", icon: "⚡", comp: AgentEditModel },
  { key: "skills", label: "技能", icon: "✦", comp: AgentEditSkills },
  { key: "tools", label: "工具", icon: "⚙", comp: AgentEditTools },
  { key: "appearance", label: "外观", icon: "◐", comp: AgentEditAppearance },
];

const currentTab = computed(() => tabs.find((t) => t.key === activeTab.value));
const currentComponent = computed(() => currentTab.value?.comp);

const selectedId = computed(() => (route.params.id as string) || "");
const isNew = computed(() => selectedId.value === "new");

const sourceAgent = computed(() =>
  isNew.value ? undefined : agents.list.find((a) => a.id === selectedId.value),
);

const agentForm = ref<AgentConfig>(buildEmptyAgent());

function buildEmptyAgent(): AgentConfig {
  return {
    id: "",
    name: "",
    persona: "",
    skills: [],
    tools: [],
  };
}

function syncAgent() {
  const src = sourceAgent.value;
  if (src) {
    agentForm.value = {
      ...buildEmptyAgent(),
      ...src,
      skills: src.skills ? [...src.skills] : [],
      tools: src.tools ? [...src.tools] : [],
      tags: src.tags ? [...src.tags] : [],
    };
  } else {
    agentForm.value = buildEmptyAgent();
  }
}

onMounted(() => {
  agents.load();
});

watch(
  () => selectedId.value + agents.list.map((a) => a.id).join(","),
  syncAgent,
  { immediate: true },
);

function onUpdate(patch: Partial<AgentConfig>) {
  agentForm.value = { ...agentForm.value, ...patch };
}

async function save() {
  saving.value = true;
  try {
    if (isNew.value) {
      if (!agentForm.value.id || !agentForm.value.name) return;
      const created = await agents.create(agentForm.value);
      navigateTo(`/agents/${created.id}`);
    } else {
      if (!selectedId.value) return;
      await agents.update(selectedId.value, agentForm.value);
    }
  } finally {
    saving.value = false;
  }
}

async function deleteAgent() {
  if (isNew.value || !selectedId.value) return;
  if (!confirm("确定要删除这个心智吗？")) return;
  await agents.remove(selectedId.value);
  navigateTo("/hub");
}

function selectAgent(id: string) {
  navigateTo(`/agents/${id}`);
}
</script>

<style scoped>
.agent-edit {
  position: absolute;
  top: 0;
  left: 0;
  right: 180px;
  bottom: 56px;
  background: var(--mc-bg);
  color: var(--mc-text);
  display: flex;
  overflow: hidden;
}

.ae-sidebar {
  width: 240px;
  flex-shrink: 0;
  border-right: 1px solid var(--mc-border);
  display: flex;
  flex-direction: column;
  background: rgba(11, 15, 23, 0.8);
}

.sidebar-header {
  height: 56px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 14px;
  border-bottom: 1px solid var(--mc-border);
  flex-shrink: 0;
}

.sidebar-header h3 {
  margin: 0;
  font-size: 14px;
  font-weight: 600;
}

.sidebar-add {
  padding: 4px 10px;
  background: rgba(0, 229, 201, 0.12);
  border: 1px solid rgba(0, 229, 201, 0.25);
  border-radius: 6px;
  color: var(--mc-accent);
  font-size: 12px;
  cursor: pointer;
}

.sidebar-list {
  flex: 1;
  overflow-y: auto;
  padding: 8px;
}

.agent-row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 8px;
  border-radius: 8px;
  cursor: pointer;
  transition: background 0.15s;
}

.agent-row:hover {
  background: rgba(255, 255, 255, 0.04);
}

.agent-row.active {
  background: rgba(0, 229, 201, 0.08);
}

.agent-avatar {
  width: 36px;
  height: 36px;
  border-radius: 50%;
  object-fit: cover;
  flex-shrink: 0;
}

.agent-avatar.fallback {
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 14px;
  font-weight: 600;
  color: #0b0f17;
}

.agent-meta {
  min-width: 0;
}

.agent-name {
  font-size: 13px;
  color: var(--mc-text);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.agent-code {
  font-size: 11px;
  color: var(--mc-text-secondary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.sidebar-empty {
  padding: 20px;
  text-align: center;
  color: var(--mc-text-tertiary);
  font-size: 13px;
}

.ae-center {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  min-width: 0;
  position: relative;
}

.center-info {
  text-align: center;
  padding: 20px;
}

.info-avatar {
  width: 96px;
  height: 96px;
  border-radius: 50%;
  margin: 0 auto 16px;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 36px;
  font-weight: 600;
  color: #0b0f17;
}

.info-name {
  font-size: 22px;
  font-weight: 500;
  margin-bottom: 6px;
}

.info-code {
  font-size: 14px;
  color: var(--mc-text-secondary);
  margin-bottom: 12px;
}

.info-desc {
  font-size: 13px;
  color: var(--mc-text-tertiary);
  max-width: 420px;
  line-height: 1.5;
}

.ae-right {
  display: flex;
  border-left: 1px solid var(--mc-border);
  flex-shrink: 0;
}

.right-tabs {
  width: 64px;
  display: flex;
  flex-direction: column;
  padding: 12px 8px;
  gap: 8px;
  background: rgba(11, 15, 23, 0.6);
}

.tab-btn {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
  padding: 10px 4px;
  background: transparent;
  border: 1px solid transparent;
  border-radius: 8px;
  color: var(--mc-text-secondary);
  cursor: pointer;
  transition: all 0.15s;
}

.tab-btn:hover {
  background: rgba(255, 255, 255, 0.04);
  color: var(--mc-text);
}

.tab-btn.active {
  background: rgba(0, 229, 201, 0.08);
  border-color: rgba(0, 229, 201, 0.2);
  color: var(--mc-accent);
}

.tab-icon {
  font-size: 16px;
}

.tab-label {
  font-size: 10px;
}

.settings-panel {
  width: 340px;
  background: rgba(255, 255, 255, 0.04);
  border-left: 1px solid var(--mc-border);
  display: flex;
  flex-direction: column;
}

.panel-header {
  height: 48px;
  display: flex;
  align-items: center;
  padding: 0 16px;
  border-bottom: 1px solid var(--mc-border);
  font-size: 14px;
  font-weight: 500;
}

.panel-scroll {
  flex: 1;
  overflow-y: auto;
  padding: 16px;
}

.panel-actions {
  margin-top: 20px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.save-btn {
  width: 100%;
  padding: 10px;
  background: var(--mc-accent);
  color: #0b0f17;
  border: none;
  border-radius: 8px;
  font-weight: 600;
  font-size: 13px;
  cursor: pointer;
}

.save-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.danger-btn {
  width: 100%;
  padding: 10px;
  background: transparent;
  border: 1px solid rgba(239, 68, 68, 0.3);
  color: var(--mc-danger);
  border-radius: 8px;
  font-size: 13px;
  cursor: pointer;
}
</style>
