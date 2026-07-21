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
    <div ref="messagesEl" class="messages">
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
        <div v-else class="msg-row">
          <div v-if="msg.role === 'assistant' && msg.agentId" class="speaker">
            @{{ agentName(msg.agentId) }}
          </div>
          <MessageBubble
            :role="msg.role"
            :text="msg.text"
            :thinking="msg.thinking"
            :tool-calls="msg.toolCalls"
            :is-streaming="msg.isStreaming"
          />
        </div>
      </template>
    </div>
    <div class="status">{{ statusText }}</div>
    <MessageInput :is-loading="isStreaming" @send="onSend" />
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch, nextTick } from "vue";
import ApprovalCard from "./ApprovalCard.vue";
import MessageBubble from "./MessageBubble.vue";
import MessageInput from "./MessageInput.vue";
import type { Session } from "@/composables/useEngineClient";
import type { DisplayMessage } from "@/composables/useChatRecords";
import type { ApprovalResponsePayload } from "@/utils/approval";
import type { AgentConfig } from "@mindcloud/shared";

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

const messagesEl = ref<HTMLElement | null>(null);

const statusText = computed(() => {
  if (!props.isConnected) return "未连接";
  if (props.isStreaming) return "生成中...";
  return "已连接";
});

// 新消息/流式增量时自动滚动到底部（与 ChatView 同一口径）
watch(
  () => [
    props.messages.length,
    props.messages[props.messages.length - 1]?.text,
    props.messages[props.messages.length - 1]?.thinking,
  ],
  async () => {
    await nextTick();
    const el = messagesEl.value;
    if (el) el.scrollTop = el.scrollHeight;
  },
);

function agentName(agentId: string): string {
  return props.agents.find((a) => a.id === agentId)?.name || agentId;
}

function onSend(text: string) {
  emit("send", text);
}

function onApprovalRespond(payload: ApprovalResponsePayload) {
  emit("approval-respond", payload);
}
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
.speaker {
  font-size: 12px;
  color: var(--mc-accent);
  margin: 8px 0 2px;
  opacity: 0.8;
}
.status {
  padding: 4px 12px;
  font-size: 12px;
  color: #8899aa;
}
</style>
