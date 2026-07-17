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
      <pre class="approval-args">{{ argsSummary }}</pre>
    </div>
    <div class="approval-actions">
      <button class="approval-btn approve" :disabled="status !== 'pending'" @click="onRespond(true, false)">
        允许
      </button>
      <button class="approval-btn deny" :disabled="status !== 'pending'" @click="onRespond(false, false)">
        拒绝
      </button>
      <button class="approval-btn remember" :disabled="status !== 'pending'" @click="onRespond(true, true)">
        本会话不再询问
      </button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from "vue";
import type { ApprovalStatus, ApprovalResponsePayload } from "@/utils/approval";

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

// 参数摘要最大长度，超出截断
const ARGS_LIMIT = 300;

const argsSummary = computed(() => {
  let json = "";
  try {
    json = JSON.stringify(props.args);
  } catch {
    json = String(props.args);
  }
  if (json.length > ARGS_LIMIT) return json.slice(0, ARGS_LIMIT) + "…";
  return json;
});

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
.approval-btn:disabled {
  cursor: not-allowed;
  opacity: 0.5;
}
</style>
