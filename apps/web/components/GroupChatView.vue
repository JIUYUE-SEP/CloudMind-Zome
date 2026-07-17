<template>
  <div class="group-chat-view">
    <header class="session-header">
      <h2>{{ session?.name || "群聊" }}</h2>
      <div class="members">
        成员：
        <span v-for="agentId in session?.agentIds" :key="agentId" class="member">
          @{{ agentName(agentId) }}
        </span>
      </div>
    </header>
    <div class="messages">
      <template v-for="msg in messages" :key="msg.id">
        <ApprovalCard
          v-if="msg.approval"
          :approval-id="msg.approval.approvalId"
          :tool-name="msg.approval.toolName"
          :args="msg.approval.arguments"
          :status="msg.approval.status"
          :agent-name="msg.approval.agentId ? agentName(msg.approval.agentId) : undefined"
          @respond="onApprovalRespond"
        />
        <MessageBubble
          v-else
          :role="msg.role"
          :text="msg.text"
          :thinking="msg.thinking"
          :tool-calls="msg.toolCalls"
        />
      </template>
    </div>
    <div class="status">{{ statusText }}</div>
    <MessageInput :is-loading="isStreaming" @send="onSend" />
  </div>
</template>

<script setup lang="ts">
import { computed } from "vue";
import ApprovalCard from "./ApprovalCard.vue";
import MessageBubble from "./MessageBubble.vue";
import MessageInput from "./MessageInput.vue";
import type { Session, ChatMessageRecord } from "@/composables/useEngineClient";
import type { ApprovalInfo, ApprovalResponsePayload } from "@/utils/approval";
import type { AgentConfig } from "@mindcloud/shared";

export interface DisplayMessage {
  id: string;
  role: "user" | "assistant" | "tool";
  text: string;
  thinking: string;
  toolCalls: { toolCallId: string; name: string; arguments: unknown }[];
  isStreaming: boolean;
  approval?: ApprovalInfo;
}

const props = defineProps<{
  session: Session | undefined;
  messages: DisplayMessage[];
  agents: AgentConfig[];
  isConnected: boolean;
  isStreaming: boolean;
}>();

const emit = defineEmits<{
  (e: "send", text: string): void;
  (e: "approval-respond", payload: ApprovalResponsePayload): void;
}>();

const statusText = computed(() => {
  if (!props.isConnected) return "未连接";
  if (props.isStreaming) return "生成中...";
  return "已连接";
});

function agentName(agentId: string): string {
  return props.agents.find((a) => a.id === agentId)?.name || agentId;
}

function onSend(text: string) {
  emit("send", text);
}

function onApprovalRespond(payload: ApprovalResponsePayload) {
  emit("approval-respond", payload);
}

function recordsToDisplay(records: ChatMessageRecord[]): DisplayMessage[] {
  return records.map((r) => ({
    id: r.id,
    role: r.role,
    text: r.content.filter((c): c is { type: "text"; text: string } => c.type === "text").map((c) => c.text).join(""),
    thinking: r.content.filter((c): c is { type: "think"; think: string } => c.type === "think").map((c) => c.think).join(""),
    toolCalls: r.toolCalls || [],
    isStreaming: false,
  }));
}

defineExpose({ recordsToDisplay });
</script>

<style scoped>
.group-chat-view {
  display: flex;
  flex-direction: column;
  height: 100%;
}
.session-header {
  padding: 12px 16px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.08);
}
.session-header h2 {
  margin: 0 0 4px;
  font-size: 16px;
}
.members {
  font-size: 12px;
  color: #8899aa;
}
.member {
  margin-right: 8px;
}
.messages {
  flex: 1;
  overflow-y: auto;
  padding: 16px;
}
.status {
  padding: 4px 12px;
  font-size: 12px;
  color: #8899aa;
}
</style>
