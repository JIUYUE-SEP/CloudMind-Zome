<template>
  <div
    v-if="visible"
    ref="panelRef"
    class="sys-settings-panel"
    :class="{ dragging }"
    :style="panelStyle"
    @click.stop
    @mousedown="onMouseDown"
  >
    <div class="ss-title">系统设置</div>

    <div class="ss-tabs">
      <button
        v-for="t in tabs"
        :key="t.key"
        class="ss-tab"
        :class="{ active: activeTab === t.key }"
        @click="activeTab = t.key"
      >
        {{ t.label }}
      </button>
    </div>

    <div class="ss-body">
      <div v-if="activeTab === 'tools'" class="ss-section">
        <div class="ss-hint">已注册工具列表</div>
        <div v-if="store.tools.length === 0" class="ss-placeholder">暂无工具数据</div>
        <div v-else class="ss-tool-list">
          <div v-for="tool in store.tools" :key="tool.name" class="ss-tool-row">
            <span class="ss-tool-name">{{ tool.name }}</span>
            <span class="ss-tool-set">{{ tool.toolset }}</span>
            <span :class="['ss-tool-badge', tool.safeToParallel ? 'safe' : 'unsafe']">
              {{ tool.safeToParallel ? "并行" : "串行" }}
            </span>
          </div>
        </div>
      </div>

      <div v-if="activeTab === 'memory'" class="ss-section">
        <label class="ss-field">
          <span>压缩阈值 (0-1)</span>
          <input v-model.number="form.memory.compactThreshold" type="number" step="0.05" min="0" max="1" />
        </label>
        <label class="ss-field">
          <span>保留最近消息数</span>
          <input v-model.number="form.memory.keepRecent" type="number" min="1" max="20" />
        </label>
        <label class="ss-field">
          <span>热记忆上限</span>
          <input v-model.number="form.memory.hotMemoryLimit" type="number" min="1" max="50" />
        </label>
        <label class="ss-field">
          <span>温记忆上限</span>
          <input v-model.number="form.memory.warmMemoryLimit" type="number" min="1" max="50" />
        </label>
      </div>

      <div v-if="activeTab === 'llm'" class="ss-section">
        <div class="deprecated-notice">
          <div class="notice-icon">⚠️</div>
          <h3>Provider 管理已迁移</h3>
          <p>「对话模型」配置已移至「算力中枢」，请前往该页面管理 Provider、模型列表和 Fallback 链。</p>
          <button class="mini-btn" @click="goCompute">前往算力中枢</button>
        </div>
      </div>

      <div v-if="activeTab === 'external'" class="ss-section">
        <label class="ss-field">
          <span>Tavily API Key（网络搜索）</span>
          <input v-model="form.tavilyApiKey" :type="showKey ? 'text' : 'password'" :placeholder="hasSavedKey ? '已保存，留空则保持不变' : '用于网络搜索的 Tavily API Key'" />
          <button class="ss-toggle-key" @click="showKey = !showKey">
            {{ showKey ? "隐藏" : "显示" }}
          </button>
        </label>
        <p class="hint-text">用于 Agent 调用网络搜索工具，可在 https://tavily.com 获取</p>
      </div>

      <div v-if="activeTab === 'skill'" class="ss-section">
        <div class="ss-placeholder">技能系统（Skill）即将在 V1.2 推出</div>
      </div>

      <div v-if="activeTab === 'mcp'" class="ss-section">
        <div class="ss-placeholder">MCP 支持开发中，暂未开放</div>
      </div>

      <div v-if="activeTab === 'acp'" class="ss-section">
        <div class="ss-placeholder">ACP 协议管理即将在 V1.2 推出</div>
      </div>
    </div>

    <div v-if="saveMsg" class="ss-msg" :class="saveMsgType">{{ saveMsg }}</div>
    <div class="ss-actions">
      <button class="ss-save" @click="save">保存</button>
      <button class="ss-cancel" @click="emit('close')">关闭</button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, reactive, watch, onMounted } from "vue";
import { useSettingsStore } from "@/stores/settings";

const props = defineProps<{ visible: boolean }>();
const emit = defineEmits<{ (e: "close"): void }>();

const store = useSettingsStore();
const panelRef = ref<HTMLElement>();
const dragging = ref(false);
const dragOffset = ref({ x: 0, y: 0 });
const dragPos = ref({ x: 0, y: 0 });
const panelStyle = ref("");
const showKey = ref(false);
const hasSavedKey = ref(false);
const saveMsg = ref("");
const saveMsgType = ref<"success" | "error">("success");

const activeTab = ref("tools");
const tabs = [
  { key: "tools", label: "工具" },
  { key: "memory", label: "记忆" },
  { key: "llm", label: "对话模型" },
  { key: "external", label: "外部服务" },
  { key: "skill", label: "技能" },
  { key: "mcp", label: "MCP" },
  { key: "acp", label: "ACP" },
];

const form = reactive({
  memory: {
    compactThreshold: 0.8,
    keepRecent: 3,
    hotMemoryLimit: 10,
    warmMemoryLimit: 20,
  },
  tavilyApiKey: "",
});

onMounted(() => {
  if (props.visible) {
    load();
  }
});

watch(
  () => props.visible,
  (v) => {
    if (v) {
      load();
    }
  },
);

async function load() {
  saveMsg.value = "";
  await store.load();
  await store.loadTools();
  if (store.settings) {
    form.memory.compactThreshold = store.settings.memory.compactThreshold;
    form.memory.keepRecent = store.settings.memory.keepRecent;
    form.memory.hotMemoryLimit = store.settings.memory.hotMemoryLimit;
    form.memory.warmMemoryLimit = store.settings.memory.warmMemoryLimit;
    // 服务端只返回掩码 "***"：不回填，留空表示保持不变，避免把掩码当真值保存
    hasSavedKey.value = store.settings.tavilyApiKey === "***";
    form.tavilyApiKey = "";
  }
}

async function save() {
  try {
    store.settings = {
      memory: { ...form.memory },
      tavilyApiKey: form.tavilyApiKey,
    };
    await store.save();
    saveMsg.value = "保存成功";
    saveMsgType.value = "success";
    setTimeout(() => emit("close"), 400);
  } catch (err) {
    saveMsg.value = `保存失败: ${err instanceof Error ? err.message : String(err)}`;
    saveMsgType.value = "error";
  }
}

function goCompute() {
  emit("close");
  navigateTo("/compute");
}

function onMouseDown(e: MouseEvent) {
  const target = e.target as HTMLElement;
  if (!target.classList.contains("ss-title")) return;
  dragging.value = true;
  dragOffset.value = { x: e.clientX - dragPos.value.x, y: e.clientY - dragPos.value.y };
  document.body.style.userSelect = "none";
  document.addEventListener("mousemove", onMouseMove);
  document.addEventListener("mouseup", onMouseUp);
}

function onMouseMove(e: MouseEvent) {
  if (!dragging.value) return;
  dragPos.value = { x: e.clientX - dragOffset.value.x, y: e.clientY - dragOffset.value.y };
  panelStyle.value = `transform: translate(${dragPos.value.x}px, ${dragPos.value.y}px)`;
}

function onMouseUp() {
  dragging.value = false;
  document.body.style.userSelect = "";
  document.removeEventListener("mousemove", onMouseMove);
  document.removeEventListener("mouseup", onMouseUp);
}
</script>

<style scoped>
.sys-settings-panel {
  position: absolute;
  bottom: 120px;
  right: 116px;
  width: 380px;
  max-height: 520px;
  padding: 14px;
  background: rgba(11, 15, 23, 0.92);
  backdrop-filter: blur(16px);
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: 12px;
  z-index: 120;
  color: var(--mc-text);
  display: flex;
  flex-direction: column;
}

.ss-title {
  font-size: 13px;
  font-weight: 600;
  margin-bottom: 10px;
  cursor: grab;
  user-select: none;
  flex-shrink: 0;
}

.sys-settings-panel.dragging .ss-title {
  cursor: grabbing;
}

.ss-tabs {
  display: flex;
  gap: 4px;
  margin-bottom: 10px;
  flex-shrink: 0;
  overflow-x: auto;
}

.ss-tab {
  padding: 5px 10px;
  background: rgba(255, 255, 255, 0.04);
  border: 1px solid rgba(255, 255, 255, 0.06);
  border-radius: 6px;
  color: var(--mc-text-secondary);
  font-size: 11px;
  cursor: pointer;
  white-space: nowrap;
  transition: all 0.15s;
}

.ss-tab.active,
.ss-tab:hover {
  background: rgba(0, 229, 201, 0.12);
  border-color: rgba(0, 229, 201, 0.3);
  color: var(--mc-accent);
}

.ss-body {
  flex: 1;
  overflow-y: auto;
  font-size: 12px;
}

.ss-body::-webkit-scrollbar {
  width: 4px;
}

.ss-body::-webkit-scrollbar-thumb {
  background: rgba(255, 255, 255, 0.1);
  border-radius: 2px;
}

.ss-section {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.ss-field {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.ss-field span {
  font-size: 11px;
  color: var(--mc-text-secondary);
}

.ss-field input,
.ss-field select {
  padding: 8px;
  background: #141b24;
  border: 1px solid #1e2731;
  border-radius: 6px;
  color: var(--mc-text);
  font-size: 12px;
  width: 100%;
}

.ss-field input:focus,
.ss-field select:focus {
  outline: none;
  border-color: rgba(0, 229, 201, 0.4);
}

.ss-toggle-key {
  align-self: flex-start;
  margin-top: 2px;
  padding: 2px 8px;
  background: transparent;
  border: 1px solid rgba(255, 255, 255, 0.1);
  border-radius: 4px;
  color: var(--mc-text-tertiary);
  font-size: 11px;
  cursor: pointer;
  transition: all 0.15s;
}

.ss-toggle-key:hover {
  color: var(--mc-accent);
  border-color: rgba(0, 229, 201, 0.3);
}

.ss-tool-list {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.ss-tool-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 8px;
  background: rgba(255, 255, 255, 0.03);
  border-radius: 6px;
}

.ss-tool-name {
  flex: 1;
  color: var(--mc-text);
}

.ss-tool-set {
  color: var(--mc-text-tertiary);
  font-size: 11px;
}

.ss-tool-badge {
  font-size: 10px;
  padding: 2px 6px;
  border-radius: 4px;
}

.ss-tool-badge.safe {
  background: rgba(16, 185, 129, 0.15);
  color: var(--mc-success);
}

.ss-tool-badge.unsafe {
  background: rgba(245, 158, 11, 0.15);
  color: var(--mc-warning);
}

.ss-placeholder {
  color: var(--mc-text-tertiary);
  text-align: center;
  padding: 30px 0;
}

.ss-hint {
  font-size: 11px;
  color: var(--mc-text-tertiary);
}

.ss-msg {
  text-align: center;
  font-size: 11px;
  padding: 6px;
  border-radius: 4px;
  flex-shrink: 0;
}

.ss-msg.success {
  color: var(--mc-success);
  background: rgba(16, 185, 129, 0.1);
}

.ss-msg.error {
  color: var(--mc-danger);
  background: rgba(239, 68, 68, 0.1);
}

.ss-actions {
  display: flex;
  gap: 8px;
  margin-top: 6px;
  flex-shrink: 0;
}

.ss-actions button {
  flex: 1;
  padding: 8px;
  border-radius: 6px;
  font-size: 12px;
  cursor: pointer;
  transition: all 0.15s;
  border: none;
}

.ss-save {
  background: var(--mc-accent);
  color: var(--mc-bg);
  font-weight: 600;
}

.ss-save:hover {
  background: #00d1b8;
}

.ss-cancel {
  background: transparent;
  border: 1px solid rgba(255, 255, 255, 0.1);
  color: var(--mc-text-secondary);
}

.ss-cancel:hover {
  border-color: rgba(255, 255, 255, 0.2);
  color: var(--mc-text);
}

.deprecated-notice {
  text-align: center;
  padding: 16px 0;
}

.notice-icon {
  font-size: 24px;
  margin-bottom: 8px;
}

.deprecated-notice h3 {
  margin: 0 0 8px;
  font-size: 14px;
  color: var(--mc-text);
}

.deprecated-notice p {
  margin: 0 0 12px;
  font-size: 12px;
  color: var(--mc-text-secondary);
  line-height: 1.5;
}

.mini-btn {
  padding: 6px 12px;
  background: rgba(0, 229, 201, 0.1);
  border: 1px solid rgba(0, 229, 201, 0.2);
  border-radius: 6px;
  color: var(--mc-accent);
  font-size: 12px;
  cursor: pointer;
}

.hint-text {
  margin: 0;
  font-size: 11px;
  color: var(--mc-text-tertiary);
}
</style>
