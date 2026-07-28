<template>
  <div class="agent-editor">
    <div class="back-bar">
      <BackButton to="/agents" />
      <h1 class="page-title">{{ isNew ? "新建心智" : "编辑心智" }}</h1>
      <span v-if="!isNew" class="agent-id-badge">{{ agentId }}</span>
      <div class="back-bar-actions">
        <button v-if="!isNew" class="danger-btn" :disabled="saving || deleting || formLocked" @click="onDelete">
          {{ deleting ? "删除中..." : "删除心智" }}
        </button>
        <button class="save-btn" :disabled="saving || deleting || formLocked" @click="save">
          {{ saving ? "保存中..." : "保存" }}
        </button>
      </div>
    </div>

    <div v-if="validationError" class="error-message">{{ validationError }}</div>
    <div v-if="saveError" class="error-message">{{ saveError }}</div>
    <div v-if="editLoadError" class="error-message">
      加载失败：{{ agents.error }}
      <button class="retry-btn" @click="retryLoad">重试</button>
    </div>

    <div v-if="notFound" class="error-message">未找到该心智，可能已被删除。</div>
    <template v-else>
      <div v-if="!isNew && !loadDone" class="loading-hint">加载中...</div>
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
      <!-- 数据未加载完成时禁用表单：防止在空表单上编辑后保存，覆盖服务端原有配置 -->
      <fieldset class="form-section" :disabled="formLocked">
        <Component :is="currentComponent" :agent="agentForm" :is-new="isNew" @update="onUpdate" />
      </fieldset>
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

// Agent ID 规则的唯一来源在 packages/shared（engine 各路由同一口径）
import { AGENT_ID_PATTERN } from "@mindcloud/shared";

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

// 编辑模式下源数据未就位（加载中或加载失败）时锁定表单与保存/删除：
// 否则用户在空表单上的输入会把服务端原有的 persona/skills/tools 覆盖掉
const formLocked = computed(() => !isNew.value && !sourceAgent.value);

const editLoadError = computed(() => !isNew.value && loadDone.value && !!agents.error);

async function loadAgents() {
  loadDone.value = false;
  await agents.load();
  loadDone.value = true;
}

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

onMounted(loadAgents);

function retryLoad() {
  loadAgents();
}

watch(() => [sourceAgent.value, isNew.value], syncAgent, { immediate: true });

// agentId 切换（/agents/a/edit → /agents/b/edit 组件复用）时复位脏标记并重新装载，
// 否则 A 的未保存表单会被保存到 B
watch(
  () => props.agentId,
  () => {
    formDirty = false;
    syncAgent();
  },
);

function onUpdate(patch: Partial<AgentConfig>) {
  formDirty = true;
  agentForm.value = { ...agentForm.value, ...patch };
}

async function save() {
  validationError.value = "";
  saveError.value = "";

  // 数据未加载完成，禁止保存（防空表单覆盖服务端配置）
  if (formLocked.value) return;

  // 输入阶段不做 trim（避免吃掉名称中的空格），保存校验前统一处理
  const id = agentForm.value.id.trim();
  const name = agentForm.value.name.trim();
  const codename = agentForm.value.codename?.trim();
  if (!id || !name) {
    validationError.value = "请填写 ID 和名称后再保存";
    return;
  }
  if (isNew.value && !AGENT_ID_PATTERN.test(id)) {
    validationError.value = "ID 仅支持字母、数字、连字符和下划线，最长 64 个字符";
    return;
  }
  agentForm.value = { ...agentForm.value, id, name, codename };

  saving.value = true;
  try {
    if (isNew.value) {
      const created = await agents.create(agentForm.value);
      formDirty = false;
      // replace：新建页已消费完毕，后退不应回到可重复提交的表单
      navigateTo(`/agents/${encodeURIComponent(created.id)}/edit`, { replace: true });
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
  margin: 0 0 20px;
  min-width: 0;
  max-width: 720px;
}

.form-section:disabled {
  opacity: 0.6;
}

.loading-hint {
  color: var(--mc-text-tertiary);
  font-size: 13px;
  margin-bottom: 16px;
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
