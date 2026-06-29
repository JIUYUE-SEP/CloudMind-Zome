<template>
  <div
    v-if="visible"
    ref="panelRef"
    class="log-panel"
    :class="{ dragging }"
    :style="panelStyle"
    @click.stop
    @mousedown="onMouseDown"
  >
    <div class="log-title">系统日志</div>
    <div ref="logListRef" class="log-list">
      <div v-for="log in logs" :key="log.id" class="log-item" :class="log.type">
        <span class="log-time">{{ log.time }}</span>
        <span class="log-source">{{ log.source }}</span>
        <span class="log-msg">{{ log.message }}</span>
      </div>
      <div v-if="!logs.length" class="log-empty">暂无日志</div>
    </div>
    <div class="log-actions">
      <button class="log-clear" @click="clearLogs">清空</button>
      <button class="log-refresh" @click="pushLog({ type: 'info', source: '系统', message: '手动刷新' })">刷新</button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch, nextTick, onMounted, onBeforeUnmount } from "vue";

export interface LogEntry {
  id: string;
  type: "info" | "success" | "warn" | "error";
  source: string;
  message: string;
  time: string;
}

const props = defineProps<{ visible: boolean }>();

const STORAGE_KEY = "mc-system-logs";

const panelRef = ref<HTMLElement>();
const logListRef = ref<HTMLElement>();
const dragging = ref(false);
const dragOffset = ref({ x: 0, y: 0 });
const dragPos = ref({ x: 0, y: 0 });
const panelStyle = computed(() => ({
  transform: `translate(${dragPos.value.x}px, ${dragPos.value.y}px)`,
}));

const logs = ref<LogEntry[]>([]);

onMounted(() => {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      logs.value = JSON.parse(raw);
    }
  } catch {
    logs.value = [];
  }
  pushLog({ type: "info", source: "系统", message: "Zome 已启动" });
});

onBeforeUnmount(() => {
  persist();
});

watch(
  () => props.visible,
  (v) => {
    if (v) {
      scrollToBottom();
    }
  },
);

watch(
  logs,
  () => {
    persist();
    nextTick(scrollToBottom);
  },
  { deep: true },
);

function persist() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(logs.value.slice(-200)));
  } catch {
    // ignore storage errors
  }
}

function pushLog(entry: Omit<LogEntry, "id" | "time">) {
  logs.value.push({
    ...entry,
    id: `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    time: new Date().toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", second: "2-digit" }),
  });
}

function clearLogs() {
  logs.value = [];
}

function scrollToBottom() {
  logListRef.value?.scrollTo({ top: logListRef.value.scrollHeight, behavior: "smooth" });
}

function onMouseDown(e: MouseEvent) {
  const target = e.target as HTMLElement;
  if (!target.classList.contains("log-title")) return;
  dragging.value = true;
  dragOffset.value = {
    x: e.clientX - dragPos.value.x,
    y: e.clientY - dragPos.value.y,
  };
  document.body.style.userSelect = "none";
  document.addEventListener("mousemove", onMouseMove);
  document.addEventListener("mouseup", onMouseUp);
}

function onMouseMove(e: MouseEvent) {
  if (!dragging.value) return;
  dragPos.value = {
    x: e.clientX - dragOffset.value.x,
    y: e.clientY - dragOffset.value.y,
  };
}

function onMouseUp() {
  dragging.value = false;
  document.body.style.userSelect = "";
  document.removeEventListener("mousemove", onMouseMove);
  document.removeEventListener("mouseup", onMouseUp);
}

defineExpose({ pushLog });
</script>

<style scoped>
.log-panel {
  position: absolute;
  bottom: 120px;
  right: 68px;
  width: 320px;
  max-height: 420px;
  padding: 14px;
  background: rgba(11, 15, 23, 0.88);
  backdrop-filter: blur(16px);
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: 12px;
  z-index: 120;
  color: var(--mc-text);
  display: flex;
  flex-direction: column;
}

.log-title {
  font-size: 13px;
  font-weight: 600;
  margin-bottom: 10px;
  cursor: grab;
  user-select: none;
  flex-shrink: 0;
}

.log-panel.dragging .log-title {
  cursor: grabbing;
}

.log-list {
  flex: 1;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 6px;
  font-size: 11px;
  line-height: 1.45;
  padding-right: 4px;
}

.log-list::-webkit-scrollbar {
  width: 4px;
}

.log-list::-webkit-scrollbar-thumb {
  background: rgba(255, 255, 255, 0.1);
  border-radius: 2px;
}

.log-item {
  display: flex;
  gap: 6px;
  padding: 4px 6px;
  border-radius: 4px;
  background: rgba(255, 255, 255, 0.03);
}

.log-time {
  color: var(--mc-text-tertiary);
  white-space: nowrap;
  flex-shrink: 0;
}

.log-source {
  color: var(--mc-text-secondary);
  white-space: nowrap;
  flex-shrink: 0;
  min-width: 40px;
}

.log-msg {
  color: var(--mc-text);
  word-break: break-word;
}

.log-item.success .log-msg {
  color: var(--mc-success);
}

.log-item.warn .log-msg {
  color: var(--mc-warning);
}

.log-item.error .log-msg {
  color: var(--mc-danger);
}

.log-item.info .log-msg {
  color: var(--mc-accent);
}

.log-empty {
  color: var(--mc-text-tertiary);
  text-align: center;
  padding: 20px 0;
}

.log-actions {
  display: flex;
  gap: 8px;
  margin-top: 10px;
  flex-shrink: 0;
}

.log-actions button {
  flex: 1;
  padding: 6px;
  background: rgba(255, 255, 255, 0.06);
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: 6px;
  color: var(--mc-text-secondary);
  font-size: 12px;
  cursor: pointer;
  transition: all 0.15s;
}

.log-actions button:hover {
  background: rgba(0, 229, 201, 0.12);
  border-color: rgba(0, 229, 201, 0.25);
  color: var(--mc-accent);
}
</style>
