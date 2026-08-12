<template>
  <div class="comm-hub">
    <aside class="comm-sidebar">
      <div class="comm-sidebar-header">
        <BackButton to="/" />
        <span class="comm-sidebar-title">通讯中枢</span>
        <button class="new-agent-btn" title="新建 Agent" @click="navigateTo('/agents/new')">+</button>
      </div>

      <div class="comm-mode-switch">
        <button :class="['comm-mode-btn', { active: tab === 'private' }]" @click="tab = 'private'">私聊</button>
        <button :class="['comm-mode-btn', { active: tab === 'group' }]" @click="tab = 'group'">群聊</button>
      </div>

      <div class="comm-list">
        <div v-if="tab === 'group'" class="comm-create-group">
          <button class="create-group-btn" @click="navigateTo('/sessions')">+ 创建群聊</button>
        </div>

        <template v-if="tab === 'private'">
          <div v-if="agents.error" class="comm-empty">加载失败：{{ agents.error }}</div>
          <div
            v-for="agent in agents.list"
            :key="agent.id"
            class="comm-item"
            :class="{ active: selectedType === 'private' && selectedAgentId === agent.id }"
            @click="selectAgent(agent)"
          >
            <div class="comm-avatar placeholder">{{ agent.name?.[0] || "?" }}</div>
            <div class="comm-info">
              <div class="comm-name">{{ agent.name || agent.id }}</div>
              <div class="comm-preview">{{ agent.codename || "点击开始对话" }}</div>
            </div>
            <button
              class="edit-agent-btn"
              title="编辑"
              @click.stop="navigateTo('/agents/' + encodeURIComponent(agent.id) + '/edit')"
            >
              ✎
            </button>
          </div>
          <div v-if="agents.isLoading && !agents.list.length && !agents.error" class="comm-empty">加载中...</div>
          <div v-else-if="!agents.list.length && !agents.error" class="comm-empty">暂无心智</div>
        </template>

        <template v-if="tab === 'group'">
          <div v-if="sessions.error" class="comm-empty">加载失败：{{ sessions.error }}</div>
          <div
            v-for="session in groupSessions"
            :key="session.id"
            class="comm-item"
            :class="{ active: selectedType === 'group' && selectedId === session.id }"
            @click="selectGroup(session)"
          >
            <div class="comm-avatar placeholder group">#</div>
            <div class="comm-info">
              <div class="comm-name">{{ session.name }}</div>
              <div class="comm-preview">{{ session.agentIds.length }} 位成员</div>
            </div>
          </div>
          <div v-if="sessions.isLoading && !groupSessions.length && !sessions.error" class="comm-empty">加载中...</div>
          <div v-else-if="!groupSessions.length && !sessions.error" class="comm-empty">暂无群聊</div>
        </template>
      </div>
    </aside>

    <main class="comm-main">
      <ChatView
        v-if="selectedType === 'private' && selectedAgentId"
        :key="selectedAgentId"
        :agent-id="selectedAgentId"
      />
      <div v-else-if="selectedType === 'group' && selectedSession" class="group-chat-wrapper">
        <div class="group-body">
          <GroupChatView
            :key="selectedId"
            :session="selectedSession"
            :messages="groupMessages"
            :agents="agents.list"
            :is-connected="groupIsConnected"
            :is-streaming="groupIsStreaming"
            :status-hint="groupStatusHint"
            @send="onGroupSend"
            @approval-respond="onGroupApprovalRespond"
          />
        </div>
      </div>
      <div v-else class="comm-welcome">
        <div class="comm-welcome-icon">//</div>
        <div class="comm-welcome-title">选择一个会话开始交流</div>
        <div class="comm-welcome-sub">私聊与 Agent 一对一沟通，群聊与多个 Agent 协作讨论</div>
      </div>
    </main>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted } from "vue";
import { useAgentsStore } from "@/stores/agents";
import { useSessionsStore } from "@/stores/sessions";
import { useEngineClient, type Session } from "@/composables/useEngineClient";
import { useChatRecords, type DisplayMessage } from "@/composables/useChatRecords";
import { useGroupChatStream } from "@/composables/useGroupChatStream";
import {
  findPendingApproval,
  settleApproval,
  type ApprovalResponsePayload,
} from "@/utils/approval";
import BackButton from "@/components/BackButton.vue";
import ChatView from "@/components/ChatView.vue";
import GroupChatView from "@/components/GroupChatView.vue";

const agents = useAgentsStore();
const sessions = useSessionsStore();
const client = useEngineClient();
const { recordsToDisplay } = useChatRecords();

const tab = ref<"private" | "group">("private");
const selectedId = ref<string>("");
const selectedAgentId = ref<string>("");
const selectedType = ref<"private" | "group" | "">("");

const selectedSession = ref<Session | undefined>(undefined);
const {
  messages: groupMessages,
  isStreaming: groupIsStreaming,
  handlers: groupHandlers,
  pushUserMessage: pushGroupUserMessage,
  pushError: pushGroupError,
  resetStreamState: resetGroupStream,
} = useGroupChatStream();
const groupIsConnected = ref(false);
// 断线重连状态（P0-3）：>0 表示正在第 N 次重试
const groupReconnectAttempts = ref(0);
const groupStatusHint = computed(() => {
  if (client.sidecarTerminated.value) return "engine 进程已退出，请重启应用";
  if (groupReconnectAttempts.value > 0) return `连接已断开，重连中（第 ${groupReconnectAttempts.value} 次）…`;
  return "";
});
let groupConnection: ReturnType<typeof client.connectSession> | null = null;

const groupSessions = computed(() => sessions.sessions.filter((s) => s.type === "group"));

onMounted(() => {
  agents.load();
  sessions.load();
});

onUnmounted(() => {
  groupConnection?.close();
});

// 快速连点两个群聊时，后 resolve 的加载/连接不得覆盖先选的会话
let groupSelectSeq = 0;

function selectAgent(agent: { id: string }) {
  // 同时作废进行中的 selectGroup：否则其 await 返回后仍会建立"幽灵"群聊连接
  groupSelectSeq++;
  selectedAgentId.value = agent.id;
  selectedType.value = "private";
  selectedId.value = "";
  selectedSession.value = undefined;
  closeGroupConnection();
}

async function selectGroup(session: Session) {
  const seq = ++groupSelectSeq;
  selectedId.value = session.id;
  selectedType.value = "group";
  selectedAgentId.value = "";
  selectedSession.value = session;
  // 先断旧连接，await 期间旧会话的 delta 不会串进新会话
  closeGroupConnection();
  const msgs = await fetchGroupMessages(session.id);
  // await 期间又选了别的会话/私聊：过期的历史结果不得覆盖当前消息列表
  if (seq !== groupSelectSeq) return;
  if (msgs) {
    groupMessages.value = msgs;
  } else {
    groupMessages.value = [];
    pushGroupError("历史消息加载失败");
  }
  connectGroup(session.id);
}

async function fetchGroupMessages(sessionId: string): Promise<DisplayMessage[] | null> {
  try {
    const records = await client.getSessionMessages(sessionId, 100);
    return recordsToDisplay(records);
  } catch {
    return null;
  }
}

function connectGroup(sessionId: string) {
  closeGroupConnection();
  groupIsConnected.value = false;
  groupIsStreaming.value = false;
  groupReconnectAttempts.value = 0;

  groupConnection = client.connectSession(sessionId, {
    onOpen: () => {
      groupIsConnected.value = true;
      groupReconnectAttempts.value = 0;
    },
    ...groupHandlers,
    onReconnecting: (attempt) => {
      groupIsConnected.value = false;
      groupReconnectAttempts.value = attempt;
      resetGroupStream();
    },
    onReconnected: () => {
      // 重连成功：拉取最新消息列表对齐断线期间的状态
      groupReconnectAttempts.value = 0;
      fetchGroupMessages(sessionId).then((msgs) => {
        if (msgs && selectedId.value === sessionId) groupMessages.value = msgs;
      });
    },
    onClose: () => {
      groupIsConnected.value = false;
      groupReconnectAttempts.value = 0;
      resetGroupStream();
    },
  });
}

function closeGroupConnection() {
  groupConnection?.close();
  groupConnection = null;
  groupIsConnected.value = false;
  groupReconnectAttempts.value = 0;
  resetGroupStream();
}

function onGroupSend(text: string) {
  if (!groupConnection) return;
  const sent = groupConnection.send(text);
  if (!sent) {
    pushGroupError("发送失败：连接未就绪，请稍后重试");
    return;
  }
  pushGroupUserMessage(text);
}

// 审批卡片点击后回执引擎；remember 表示本会话对同名工具不再询问
function onGroupApprovalRespond(payload: ApprovalResponsePayload) {
  if (!groupConnection) return;
  if (!findPendingApproval(groupMessages.value, payload.approvalId)) return;
  const sent = groupConnection.sendRaw({
    type: "tool.approval",
    approvalId: payload.approvalId,
    approved: payload.approved,
    remember: payload.remember,
  });
  if (sent) {
    settleApproval(groupMessages.value, payload.approvalId, payload.approved ? "approved" : "denied");
  } else {
    // 发送失败必须让用户感知：卡片闩锁已置位，静默失败会把卡片锁成死态
    pushGroupError("审批回执发送失败：连接未就绪，请重试");
  }
}
</script>

<style scoped>
.comm-hub {
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  bottom: 56px;
  background: var(--mc-bg);
  display: flex;
  z-index: 10;
}

.comm-sidebar {
  width: 260px;
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  background: rgba(11, 15, 23, 0.95);
  border-right: 1px solid var(--mc-panel);
}

.comm-sidebar-header {
  height: 56px;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 0 14px;
  border-bottom: 1px solid var(--mc-panel);
  flex-shrink: 0;
}

.comm-sidebar-title {
  flex: 1;
  font-size: 14px;
  color: var(--mc-text);
  font-weight: 500;
}

.new-agent-btn {
  width: 28px;
  height: 28px;
  border-radius: 6px;
  background: rgba(0, 229, 201, 0.1);
  border: 1px solid rgba(0, 229, 201, 0.2);
  color: var(--mc-accent);
  font-size: 18px;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: all 0.15s;
}

.new-agent-btn:hover {
  background: rgba(0, 229, 201, 0.2);
}

.comm-mode-switch {
  display: flex;
  gap: 4px;
  padding: 10px 12px;
  flex-shrink: 0;
}

.comm-mode-btn {
  flex: 1;
  padding: 7px 0;
  background: rgba(255, 255, 255, 0.04);
  border: 1px solid var(--mc-panel);
  border-radius: 6px;
  color: var(--mc-text-secondary);
  font-size: 12px;
  cursor: pointer;
  transition: all 0.15s;
}

.comm-mode-btn.active {
  background: rgba(0, 229, 201, 0.12);
  border-color: rgba(0, 229, 201, 0.3);
  color: var(--mc-accent);
}

.comm-list {
  flex: 1;
  overflow-y: auto;
  padding: 4px 10px 10px;
  display: flex;
  flex-direction: column;
  gap: 3px;
}

.comm-item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 9px 10px;
  background: rgba(255, 255, 255, 0.03);
  border: 1px solid rgba(255, 255, 255, 0.04);
  border-radius: 8px;
  cursor: pointer;
  transition: all 0.15s;
}

.comm-item:hover {
  background: rgba(0, 229, 201, 0.08);
  border-color: rgba(0, 229, 201, 0.2);
}

.comm-item.active {
  background: rgba(0, 229, 201, 0.12);
  border-color: rgba(0, 229, 201, 0.3);
}

.comm-avatar {
  width: 34px;
  height: 34px;
  border-radius: 50%;
  object-fit: cover;
  flex-shrink: 0;
}

.comm-avatar.placeholder {
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--mc-border);
  color: var(--mc-text-secondary);
  font-size: 13px;
  font-weight: 500;
}

.comm-avatar.placeholder.group {
  background: rgba(0, 229, 201, 0.15);
  color: var(--mc-accent);
}

.comm-info {
  flex: 1;
  min-width: 0;
}

.edit-agent-btn {
  width: 26px;
  height: 26px;
  border-radius: 6px;
  background: transparent;
  border: 1px solid transparent;
  color: var(--mc-text-tertiary);
  font-size: 12px;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  opacity: 0;
  transition: all 0.15s;
}

.comm-item:hover .edit-agent-btn {
  opacity: 1;
}

.edit-agent-btn:hover {
  background: rgba(0, 229, 201, 0.1);
  border-color: rgba(0, 229, 201, 0.2);
  color: var(--mc-accent);
}

.comm-name {
  font-size: 13px;
  color: var(--mc-text);
  font-weight: 500;
}

.comm-preview {
  font-size: 11px;
  color: var(--mc-text-tertiary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  margin-top: 2px;
}

.comm-empty {
  color: var(--mc-text-tertiary);
  text-align: center;
  padding: 30px 0;
  font-size: 12px;
}

.comm-create-group {
  padding: 0 10px 6px;
}

.create-group-btn {
  width: 100%;
  padding: 7px;
  background: rgba(0, 229, 201, 0.08);
  border: 1px solid rgba(0, 229, 201, 0.2);
  border-radius: 6px;
  color: var(--mc-accent);
  font-size: 12px;
  cursor: pointer;
  transition: all 0.15s;
}

.create-group-btn:hover {
  background: rgba(0, 229, 201, 0.15);
}

.comm-main {
  flex: 1;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  min-width: 0;
}

.comm-welcome {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  text-align: center;
  color: var(--mc-text-secondary);
}

.comm-welcome-icon {
  font-size: 32px;
  color: var(--mc-accent);
  margin-bottom: 12px;
  opacity: 0.5;
}

.comm-welcome-title {
  font-size: 16px;
  color: var(--mc-text);
  font-weight: 500;
  margin-bottom: 6px;
}

.comm-welcome-sub {
  font-size: 12px;
  color: var(--mc-text-tertiary);
}

.group-chat-wrapper {
  flex: 1;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  min-width: 0;
}

.group-body {
  flex: 1;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  min-width: 0;
}

.group-body > .group-chat-view,
.group-body > .group-chat-view-stub {
  flex: 1;
  min-width: 0;
  overflow: hidden;
}
</style>
