<template>
  <div class="approval-card" :class="`status-${status}`">
    <div class="approval-header">
      <span class="approval-icon">⚠</span>
      <span class="approval-title">
        危险操作审批<template v-if="agentName">（{{ agentName }}）</template>
      </span>
      <span class="approval-status">{{ statusText }}</span>
    </div>
    <div class="approval-body">
      <div class="approval-tool">{{ toolName }}</div>
      <div v-for="field in argFields" :key="field.label" class="approval-field">
        <div class="approval-field-label">{{ field.label }}</div>
        <pre class="approval-args" :class="{ scrollable: isExpanded(field.label) }">{{ displayText(field) }}</pre>
        <button
          v-if="field.text.length > ARGS_LIMIT"
          class="approval-fold-toggle"
          type="button"
          @click="toggle(field.label)"
        >
          {{
            isExpanded(field.label)
              ? "收起"
              : `参数共 ${field.text.length} 字符，已折叠中段、显示首尾两段，点击展开全文`
          }}
        </button>
      </div>
    </div>
    <div class="approval-actions">
      <button class="approval-btn approve" :disabled="status !== 'pending'" @click="onRespond(true, false)">
        允许
      </button>
      <button class="approval-btn deny" :disabled="status !== 'pending'" @click="onRespond(false, false)">
        拒绝
      </button>
      <button
        class="approval-btn remember"
        :disabled="status !== 'pending' || !rememberAllowed"
        :title="rememberAllowed ? '' : '该工具每次都需要人工确认'"
        @click="onRespond(true, true)"
      >
        本会话不再询问
      </button>
      <span v-if="!rememberAllowed" class="approval-hint">该工具每次都需要确认</span>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from "vue";
import { isApprovalRememberable, type ApprovalStatus, type ApprovalResponsePayload } from "@/utils/approval";

const props = defineProps<{
  approvalId: string;
  toolName: string;
  args: unknown;
  status: ApprovalStatus;
  agentName?: string;
}>();

const emit = defineEmits<{
  (e: "respond", payload: ApprovalResponsePayload): void;
}>();

// run_command 等裸执行工具不允许"本会话不再询问"（引擎侧同样拒绝记忆）
const rememberAllowed = computed(() => isApprovalRememberable(props.toolName));

// 单字段折叠阈值：超出默认只显示尾部（危险内容藏在尾部，安全 review Major-2），
// 点击可展开全文。不再是 300 字符 JSON 摘要一刀切（write_file 的 content、
// run_command 的 command 都必须全文可审）
const ARGS_LIMIT = 300;

interface ArgField {
  label: string;
  text: string;
}

// 按工具参数结构分字段展示，关键字段（command/content/path）各自独立可审
const argFields = computed<ArgField[]>(() => {
  const a = props.args;
  if (a && typeof a === "object" && !Array.isArray(a)) {
    const obj = a as Record<string, unknown>;
    if (props.toolName === "run_command" || props.toolName === "bash") {
      return [{ label: "command", text: String(obj.command ?? "") }];
    }
    if (props.toolName === "write_file") {
      return [
        { label: "path", text: String(obj.path ?? "") },
        { label: "content", text: String(obj.content ?? "") },
      ];
    }
    if (props.toolName === "edit_file") {
      return [
        { label: "path", text: String(obj.path ?? "") },
        { label: "oldString", text: String(obj.oldString ?? "") },
        { label: "newString", text: String(obj.newString ?? "") },
      ];
    }
    if (props.toolName === "dispatch_subagent") {
      // P2-5：派生审批的可审性——目标 agent 与任务内容分字段独立可审
      return [
        { label: "目标 agent", text: String(obj.agentId ?? "") },
        { label: "task", text: String(obj.task ?? "") },
        { label: "mode", text: String(obj.mode ?? "foreground") },
      ];
    }
  }
  // 其他工具/异常结构：完整 JSON（长文本同样按尾部折叠）
  let json = "";
  try {
    json = JSON.stringify(props.args, null, 2) ?? "";
  } catch {
    json = String(props.args);
  }
  return [{ label: "arguments", text: json }];
});

// 折叠状态（默认折叠=显示尾部）：用户不点任何操作就能看到命令/内容末尾
const expandedFields = ref<Set<string>>(new Set());

function isExpanded(label: string): boolean {
  return expandedFields.value.has(label);
}

function toggle(label: string): void {
  const next = new Set(expandedFields.value);
  if (next.has(label)) {
    next.delete(label);
  } else {
    next.add(label);
  }
  expandedFields.value = next;
}

function displayText(field: ArgField): string {
  if (isExpanded(field.label) || field.text.length <= ARGS_LIMIT) return field.text;
  // 头+尾双段（P2 review Major-1）：只显示尾部会把藏匿点倒置到头部/中段——
  // "无害前缀+危险尾巴"与"危险头部+无害尾巴"在默认视图都必须可见；
  // 中段仍折叠，但按钮明示总字符数与折叠范围，可一键展开全文
  const half = Math.floor(ARGS_LIMIT / 2);
  return field.text.slice(0, half) + "\n…（中段已折叠）…\n" + field.text.slice(-half);
}

const statusText = computed(() => {
  switch (props.status) {
    case "approved":
      return "已允许";
    case "denied":
      return "已拒绝";
    case "expired":
      return "已超时或已处理";
    default:
      return "等待审批";
  }
});

// 防重复回执由 store 侧保证（findPendingApproval + 同步 settleApproval）。
// 组件本地不加闩锁：回执发送失败时卡片保持 pending 可重试，
// 闩锁一旦先于结果置位会把卡片锁成"请重试但点不动"的死态
function onRespond(approved: boolean, remember: boolean) {
  if (props.status !== "pending") return;
  emit("respond", { approvalId: props.approvalId, approved, remember });
}
</script>

<style scoped>
.approval-card {
  margin: 8px 0;
  max-width: 80%;
  padding: 10px 14px;
  border-radius: 12px;
  background: rgba(245, 158, 11, 0.08);
  border: 1px solid rgba(245, 158, 11, 0.35);
  color: var(--mc-text);
}
.approval-card.status-approved {
  background: rgba(16, 185, 129, 0.08);
  border-color: rgba(16, 185, 129, 0.3);
}
.approval-card.status-denied,
.approval-card.status-expired {
  background: var(--mc-panel);
  border-color: var(--mc-border);
  opacity: 0.75;
}
.approval-header {
  display: flex;
  align-items: center;
  gap: 6px;
}
.approval-icon {
  color: var(--mc-warning);
}
.approval-title {
  flex: 1;
  font-size: 13px;
  font-weight: 500;
}
.approval-status {
  font-size: 11px;
  color: var(--mc-text-secondary);
}
.approval-body {
  margin-top: 8px;
  font-size: 12px;
  background: rgba(0, 0, 0, 0.2);
  padding: 8px;
  border-radius: 6px;
}
.approval-tool {
  color: var(--mc-accent);
  margin-bottom: 4px;
}
.approval-args {
  margin: 0;
  white-space: pre-wrap;
  word-break: break-all;
  color: var(--mc-text-secondary);
}
.approval-args.scrollable {
  max-height: 320px;
  overflow-y: auto;
}
.approval-field {
  margin-top: 4px;
}
.approval-field-label {
  font-size: 11px;
  color: var(--mc-text-tertiary);
  margin-bottom: 2px;
}
.approval-fold-toggle {
  margin-top: 4px;
  padding: 2px 8px;
  border-radius: 4px;
  font-size: 11px;
  cursor: pointer;
  background: rgba(255, 255, 255, 0.04);
  border: 1px solid var(--mc-border);
  color: var(--mc-accent);
}
.approval-actions {
  margin-top: 10px;
  display: flex;
  gap: 8px;
}
.approval-btn {
  padding: 5px 12px;
  border-radius: 6px;
  font-size: 12px;
  cursor: pointer;
  background: rgba(255, 255, 255, 0.04);
  border: 1px solid var(--mc-border);
  color: var(--mc-text-secondary);
  transition: all 0.15s;
}
.approval-btn.approve {
  background: rgba(0, 229, 201, 0.12);
  border-color: rgba(0, 229, 201, 0.3);
  color: var(--mc-accent);
}
.approval-btn.approve:hover:not(:disabled) {
  background: rgba(0, 229, 201, 0.2);
}
.approval-btn.deny {
  background: rgba(239, 68, 68, 0.1);
  border-color: rgba(239, 68, 68, 0.3);
  color: var(--mc-danger);
}
.approval-btn.deny:hover:not(:disabled) {
  background: rgba(239, 68, 68, 0.18);
}
.approval-btn.remember:hover:not(:disabled) {
  border-color: rgba(0, 229, 201, 0.3);
  color: var(--mc-accent);
}
.approval-hint {
  align-self: center;
  font-size: 11px;
  color: var(--mc-text-tertiary);
}
.approval-btn:disabled {
  cursor: not-allowed;
  opacity: 0.5;
}
</style>
