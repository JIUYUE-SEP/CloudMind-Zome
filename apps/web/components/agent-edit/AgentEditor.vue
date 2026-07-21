<template>
  <div class="agent-editor">
    <div class="back-bar">
      <BackButton to="/agents" />
      <h1 class="page-title">{{ isNew ? "新建心智" : "编辑心智" }}</h1>
      <span v-if="!isNew" class="agent-id-badge">{{ agentId }}</span>
      <div class="back-bar-actions">
        <button v-if="!isNew" class="danger-btn" :disabled="saving || deleting" @click="onDelete">
          {{ deleting ? "删除中..." : "删除心智" }}
        </button>
        <button class="save-btn" :disabled="saving || deleting" @click="save">
          {{ saving ? "保存中..." : "保存" }}
        </button>
      </div>
    </div>

    <div v-if="validationError" class="error-message">{{ validationError }}</div>
    <div v-if="saveError" class="error-message">{{ saveError }}</div>

    <div v-if="notFound" class="error-message">未找到该心智，可能已被删除。</div>
    <template v-else>
      <div class="tabs">
        <button
          v-for="tab in tabs"
          :key="tab.key"
          class="tab"
          :class="{ active: activeTab === tab.key }"
          @click="activeTab = tab.key"
        >
          {{ tab.label }}
        </button>
      </div>
      <div class="form-section">
        <Component :is="currentComponent" :agent="agentForm" :is-new="isNew" @update="onUpdate" />
      </div>
    </template>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, watch } from "vue";
import type { AgentConfig } from "@mindcloud/shared";
import { useAgentsStore } from "@/stores/agents";
import BackButton from "@/components/BackButton.vue";
import AgentEditBasic from "@/components/agent-edit/AgentEditBasic.vue";
import AgentEditPersona from "@/components/agent-edit/AgentEditPersona.vue";
import AgentEditModel from "@/components/agent-edit/AgentEditModel.vue";
import AgentEditSkills from "@/components/agent-edit/AgentEditSkills.vue";
import AgentEditTools from "@/components/agent-edit/AgentEditTools.vue";
import AgentEditAppearance from "@/components/agent-edit/AgentEditAppearance.vue";

const props = defineProps<{
  agentId?: string;
}>();

const agents = useAgentsStore();

const isNew = computed(() => !props.agentId);

const activeTab = ref("basic");
const saving = ref(false);
const deleting = ref(false);
const validationError = ref("");
const saveError = ref("");
const loadDone = ref(false);

const tabs = [
  { key: "basic", label: "基础", comp: AgentEditBasic },
  { key: "persona", label: "人设", comp: AgentEditPersona },
  { key: "model", label: "模型", comp: AgentEditModel },
  { key: "skills", label: "技能", comp: AgentEditSkills },
  { key: "tools", label: "工具", comp: AgentEditTools },
  { key: "appearance", label: "外观", comp: AgentEditAppearance },
];

const currentComponent = computed(() => tabs.find((t) => t.key === activeTab.value)?.comp);

const sourceAgent = computed(() =>
  isNew.value ? undefined : agents.list.find((a) => a.id === props.agentId),
);

const notFound = computed(
  () => !isNew.value && loadDone.value && !agents.error && !sourceAgent.value,
);

const agentForm = ref<AgentConfig>(buildEmptyAgent());
// 用户开始编辑后置脏，列表刷新（agents.load）不再覆盖未保存的输入
let formDirty = false;

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
  if (formDirty) return;
  const src = sourceAgent.value;
  if (src) {
    agentForm.value = {
      ...buildEmptyAgent(),
      ...src,
      skills: src.skills ? [...src.skills] : [],
      tools: src.tools ? [...src.tools] : [],
      tags: src.tags ? [...src.tags] : [],
    };
  } else if (isNew.value) {
    agentForm.value = buildEmptyAgent();
  }
}

onMounted(async () => {
  await agents.load();
  loadDone.value = true;
});

watch(() => [sourceAgent.value, isNew.value], syncAgent, { immediate: true });

function onUpdate(patch: Partial<AgentConfig>) {
  formDirty = true;
  agentForm.value = { ...agentForm.value, ...patch };
}

async function save() {
  validationError.value = "";
  saveError.value = "";

  if (!agentForm.value.id || !agentForm.value.name) {
    validationError.value = "请填写 ID 和名称后再保存";
    return;
  }

  saving.value = true;
  try {
    if (isNew.value) {
      const created = await agents.create(agentForm.value);
      formDirty = false;
      navigateTo(`/agents/${created.id}/edit`);
    } else {
      if (!props.agentId) return;
      await agents.update(props.agentId, agentForm.value);
      // 复位脏标记：之后列表刷新时，表单以服务端最新数据重新填充
      formDirty = false;
    }
  } catch (err) {
    saveError.value = err instanceof Error ? err.message : "保存失败，请检查输入或稍后重试";
  } finally {
    saving.value = false;
  }
}

async function onDelete() {
  if (isNew.value || !props.agentId) return;
  if (!confirm("确定要删除这个心智吗？")) return;
  deleting.value = true;
  saveError.value = "";
  try {
    await agents.remove(props.agentId);
    navigateTo("/agents");
  } catch (err) {
    saveError.value = err instanceof Error ? err.message : "删除失败";
  } finally {
    deleting.value = false;
  }
}
</script>

<style scoped>
.agent-editor {
  position: absolute;
  inset: 0;
  overflow-y: auto;
  padding: 32px;
  background: var(--mc-bg);
  color: var(--mc-text);
}

.back-bar {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 24px;
}

.page-title {
  margin: 0;
  font-size: 24px;
  font-weight: 600;
}

.agent-id-badge {
  font-size: 12px;
  color: var(--mc-text-tertiary);
  font-family: monospace;
  background: var(--mc-panel);
  padding: 4px 8px;
  border-radius: 4px;
}

.back-bar-actions {
  margin-left: auto;
  display: flex;
  gap: 12px;
}

.save-btn {
  padding: 10px 20px;
  background: var(--mc-accent);
  color: #0b0f17;
  border: none;
  border-radius: 8px;
  font-size: 14px;
  font-weight: 600;
  cursor: pointer;
  transition: opacity 0.2s;
}

.save-btn:hover {
  opacity: 0.9;
}

.save-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.danger-btn {
  padding: 10px 20px;
  background: transparent;
  border: 1px solid var(--mc-danger);
  color: var(--mc-danger);
  border-radius: 8px;
  font-size: 14px;
  cursor: pointer;
  transition: background 0.2s;
}

.danger-btn:hover {
  background: rgba(239, 68, 68, 0.1);
}

.danger-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.tabs {
  display: flex;
  gap: 4px;
  margin-bottom: 24px;
  border-bottom: 1px solid var(--mc-border);
  padding-bottom: 12px;
}

.tab {
  padding: 10px 20px;
  border-radius: 8px 8px 0 0;
  cursor: pointer;
  color: var(--mc-text-secondary);
  font-size: 14px;
  background: transparent;
  border: 1px solid transparent;
  border-bottom: none;
  transition: all 0.2s;
}

.tab:hover {
  color: var(--mc-text);
  background: rgba(255, 255, 255, 0.03);
}

.tab.active {
  color: var(--mc-accent);
  background: var(--mc-panel);
  border-color: var(--mc-border);
}

.form-section {
  background: var(--mc-panel);
  border: 1px solid var(--mc-border);
  border-radius: 12px;
  padding: 24px;
  margin-bottom: 20px;
  max-width: 720px;
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
