<template>
  <div class="message-bubble" :class="roleClass">
    <div class="message-content">
      <!-- 思考过程：默认折叠，流式思考中带呼吸点 -->
      <details v-if="thinking" class="thinking-block">
        <summary class="thinking-summary">
          <span class="thinking-label">Thinking</span>
          <span v-if="isStreaming" class="thinking-dots" aria-hidden="true">
            <span /><span /><span />
          </span>
        </summary>
        <pre class="thinking-body">{{ thinking }}</pre>
      </details>

      <!-- 正文：流式时打字机追赶 + 光标闪烁 -->
      <p v-if="displayedText || showCursor" class="message-text">
        {{ displayedText }}<span v-if="showCursor" class="cursor" aria-hidden="true" />
      </p>

      <!-- 工具调用卡片 -->
      <div
        v-for="tool in toolCalls"
        :key="tool.toolCallId"
        class="tool-card"
        :class="`tool-${statusOf(tool)}`"
      >
        <div class="tool-header">
          <span class="tool-icon" aria-hidden="true">⚙</span>
          <span class="tool-name">{{ tool.name }}</span>
          <span class="tool-badge">{{ statusLabel(statusOf(tool)) }}</span>
        </div>
        <pre class="tool-args">{{ formatArgs(tool.arguments) }}</pre>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, watch, onBeforeUnmount } from "vue";
import type { DisplayToolCall, ToolCallStatus } from "@/composables/useChatRecords";

const props = withDefaults(
  defineProps<{
    role: "user" | "assistant" | "tool";
    text: string;
    thinking?: string;
    toolCalls?: DisplayToolCall[];
    isStreaming?: boolean;
  }>(),
  { thinking: "", toolCalls: () => [], isStreaming: false },
);

const roleClass = computed(() => `role-${props.role}`);

// ---- 打字机 ----
// 流式期间用 rAF 让"已显示长度"追赶真实文本长度，非流式直接全量显示。
// 每帧 3 字符 ≈ 180 字符/秒，接近自然阅读速度；大 delta 也能在几帧内追上。
const CHARS_PER_FRAME = 3;
const displayedLen = ref(props.isStreaming ? 0 : props.text.length);
let rafId = 0;

const displayedText = computed(() =>
  props.isStreaming ? props.text.slice(0, displayedLen.value) : props.text,
);
const showCursor = computed(() => props.role === "assistant" && props.isStreaming);

function tick() {
  const target = props.text.length;
  if (displayedLen.value < target) {
    displayedLen.value = Math.min(target, displayedLen.value + CHARS_PER_FRAME);
  }
  rafId = requestAnimationFrame(tick);
}

watch(
  () => props.isStreaming,
  (streaming) => {
    cancelAnimationFrame(rafId);
    if (streaming) {
      rafId = requestAnimationFrame(tick);
    } else {
      displayedLen.value = props.text.length;
    }
  },
  { immediate: true },
);

onBeforeUnmount(() => cancelAnimationFrame(rafId));

// ---- 工具调用状态 ----
function statusOf(tool: DisplayToolCall): ToolCallStatus {
  return tool.status ?? (props.isStreaming ? "running" : "done");
}

function statusLabel(status: ToolCallStatus): string {
  switch (status) {
    case "running":
      return "执行中";
    case "awaiting-approval":
      return "等待审批";
    case "done":
      return "已完成";
  }
}

function formatArgs(args: unknown): string {
  if (typeof args === "string") return args;
  try {
    return JSON.stringify(args, null, 2) ?? "";
  } catch {
    return String(args);
  }
}
</script>

<style scoped>
.message-bubble {
  display: flex;
  margin: 8px 0;
}
.role-user {
  justify-content: flex-end;
}
.role-user .message-content {
  background: rgba(0, 229, 201, 0.15);
}
.message-content {
  max-width: 80%;
  padding: 10px 14px;
  border-radius: 12px;
  background: rgba(255, 255, 255, 0.06);
  color: #d8e1ec;
}
.message-text {
  white-space: pre-wrap;
  word-break: break-word;
  margin: 0;
}
/* 工具结果消息弱化显示，避免与用户/助手气泡混淆 */
.role-tool .message-content {
  background: rgba(255, 255, 255, 0.03);
  color: #8899aa;
  font-size: 12px;
}

/* ---- 打字机光标 ---- */
.cursor {
  display: inline-block;
  width: 8px;
  height: 1.05em;
  margin-left: 2px;
  vertical-align: text-bottom;
  background: var(--mc-accent, #00e5c9);
  animation: cursor-blink 1s steps(1) infinite;
}
@keyframes cursor-blink {
  50% {
    opacity: 0;
  }
}

/* ---- 思考块 ---- */
.thinking-block {
  margin-bottom: 8px;
  border-left: 2px solid rgba(136, 153, 170, 0.35);
  padding-left: 10px;
  font-size: 12px;
  color: #8899aa;
}
.thinking-summary {
  display: flex;
  align-items: center;
  gap: 6px;
  cursor: pointer;
  user-select: none;
  list-style: none;
  padding: 2px 0;
  transition: color 0.15s;
}
.thinking-summary::-webkit-details-marker {
  display: none;
}
.thinking-summary::before {
  content: "▸";
  font-size: 10px;
  transition: transform 0.15s;
}
.thinking-block[open] .thinking-summary::before {
  transform: rotate(90deg);
}
.thinking-summary:hover {
  color: #d8e1ec;
}
.thinking-label {
  font-style: italic;
}
.thinking-dots {
  display: inline-flex;
  gap: 3px;
}
.thinking-dots span {
  width: 4px;
  height: 4px;
  border-radius: 50%;
  background: currentColor;
  animation: thinking-pulse 1.2s ease-in-out infinite;
}
.thinking-dots span:nth-child(2) {
  animation-delay: 0.2s;
}
.thinking-dots span:nth-child(3) {
  animation-delay: 0.4s;
}
@keyframes thinking-pulse {
  0%,
  100% {
    opacity: 0.25;
  }
  50% {
    opacity: 1;
  }
}
.thinking-body {
  margin: 6px 0 2px;
  white-space: pre-wrap;
  word-break: break-word;
  font-family: inherit;
  line-height: 1.5;
}

/* ---- 工具调用卡片 ---- */
.tool-card {
  margin-top: 8px;
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: 8px;
  background: rgba(0, 0, 0, 0.2);
  font-size: 12px;
  overflow: hidden;
}
.tool-header {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 10px;
}
.tool-icon {
  color: var(--mc-accent, #00e5c9);
  font-size: 13px;
}
.tool-name {
  color: var(--mc-accent, #00e5c9);
  font-family: monospace;
  flex: 1;
}
.tool-badge {
  font-size: 10px;
  padding: 2px 8px;
  border-radius: 4px;
  background: rgba(255, 255, 255, 0.06);
  color: #8899aa;
}
.tool-running .tool-badge {
  color: var(--mc-accent, #00e5c9);
  background: rgba(0, 229, 201, 0.1);
  animation: badge-pulse 1.4s ease-in-out infinite;
}
@keyframes badge-pulse {
  0%,
  100% {
    opacity: 0.5;
  }
  50% {
    opacity: 1;
  }
}
/* 审批中的工具调用高亮 */
.tool-awaiting-approval {
  border-color: rgba(245, 158, 11, 0.45);
  background: rgba(245, 158, 11, 0.08);
}
.tool-awaiting-approval .tool-badge {
  color: var(--mc-warning, #f59e0b);
  background: rgba(245, 158, 11, 0.15);
}
.tool-done .tool-badge {
  color: var(--mc-success, #10b981);
  background: rgba(16, 185, 129, 0.1);
}
.tool-args {
  margin: 0;
  padding: 8px 10px;
  border-top: 1px solid rgba(255, 255, 255, 0.06);
  font-family: monospace;
  font-size: 11px;
  line-height: 1.5;
  color: #8899aa;
  white-space: pre-wrap;
  word-break: break-word;
  max-height: 200px;
  overflow-y: auto;
}
</style>
