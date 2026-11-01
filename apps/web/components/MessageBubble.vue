<template>
  <div class="message-bubble" :class="roleClass">
    <div class="message-content">
      <!-- 思考过程：默认折叠，流式思考中带呼吸点 -->
      <details v-if="thinking" class="thinking-block">
        <summary class="thinking-summary">
          <span class="thinking-label">Thinking</span>
          <span v-if="isStreaming" class="thinking-hint">正在思考…</span>
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

      <!-- 中断尾注（2026-11-01 P2）：已显示文本保留，只标状态，不吞内容 -->
      <p v-if="aborted" class="aborted-hint">已中断</p>

      <!-- 工具调用卡片 -->
      <details
        v-for="tool in toolCalls"
        :key="tool.toolCallId"
        class="tool-card"
        :class="`tool-${statusOf(tool)}`"
        :open="isToolExpanded(tool)"
        @toggle="onToolToggle(tool, $event)"
      >
        <summary class="tool-summary">
          <span class="tool-icon" aria-hidden="true">⚙</span>
          <span class="tool-name">{{ tool.name }}</span>
          <span class="tool-badge">{{ statusLabel(statusOf(tool)) }}</span>
        </summary>
        <pre class="tool-args">{{ formatArgs(tool.arguments) }}</pre>
        <!-- generate_image 结果：persisted:true 出图（nuxt 代理取流），persisted:false 出远端链接+note -->
        <div v-if="imageCards.get(tool.toolCallId)" class="tool-image-result">
          <template v-if="imageCards.get(tool.toolCallId)!.persisted">
            <img
              v-if="imageCards.get(tool.toolCallId)!.imageUrl && !imageFailed.has(tool.toolCallId)"
              class="tool-image"
              :src="imageCards.get(tool.toolCallId)!.imageUrl"
              :alt="imageCards.get(tool.toolCallId)!.path"
              @error="onImageError(tool.toolCallId)"
            />
            <div v-else class="tool-image-fallback">图片不可用：{{ imageCards.get(tool.toolCallId)!.path }}</div>
          </template>
          <template v-else>
            <a
              v-if="imageCards.get(tool.toolCallId)!.linkHref"
              class="tool-image-link"
              :href="imageCards.get(tool.toolCallId)!.linkHref"
              target="_blank"
              rel="noopener noreferrer"
              >查看生成图片（远端链接，可能有时效）</a
            >
            <span v-else class="tool-image-fallback">
              图片未落盘：{{ imageCards.get(tool.toolCallId)!.sourceUrl }}
            </span>
            <div v-if="imageCards.get(tool.toolCallId)!.note" class="tool-image-note">
              {{ imageCards.get(tool.toolCallId)!.note }}
            </div>
          </template>
          <div v-if="imageCards.get(tool.toolCallId)!.meta" class="tool-image-meta">
            {{ imageCards.get(tool.toolCallId)!.meta }}
          </div>
        </div>
      </details>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, watch, onBeforeUnmount } from "vue";
import type { DisplayToolCall, ToolCallStatus } from "@/composables/useChatRecords";

const props = withDefaults(
  defineProps<{
    role: "user" | "assistant" | "tool" | "system";
    text: string;
    thinking?: string;
    toolCalls?: DisplayToolCall[];
    isStreaming?: boolean;
    /** 本轮被中断结束（2026-11-01 P2）：终帧带 aborted.reason 时置位 */
    aborted?: boolean;
    /** 当前会话归属 agent（generate_image 出图经 /api/agent-file 代理取流时拼接用）；群聊按消息归属传 */
    agentId?: string;
  }>(),
  { thinking: "", toolCalls: () => [], isStreaming: false, agentId: "" },
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

// ---- 工具卡片折叠 ----
// 展开/收起状态按 toolCallId 记住：用户点过的以用户选择为准；
// 未点过的按状态取缺省——进行中（执行中/等待审批）默认展开便于实时观察，
// 完成/失败默认收起只留一行摘要（长 JSON 占半屏的 UI 诉求）
const toolExpanded = ref(new Map<string, boolean>());

function isToolExpanded(tool: DisplayToolCall): boolean {
  const explicit = toolExpanded.value.get(tool.toolCallId);
  if (explicit !== undefined) return explicit;
  const status = statusOf(tool);
  return status === "running" || status === "awaiting-approval";
}

function onToolToggle(tool: DisplayToolCall, event: Event) {
  const open = (event.target as HTMLDetailsElement).open;
  const next = new Map(toolExpanded.value);
  next.set(tool.toolCallId, open);
  toolExpanded.value = next;
}

function tick() {
  const target = props.text.length;
  if (displayedLen.value < target) {
    displayedLen.value = Math.min(target, displayedLen.value + CHARS_PER_FRAME);
  }
  // 追平即停；新内容到达时由 watch 重新启动，避免 60fps 空转
  rafId = displayedLen.value < props.text.length ? requestAnimationFrame(tick) : 0;
}

watch(
  () => [props.isStreaming, props.text.length],
  () => {
    cancelAnimationFrame(rafId);
    if (props.isStreaming) {
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

// ---- generate_image 工具卡渲染 ----
// 按 output 形状特判（plan 阶段 2-3）：persisted:true + files/images/ 路径 →
// 经 /api/agent-file 代理出图；persisted:false + sourceUrl → 远端链接 + note。
// model/size 可为 undefined（缺省未传时引擎不携带），有才展示。
interface GenerateImageOutput {
  persisted: boolean;
  path?: string;
  sourceUrl?: string;
  note?: string;
  model?: string;
  size?: string;
}

interface ImageCardView extends GenerateImageOutput {
  /** 仅 persisted 且有会话 agentId 时拼出；缺 agentId 退化为路径文本兜底 */
  imageUrl?: string;
  /** sourceUrl 过 scheme 白名单（^https?://）才产出；否则退化为纯文本展示 */
  linkHref?: string;
  meta: string;
}

function parseGenerateImageOutput(output: unknown): GenerateImageOutput | null {
  if (typeof output !== "object" || output === null) return null;
  let o = output as Record<string, unknown>;
  // tool.result 帧/历史 tool 消息的载荷是整个 ToolResult 壳（{success, output}——
  // engine tool-call.ts 把 execute 返回值原样透传进帧）：先拆壳再判内层形状；
  // 内层形状直喂兼容保留（防御/测试桩）
  if (o.success === true && typeof o.output === "object" && o.output !== null) {
    o = o.output as Record<string, unknown>;
  }
  const base = {
    ...(typeof o.model === "string" ? { model: o.model } : {}),
    ...(typeof o.size === "string" ? { size: o.size } : {}),
  };
  if (o.persisted === true && typeof o.path === "string" && o.path.startsWith("files/images/")) {
    return { persisted: true, path: o.path, ...base };
  }
  if (o.persisted === false && typeof o.sourceUrl === "string") {
    return {
      persisted: false,
      sourceUrl: o.sourceUrl,
      ...(typeof o.note === "string" ? { note: o.note } : {}),
      ...base,
    };
  }
  return null;
}

const imageCards = computed(() => {
  const map = new Map<string, ImageCardView>();
  for (const tool of props.toolCalls) {
    const parsed = parseGenerateImageOutput(tool.output);
    if (!parsed) continue;
    map.set(tool.toolCallId, {
      ...parsed,
      meta: [parsed.model, parsed.size].filter(Boolean).join(" · "),
      ...(parsed.persisted && parsed.path && props.agentId
        ? {
            imageUrl: `/api/agent-file?agentId=${encodeURIComponent(props.agentId)}&path=${encodeURIComponent(parsed.path)}`,
          }
        : {}),
      ...(parsed.sourceUrl && /^https?:\/\//.test(parsed.sourceUrl)
        ? { linkHref: parsed.sourceUrl }
        : {}),
    });
  }
  return map;
});

// 加载失败（代理 404/415/断网）按 toolCallId 记名，退化为路径文本兜底
const imageFailed = ref(new Set<string>());
function onImageError(toolCallId: string) {
  const next = new Set(imageFailed.value);
  next.add(toolCallId);
  imageFailed.value = next;
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
  background: var(--mc-panel);
  color: #d8e1ec;
}
.message-text {
  white-space: pre-wrap;
  word-break: break-word;
  margin: 0;
}
/* 中断尾注（2026-11-01 P2）：弱化到辅助信息层，不与正文争注意力 */
.aborted-hint {
  margin: 6px 0 0;
  font-size: 11px;
  font-style: italic;
  opacity: 0.6;
  color: inherit;
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
.thinking-hint {
  font-style: normal;
  opacity: 0.8;
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
  border: 1px solid var(--mc-border);
  border-radius: 8px;
  background: rgba(0, 0, 0, 0.2);
  font-size: 12px;
  overflow: hidden;
}
.tool-summary {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 10px;
  cursor: pointer;
  user-select: none;
  list-style: none;
}
.tool-summary::-webkit-details-marker {
  display: none;
}
.tool-summary::before {
  content: "▸";
  font-size: 10px;
  color: #8899aa;
  transition: transform 0.15s;
}
.tool-card[open] .tool-summary::before {
  transform: rotate(90deg);
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
  background: var(--mc-panel);
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
  border-top: 1px solid var(--mc-panel);
  font-family: monospace;
  font-size: 11px;
  line-height: 1.5;
  color: #8899aa;
  white-space: pre-wrap;
  word-break: break-word;
  max-height: 200px;
  overflow-y: auto;
}

/* ---- generate_image 工具卡出图 ---- */
.tool-image-result {
  padding: 8px 10px;
  border-top: 1px solid var(--mc-panel);
}
.tool-image {
  display: block;
  max-width: 100%;
  max-height: 320px;
  border-radius: 6px;
}
.tool-image-fallback {
  color: #8899aa;
  font-size: 11px;
  word-break: break-all;
}
.tool-image-link {
  color: var(--mc-accent, #00e5c9);
  word-break: break-all;
}
.tool-image-note {
  margin-top: 4px;
  color: #e8b86a;
  font-size: 11px;
}
.tool-image-meta {
  margin-top: 4px;
  color: var(--mc-text-tertiary, #5a6a7a);
  font-size: 10px;
  font-family: monospace;
}
</style>
