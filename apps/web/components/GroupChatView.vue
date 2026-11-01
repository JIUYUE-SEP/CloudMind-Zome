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
      <div v-if="loadingOlder" class="load-older">加载中…</div>
      <button v-else-if="hasMoreHistory" type="button" class="load-older" @click="handleLoadOlder">加载更早</button>
      <div v-else-if="messages.length" class="load-older done">没有更早的消息了</div>
      <template v-for="msg in messages" :key="msg.id">
        <ApprovalCard
          v-if="msg.approval"
          :approval-id="msg.approval.approvalId"
          :tool-name="msg.approval.toolName"
          :args="msg.approval.arguments"
          :status="msg.approval.status"
          :agent-name="msg.approval.agentId ? agentName(msg.approval.agentId) : undefined"
          @respond="onApprovalRespond"
          @expired="onApprovalExpired"
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
            :aborted="msg.aborted"
            :agent-id="msg.agentId"
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
import type { AgentConfig } from "@cloudmind/shared";

const props = defineProps<{
  session: Session | undefined;
  messages: DisplayMessage[];
  agents: AgentConfig[];
  isConnected: boolean;
  isStreaming: boolean;
  // 连接异常的可感知提示（P0-3）："重连中…"，优先于默认状态文案
  statusHint?: string;
  // 「加载更早」入口态与动作。动作为函数 prop 而非 emit：前置合并后要按
  // 返回的前置条数做滚动锚定，emit 拿不到父级处理结果
  hasMoreHistory: boolean;
  loadingOlder: boolean;
  onLoadOlder: () => Promise<number>;
}>();

const emit = defineEmits<{
  (e: "send", text: string): void;
  (e: "approval-respond", payload: ApprovalResponsePayload): void;
  // 审批卡片 60s 倒计时到点（M44）：透传给页面把卡片标为 expired
  (e: "approval-expired", approvalId: string): void;
}>();

const messagesEl = ref<HTMLElement | null>(null);

const statusText = computed(() => {
  if (props.statusHint) return props.statusHint;
  if (!props.isConnected) return "未连接";
  if (props.isStreaming) return "生成中...";
  return "已连接";
});

// 新消息/流式增量/工具卡片出现时自动滚动到底部（与 ChatView 同一口径）；
// 「加载更早」的前置合并不滚底：凭首条消息 id 变化识别前置插入并跳过，
// 由 handleLoadOlder 把视口锚定回原位置
let firstMsgIdBeforePrepend: string | null = null;

watch(
  () => [
    props.messages.length,
    props.messages[props.messages.length - 1]?.text,
    props.messages[props.messages.length - 1]?.thinking,
    props.messages[props.messages.length - 1]?.toolCalls.length,
  ],
  async () => {
    await nextTick();
    const el = messagesEl.value;
    if (!el) return;
    if (firstMsgIdBeforePrepend !== null) {
      if (props.messages[0]?.id !== firstMsgIdBeforePrepend) {
        // 本次长度变化来自前置合并
        firstMsgIdBeforePrepend = null;
        return;
      }
      // 前置页尚未落地（流式增量先触发 watch）：锚记保留，本次照常滚底
    }
    el.scrollTop = el.scrollHeight;
  },
);

async function handleLoadOlder() {
  const el = messagesEl.value;
  const prevHeight = el?.scrollHeight ?? 0;
  const prevTop = el?.scrollTop ?? 0;
  firstMsgIdBeforePrepend = props.messages[0]?.id ?? "";
  const prepended = await props.onLoadOlder();
  if (!prepended) {
    // 无新消息插入：watch 不会触发，锚记直接复位
    firstMsgIdBeforePrepend = null;
    return;
  }
  await nextTick();
  // 视口锚定原首条消息：滚动位置下移新插入的高度
  if (el) el.scrollTop = el.scrollHeight - prevHeight + prevTop;
  firstMsgIdBeforePrepend = null;
}

function agentName(agentId: string): string {
  return props.agents.find((a) => a.id === agentId)?.name || agentId;
}

function onSend(text: string) {
  emit("send", text);
}

function onApprovalRespond(payload: ApprovalResponsePayload) {
  emit("approval-respond", payload);
}

function onApprovalExpired(approvalId: string) {
  emit("approval-expired", approvalId);
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
  border-bottom: 1px solid var(--mc-border);
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
.load-older {
  display: block;
  margin: 0 auto 8px;
  padding: 4px 12px;
  font-size: 12px;
  color: var(--mc-text-tertiary, #5a6a7a);
  background: none;
  border: none;
  text-align: center;
}
button.load-older {
  cursor: pointer;
  color: var(--mc-accent, #00e5c9);
}
button.load-older:hover {
  text-decoration: underline;
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
