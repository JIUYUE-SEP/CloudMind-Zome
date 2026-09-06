<template>
  <div class="comm-hub">
    <aside class="comm-sidebar">
      <div class="comm-sidebar-header">
        <BackButton to="/" />
        <span class="comm-sidebar-title">通讯中枢</span>
        <button class="new-agent-btn" title="新建 Agent" @click="navigateTo('/agents/new')">+</button>
      </div>

      <!-- 单/多模式切换（web 纯呈现层；状态只进 localStorage）。顶栏锚点申报：
           落在 hub 侧栏头部（模式真正影响的使用面在这）；layouts 的 right-nav
           只在首页出现，仅承担广播站入口的收敛。模式相关分支挂 ClientOnly
           （SSR 恒按缺省 multi 渲染，localStorage 的 single 态水合才出现——
           不挂会报水合不匹配噪音；v-if/v-else 同块必须同域，故包到双列表尾） -->
      <ClientOnly>
      <div class="comm-mode-switch agent-mode-switch">
        <button :class="['comm-mode-btn', { active: !isSingle }]" @click="uiMode.setMode('multi')">多</button>
        <button :class="['comm-mode-btn', { active: isSingle }]" @click="uiMode.setMode('single')">单</button>
      </div>
      <p v-if="uiMode.notice" class="mode-notice">
        {{ uiMode.notice }}
        <button class="notice-dismiss" title="知道了" @click="uiMode.clearNotice()">×</button>
      </p>

      <!-- 单模式：顶栏 agent 选择器直达私聊，私聊/群聊 tabs 与双列表全收敛 -->
      <template v-if="isSingle">
        <div class="single-agent-row">
          <div class="comm-avatar placeholder">{{ currentAgent?.name?.[0] || "?" }}</div>
          <select class="single-agent-select" :value="uiMode.singleAgentId" @change="onSingleAgentChange">
            <option value="" disabled>选择心智…</option>
            <option v-for="a in agents.list" :key="a.id" :value="a.id">{{ a.name || a.id }}</option>
          </select>
        </div>
      </template>

      <template v-else>
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
      </template>
      </ClientOnly>
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
            :has-more-history="groupHasMoreHistory"
            :loading-older="groupLoadingOlder"
            :on-load-older="onGroupLoadOlder"
            @send="onGroupSend"
            @approval-respond="onGroupApprovalRespond"
            @approval-expired="onGroupApprovalExpired"
          />
        </div>
      </div>
      <!-- 单模式欢迎屏同属模式相关分支：v-if 挂在 ClientOnly 组件自身
           （与 v-else 保持合法邻接），多模式欢迎屏照旧走 SSR（恒等） -->
      <ClientOnly v-if="isSingle">
        <div class="comm-welcome">
          <div class="comm-welcome-icon">//</div>
          <div class="comm-welcome-title">单模式</div>
          <div class="comm-welcome-sub">在上方选择一位心智，直达私聊</div>
        </div>
      </ClientOnly>
      <div v-else class="comm-welcome">
        <div class="comm-welcome-icon">//</div>
        <div class="comm-welcome-title">选择一个会话开始交流</div>
        <div class="comm-welcome-sub">私聊与 Agent 一对一沟通，群聊与多个 Agent 协作讨论</div>
      </div>
    </main>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch, onMounted, onUnmounted } from "vue";
import { useAgentsStore } from "@/stores/agents";
import { useSessionsStore } from "@/stores/sessions";
import { useUiModeStore } from "@/stores/ui-mode";
import { useEngineClient, type Session, type ChatMessageRecord } from "@/composables/useEngineClient";
import { useGroupChatStream, HISTORY_PAGE_LIMIT } from "@/composables/useGroupChatStream";
import {
  findPendingApproval,
  settleApproval,
  expireApproval,
  expireAllPendingApprovals,
  type ApprovalResponsePayload,
} from "@/utils/approval";
import BackButton from "@/components/BackButton.vue";
import ChatView from "@/components/ChatView.vue";
import GroupChatView from "@/components/GroupChatView.vue";

const agents = useAgentsStore();
const sessions = useSessionsStore();
const client = useEngineClient();
const uiMode = useUiModeStore();

// 单/多模式（web 纯呈现层）：单模式收敛导航并直达 singleAgentId 私聊
const isSingle = computed(() => uiMode.agentMode === "single");
const currentAgent = computed(() => agents.list.find((a) => a.id === uiMode.singleAgentId));

// 名录对账（决策 3：选中 agent 被删 → 回退 multi + 页面内提示）+ 单模式直达私聊
watch(
  () => [isSingle.value, uiMode.singleAgentId, agents.list.length, agents.loadedOnce],
  () => {
    // 名录就绪门槛（review High）：加载完成前的空列表 ≠ 已删除——
    // 首跑（immediate）时 load 仍在途，不得在空名录上做回退判定（会把
    // single 误判抹盘）；直达分支同门——确认 id 有效前不提前开聊
    if (!agents.loadedOnce) return;
    uiMode.reconcile(agents.list);
    if (isSingle.value && uiMode.singleAgentId && selectedAgentId.value !== uiMode.singleAgentId) {
      selectAgent({ id: uiMode.singleAgentId });
    }
  },
  { immediate: true },
);

function onSingleAgentChange(event: Event) {
  const id = (event.target as HTMLSelectElement).value;
  if (!id) return;
  uiMode.selectAgent(id);
  selectAgent({ id });
}

const tab = ref<"private" | "group">("private");
const selectedId = ref<string>("");
const selectedAgentId = ref<string>("");
const selectedType = ref<"private" | "group" | "">("");

const selectedSession = ref<Session | undefined>(undefined);
const {
  messages: groupMessages,
  isStreaming: groupIsStreaming,
  hasMoreHistory: groupHasMoreHistory,
  loadingOlder: groupLoadingOlder,
  handlers: groupHandlers,
  pushUserMessage: pushGroupUserMessage,
  pushError: pushGroupError,
  resetStreamState: resetGroupStream,
  applyHistoryPage: applyGroupHistoryPage,
  clearHistory: clearGroupHistory,
  loadOlderHistory: loadGroupOlderHistory,
} = useGroupChatStream();
const groupIsConnected = ref(false);
// 断线重连状态（P0-3）：>0 表示正在第 N 次重试
const groupReconnectAttempts = ref(0);
const groupStatusHint = computed(() => {
  if (groupReconnectAttempts.value > 0) return `连接已断开，重连中（第 ${groupReconnectAttempts.value} 次）…`;
  return "";
});
let groupConnection: ReturnType<typeof client.connectSession> | null = null;

const groupSessions = computed(() => sessions.sessions.filter((s) => s.type === "group"));

onMounted(() => {
  agents.load();
  sessions.load();
});

// 组件卸载在途：selectGroup 的 await 返回后不得落地数据或建立连接
// （与 sessions/[id].vue 同款 alive 防护；迟到建连配合自动重连会常驻泄漏）
let alive = true;

onUnmounted(() => {
  alive = false;
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
  // 与私聊侧 disconnectInternal（stores/chat.ts）同款防护：切群即清空旧消息，
  // 消除新群历史返回前旧群内容残留在新群名下的窗口；
  // clearHistory 同时作废在途翻页并复位游标/入口态
  clearGroupHistory();
  const records = await fetchGroupMessages(session.id);
  // await 期间组件已卸载：不得落地消息，更不得建立迟到的群聊连接（M41）
  if (!alive) return;
  // await 期间又选了别的会话/私聊：过期的历史结果不得覆盖当前消息列表
  if (seq !== groupSelectSeq) return;
  if (records) {
    applyGroupHistoryPage(records);
  } else {
    clearGroupHistory();
    pushGroupError("历史消息加载失败");
  }
  connectGroup(session.id);
}

async function fetchGroupMessages(sessionId: string): Promise<ChatMessageRecord[] | null> {
  try {
    return await client.getSessionMessages(sessionId, { limit: HISTORY_PAGE_LIMIT });
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
      // M44：断线即失效——engine 在 socket close 时已把 pending 审批按拒绝收尾，
      // 重连后也没有回执路径，卡片不得永远 pending
      expireAllPendingApprovals(groupMessages.value);
    },
    onReconnected: () => {
      // 重连成功：拉取最新消息列表对齐断线期间的状态（整页替换同时复位翻页游标）
      groupReconnectAttempts.value = 0;
      fetchGroupMessages(sessionId).then((records) => {
        // alive 门（与 sessions/[id].vue 同款）：组件卸载后迟到的对齐结果不得落地
        if (records && alive && selectedId.value === sessionId) applyGroupHistoryPage(records);
      });
    },
    onClose: () => {
      groupIsConnected.value = false;
      groupReconnectAttempts.value = 0;
      resetGroupStream();
      // M44：终态关闭同样断线即失效（engine 侧 pending 审批已随连接收尾）
      expireAllPendingApprovals(groupMessages.value);
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

// 「加载更早」：游标为当前最早一条记录，更旧一页前置合并
// （并发由 composable 闸住；切群后迟到的旧页由 historySeq 代际丢弃）
function onGroupLoadOlder(): Promise<number> {
  return loadGroupOlderHistory((before) =>
    client.getSessionMessages(selectedId.value, { limit: HISTORY_PAGE_LIMIT, before }),
  );
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

// 审批卡片 60s 倒计时到点（M44，engine 同刻按超时拒绝）：本地标失效
function onGroupApprovalExpired(approvalId: string) {
  expireApproval(groupMessages.value, approvalId);
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

/* 单/多模式切换行与回退提示 */
.agent-mode-switch {
  padding-bottom: 4px;
  border-bottom: 1px solid var(--mc-panel);
}

.mode-notice {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 0;
  padding: 8px 12px;
  font-size: 12px;
  color: var(--mc-warning);
  background: rgba(245, 158, 11, 0.1);
}

.notice-dismiss {
  margin-left: auto;
  background: transparent;
  border: none;
  color: var(--mc-text-tertiary);
  cursor: pointer;
  font-size: 14px;
  padding: 0 4px;
}

.single-agent-row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 12px;
  flex-shrink: 0;
}

.single-agent-select {
  flex: 1;
  min-width: 0;
  padding: 7px 10px;
  border-radius: 6px;
  border: 1px solid rgba(255, 255, 255, 0.1);
  background: rgba(255, 255, 255, 0.05);
  color: var(--mc-text);
  font-size: 13px;
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
