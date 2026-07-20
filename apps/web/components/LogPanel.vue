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
      <button class="log-refresh" @click="refresh">刷新</button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch, nextTick } from "vue";
import { useEngineClient, type EngineLogEntry } from "@/composables/useEngineClient";

export interface LogEntry {
  id: string;
  type: "info" | "success" | "warn" | "error";
  source: string;
  message: string;
  time: string;
}

const props = defineProps<{ visible: boolean }>();

const client = useEngineClient();

const panelRef = ref<HTMLElement>();
const logListRef = ref<HTMLElement>();
const dragging = ref(false);
const dragOffset = ref({ x: 0, y: 0 });
const dragPos = ref({ x: 0, y: 0 });
const panelStyle = computed(() => ({
  transform: `translate(${dragPos.value.x}px, ${dragPos.value.y}px)`,
}));

const logs = ref<LogEntry[]>([]);
// 同一条日志可能被重复拉取，用 time+msg 去重
const seen = new Set<string>();
let entrySeq = 0;
let loading = false;

// pino level: 10 trace / 20 debug / 30 info / 40 warn / 50 error / 60 fatal
function levelToType(level: number): LogEntry["type"] {
  if (level >= 50) return "error";
  if (level >= 40) return "warn";
  return "info";
}

function levelToSource(level: number): string {
  if (level >= 60) return "FATAL";
  if (level >= 50) return "ERROR";
  if (level >= 40) return "WARN";
  if (level >= 30) return "INFO";
  return "DEBUG";
}

function toDisplay(entry: EngineLogEntry): LogEntry {
  return {
    id: `${entry.time}_${entrySeq++}`,
    type: levelToType(entry.level),
    source: levelToSource(entry.level),
    message: entry.msg,
    time: new Date(entry.time).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", second: "2-digit" }),
  };
}

async function refresh() {
  if (loading) return;
  loading = true;
  try {
    const entries = await client.getLogs(200);
    for (const entry of entries) {
      const key = `${entry.time}:${entry.level}:${entry.msg}`;
      if (seen.has(key)) continue;
      seen.add(key);
      logs.value.push(toDisplay(entry));
    }
  } catch (err) {
    pushLocal({
      type: "error",
      source: "系统",
      message: `日志加载失败：${err instanceof Error ? err.message : String(err)}`,
    });
  } finally {
    loading = false;
  }
}

function pushLocal(entry: Omit<LogEntry, "id" | "time">) {
  logs.value.push({
    ...entry,
    id: `local_${entrySeq++}`,
    time: new Date().toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", second: "2-digit" }),
  });
}

function clearLogs() {
  logs.value = [];
  seen.clear();
}

function scrollToBottom() {
  logListRef.value?.scrollTo({ top: logListRef.value.scrollHeight, behavior: "smooth" });
}

watch(
  () => props.visible,
  (v) => {
    if (v) {
      void refresh();
      scrollToBottom();
    }
  },
);

watch(
  logs,
  () => {
    nextTick(scrollToBottom);
  },
  { deep: true },
);

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
</script>

<style scoped>
.log-panel {
  position: absolute;
  bottom: 120px;
  /* 右侧导航条（.right-nav 宽 180px）在布局层 stacking context 中压在本面板之上，
     默认位置必须避开它，否则面板右半部分点击不到 */
  right: 200px;
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
