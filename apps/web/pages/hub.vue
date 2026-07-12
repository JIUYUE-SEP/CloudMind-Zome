<template>
  <div class="comm-hub">
    <aside class="comm-sidebar">
      <div class="comm-sidebar-header">
        <BackButton />
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
          <div
            v-for="agent in agents.list"
            :key="agent.id"
            class="comm-item"
            :class="{ active: selectedType === 'private' && selectedAgentId === agent.id }"
            @click="selectAgent(agent)"
          >
            <div class="comm-avatar placeholder">{{ agent.name?.[0] || "?" }}</div>
            <div class="comm-info">
              <div class="comm-name">{{ agent.name }}</div>
              <div class="comm-preview">{{ agent.codename || "点击开始对话" }}</div>
            </div>
            <button
              class="edit-agent-btn"
              title="编辑"
              @click.stop="navigateTo('/agents/' + agent.id)"
            >
              ✎
            </button>
          </div>
          <div v-if="!agents.list.length" class="comm-empty">暂无心智</div>
        </template>

        <template v-if="tab === 'group'">
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
          <div v-if="!groupSessions.length" class="comm-empty">暂无群聊</div>
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
        <div class="group-mode-switch">
          <button :class="{ active: sessionMode === 'chat' }" @click="setMode('chat')">聊天</button>
          <button :class="{ active: sessionMode === 'code' }" @click="setMode('code')">编程</button>
        </div>
        <div class="group-body" :class="{ 'code-mode': sessionMode === 'code' }">
          <GroupChatView
            :key="selectedId"
            :session="selectedSession"
            :messages="groupMessages"
            :agents="agents.list"
            :is-connected="groupIsConnected"
            :is-streaming="groupIsStreaming"
            @send="onGroupSend"
          />
          <CodeWorkspace
            v-if="sessionMode === 'code'"
            :entries="fileTreeEntries"
            :terminal-output="terminalOutput"
            v-model:current-file-content="currentFileContent"
            :current-file-path="currentFilePath"
            @open-file="onOpenFile"
            @clear-terminal="terminalOutput = ''"
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
import type { ChatMode } from "@mindcloud/shared";
import { useAgentsStore } from "@/stores/agents";
import { useSessionsStore } from "@/stores/sessions";
import { useEngineClient, type ChatMessageRecord, type Session } from "@/composables/useEngineClient";
import BackButton from "@/components/BackButton.vue";
import ChatView from "@/components/ChatView.vue";
import GroupChatView from "@/components/GroupChatView.vue";
import CodeWorkspace from "@/components/code/CodeWorkspace.vue";
import type { FileEntry } from "@/components/code/FileTree.vue";
import type { DisplayMessage } from "@/components/GroupChatView.vue";

const agents = useAgentsStore();
const sessions = useSessionsStore();
const client = useEngineClient();

const tab = ref<"private" | "group">("private");
const selectedId = ref<string>("");
const selectedAgentId = ref<string>("");
const selectedType = ref<"private" | "group" | "">("");

const selectedSession = ref<Session | undefined>(undefined);
const groupMessages = ref<DisplayMessage[]>([]);
const groupIsConnected = ref(false);
const groupIsStreaming = ref(false);
const sessionMode = ref<ChatMode>("chat");
const sessionProjectId = ref<string | undefined>(undefined);
const terminalOutput = ref("");
const fileTreeEntries = ref<FileEntry[]>([]);
const currentFileContent = ref("");
const currentFilePath = ref("");
let groupConnection: ReturnType<typeof client.connectSession> | null = null;

const groupSessions = computed(() => sessions.sessions.filter((s) => s.type === "group"));

onMounted(() => {
  agents.load();
  sessions.load();
});

onUnmounted(() => {
  groupConnection?.close();
});

function selectAgent(agent: { id: string }) {
  selectedAgentId.value = agent.id;
  selectedType.value = "private";
  selectedId.value = "";
  selectedSession.value = undefined;
  closeGroupConnection();
}

async function selectGroup(session: Session) {
  selectedId.value = session.id;
  selectedType.value = "group";
  selectedAgentId.value = "";
  selectedSession.value = session;
  sessionMode.value = session.mode || "chat";
  sessionProjectId.value = session.projectId;
  resetIdeState();
  await loadGroupMessages(session.id);
  connectGroup(session.id);
}

async function loadGroupMessages(sessionId: string) {
  try {
    const records = await client.getSessionMessages(sessionId, 100);
    groupMessages.value = recordsToDisplay(records);
  } catch {
    groupMessages.value = [];
  }
}

function connectGroup(sessionId: string) {
  closeGroupConnection();
  groupIsConnected.value = false;
  groupIsStreaming.value = false;

  groupConnection = client.connectSession(sessionId, {
    onOpen: () => {
      groupIsConnected.value = true;
      if (selectedSession.value?.mode === "code") {
        sessionMode.value = "code";
      }
    },
    onTextDelta: (delta) => {
      const last = groupMessages.value[groupMessages.value.length - 1];
      if (last && last.role === "assistant" && last.isStreaming) {
        last.text += delta;
      } else {
        groupMessages.value.push({
          id: `stream_${Date.now()}`,
          role: "assistant",
          text: delta,
          thinking: "",
          toolCalls: [],
          isStreaming: true,
        });
      }
    },
    onThinkingDelta: (delta) => {
      const last = groupMessages.value[groupMessages.value.length - 1];
      if (last && last.role === "assistant" && last.isStreaming) {
        last.thinking += delta;
      }
    },
    onToolCall: (toolCall) => {
      const last = groupMessages.value[groupMessages.value.length - 1];
      if (last && last.role === "assistant") {
        last.toolCalls.push(toolCall);
      }
    },
    onStepEnd: () => {
      const last = groupMessages.value[groupMessages.value.length - 1];
      if (last && last.role === "assistant") {
        last.isStreaming = false;
      }
      groupIsStreaming.value = false;
    },
    onModeChanged: (mode, projectId) => {
      sessionMode.value = mode;
      sessionProjectId.value = projectId;
    },
    onFileOpened: (path, content) => {
      currentFilePath.value = path;
      currentFileContent.value = content;
    },
    onCommandOutput: (chunk) => {
      terminalOutput.value += chunk + "\n";
    },
    onError: (error) => {
      groupIsStreaming.value = false;
      groupMessages.value.push({
        id: `err_${Date.now()}`,
        role: "assistant",
        text: `Error: ${error}`,
        thinking: "",
        toolCalls: [],
        isStreaming: false,
      });
    },
    onClose: () => {
      groupIsConnected.value = false;
      groupIsStreaming.value = false;
    },
  });
}

function closeGroupConnection() {
  groupConnection?.close();
  groupConnection = null;
  groupIsConnected.value = false;
  groupIsStreaming.value = false;
}

function resetIdeState() {
  sessionMode.value = "chat";
  terminalOutput.value = "";
  fileTreeEntries.value = [];
  currentFileContent.value = "";
  currentFilePath.value = "";
}

function setMode(mode: ChatMode) {
  sessionMode.value = mode;
  const projectId = mode === "code" ? selectedSession.value?.id : sessionProjectId.value;
  groupConnection?.setMode(mode, projectId);
}

function onOpenFile(path: string) {
  groupConnection?.sendRaw({ type: "code.file_open", path });
}

function onGroupSend(text: string) {
  if (!groupConnection) return;
  const sent = groupConnection.send(text);
  if (!sent) return;
  groupMessages.value.push({
    id: `u_${Date.now()}`,
    role: "user",
    text,
    thinking: "",
    toolCalls: [],
    isStreaming: false,
  });
  groupIsStreaming.value = true;
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
</script>

<style scoped>
.comm-hub {
  position: absolute;
  top: 0;
  left: 0;
  right: 180px;
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
  border-right: 1px solid rgba(255, 255, 255, 0.06);
}

.comm-sidebar-header {
  height: 56px;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 0 14px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.06);
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
  border: 1px solid rgba(255, 255, 255, 0.06);
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
  background: rgba(255, 255, 255, 0.08);
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

.group-mode-switch {
  display: flex;
  gap: 4px;
  padding: 10px 12px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.06);
  flex-shrink: 0;
}

.group-mode-switch button {
  flex: 1;
  padding: 7px 0;
  background: rgba(255, 255, 255, 0.04);
  border: 1px solid rgba(255, 255, 255, 0.06);
  border-radius: 6px;
  color: var(--mc-text-secondary);
  font-size: 12px;
  cursor: pointer;
  transition: all 0.15s;
}

.group-mode-switch button.active {
  background: rgba(0, 229, 201, 0.12);
  border-color: rgba(0, 229, 201, 0.3);
  color: var(--mc-accent);
}

.group-body {
  flex: 1;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  min-width: 0;
}

.group-body.code-mode {
  flex-direction: row;
}

.group-body > .group-chat-view,
.group-body > .group-chat-view-stub {
  flex: 1;
  min-width: 0;
  overflow: hidden;
}

.group-body.code-mode > .group-chat-view,
.group-body.code-mode > .group-chat-view-stub {
  flex: 1;
}

.group-body.code-mode > .code-workspace,
.group-body.code-mode > .code-workspace-stub {
  width: 50%;
  min-width: 320px;
  border-left: 1px solid rgba(255, 255, 255, 0.06);
}
</style>
