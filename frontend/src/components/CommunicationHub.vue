<template>
  <div class="comm-hub">
    <!-- Left sidebar -->
    <aside class="comm-sidebar">
      <div class="comm-sidebar-header">
        <BackButton />
        <span class="comm-sidebar-title">通讯中枢</span>
      </div>

      <div class="comm-mode-switch">
        <button
          :class="['comm-mode-btn', { active: tab === 'private' }]"
          @click="tab = 'private'"
        >
          私聊
        </button>
        <button
          :class="['comm-mode-btn', { active: tab === 'group' }]"
          @click="tab = 'group'"
        >
          群聊
        </button>
      </div>

      <div class="comm-list">
        <div v-if="tab === 'group'" class="comm-create-group">
          <button class="create-group-btn" @click="showCreateGroup = true">+ 创建群聊</button>
        </div>

        <!-- Private: all Agents -->
        <template v-if="tab === 'private'">
          <div
            v-for="a in agentList"
            :key="a.id"
            class="comm-item"
            :class="{ active: selectedAgentId === a.id && selectedType === 'private' }"
            @click="selectAgent(a)"
          >
            <img v-if="a.portrait_url" :src="a.portrait_url" class="comm-avatar" />
            <div v-else class="comm-avatar placeholder">{{ a.name?.[0] || '?' }}</div>
            <div class="comm-info">
              <div class="comm-name">{{ a.name }}</div>
              <div class="comm-preview">{{ a.personality_summary || '点击开始对话' }}</div>
            </div>
          </div>
          <div v-if="!agentList.length" class="comm-empty">暂无心智</div>
        </template>

        <!-- Group -->
        <template v-if="tab === 'group'">
          <div
            v-for="s in groupSessions"
            :key="s.session_id"
            class="comm-item"
            :class="{ active: selectedId === s.session_id && selectedType === 'group' }"
            @click="selectGroup(s)"
          >
            <img v-if="s.target_avatar" :src="s.target_avatar" class="comm-avatar" />
            <div v-else class="comm-avatar placeholder group">#</div>
            <div class="comm-info">
              <div class="comm-name">{{ s.target_name }}</div>
              <div class="comm-preview">{{ s.last_message?.content || '暂无消息' }}</div>
            </div>
            <button
              class="comm-settings-btn"
              @click.stop="openGroupSettings(s)"
              title="群设置"
            >
              ⋮
            </button>
            <div v-if="s.unread_count > 0" class="comm-badge">{{ s.unread_count }}</div>
          </div>
          <div v-if="!groupSessions.length" class="comm-empty">暂无群聊</div>
        </template>
      </div>
    </aside>

    <!-- Main chat area -->
    <main class="comm-main">
      <ChatView
        v-if="selectedType === 'private' && selectedId"
        :key="selectedId"
        :session-id="selectedId"
        inline
        @close="clearSelection"
      />
      <GroupChatView
        v-else-if="selectedType === 'group' && selectedId"
        :key="selectedId"
        :group-id="selectedId"
        inline
        @close="clearSelection"
      />
      <div v-else class="comm-welcome">
        <div class="comm-welcome-icon">//</div>
        <div class="comm-welcome-title">选择一个会话开始交流</div>
        <div class="comm-welcome-sub">私聊与 Agent 一对一沟通，群聊与多个 Agent 协作讨论</div>
      </div>
    </main>

    <!-- Right info panel -->
    <aside class="comm-right-panel">
      <!-- Private: Agent figure -->
      <template v-if="selectedType === 'private' && currentAgent">
        <div class="rp-header">形象展示</div>
        <div class="rp-viewer-tabs">
          <button
            v-for="t in viewerTabs"
            :key="t.key"
            :class="['rp-tab', { active: viewerTab === t.key }]"
            @click="viewerTab = t.key"
          >
            {{ t.label }}
          </button>
        </div>
        <div class="rp-viewer">
          <PortraitViewer
            v-if="viewerTab === 'portrait'"
            :url="currentAgent.portrait_url || ''"
          />
          <Live2DViewer
            v-else-if="viewerTab === 'live2d'"
            :model-url="currentAgent.live2d_model_url || ''"
          />
          <VRMViewer
            v-else-if="viewerTab === 'vrm'"
            :model-url="currentAgent.model_url || ''"
          />
        </div>
        <div class="rp-agent-info">
          <div class="rp-agent-name">{{ currentAgent.name }}</div>
          <div class="rp-agent-codename">{{ currentAgent.codename }}</div>
          <div class="rp-agent-status" :class="currentAgent.status">
            {{ statusLabel(currentAgent.status) }}
          </div>
        </div>

        <!-- Memory State Panel -->
        <div class="rp-memory-panel">
          <div class="rp-section-title">记忆状态</div>
          <div class="rp-memory-stats">
            <div class="rp-stat">
              <span class="rp-stat-num">{{ agentMemory.stats.total_messages }}</span>
              <span class="rp-stat-label">总消息</span>
            </div>
            <div class="rp-stat">
              <span class="rp-stat-num">{{ agentMemory.stats.compressed_messages }}</span>
              <span class="rp-stat-label">已压缩</span>
            </div>
            <div class="rp-stat">
              <span class="rp-stat-num">{{ agentMemory.stats.compression_rate }}%</span>
              <span class="rp-stat-label">压缩率</span>
            </div>
          </div>

          <div class="rp-section-title">话题记录 ({{ agentMemory.topics.length }})</div>
          <div class="rp-topic-list">
            <div v-if="!agentMemory.topics.length" class="rp-empty">暂无话题记录</div>
            <div v-for="topic in agentMemory.topics" :key="topic.id" class="rp-topic-item">
              <div class="rp-topic-header">
                <span class="rp-topic-name">{{ topic.name }}</span>
                <span class="rp-topic-importance" :class="topic.importance">{{ topic.importance }}</span>
              </div>
              <div class="rp-topic-summary">{{ topic.summary }}</div>
              <div class="rp-topic-meta">round {{ topic.start_round }} ~ {{ topic.end_round }}</div>
            </div>
          </div>
        </div>
      </template>

      <!-- Group: Members + Topics -->
      <template v-else-if="selectedType === 'group' && groupInfo">
        <div class="rp-header">群信息</div>
        <div class="rp-group-name">{{ groupInfo.name }}</div>
        <div class="rp-section-title">成员 ({{ groupMembers.length }})</div>
        <div class="rp-member-list">
          <div v-for="m in groupMembers" :key="m.member_id" class="rp-member">
            <img :src="m.avatar || '/uploads/avatars/default.png'" class="rp-member-avatar" />
            <span class="rp-member-name">{{ m.name }}</span>
            <span v-if="m.is_conductor" class="rp-member-badge">队长</span>
          </div>
        </div>
        <div class="rp-section-title">主题记录</div>
        <div class="rp-topic-list">
          <div v-if="!groupTopics.length" class="rp-empty">暂无主题记录</div>
          <div v-for="(topic, i) in groupTopics" :key="i" class="rp-topic">
            {{ topic }}
          </div>
        </div>
      </template>

      <!-- Empty -->
      <div v-else class="rp-empty-panel">
        <div class="rp-empty-hint">选择一个会话查看详情</div>
      </div>
    </aside>

    <!-- Group Settings Modal -->
    <div v-if="showGroupSettings" class="cg-overlay" @click.self="showGroupSettings = false">
      <div class="cg-panel">
        <div class="cg-header">群设置<button class="cg-close" @click="showGroupSettings = false">×</button></div>

        <label>群头像</label>
        <div class="gs-avatar-row">
          <img v-if="editGroupAvatar" :src="editGroupAvatar" class="gs-avatar-preview" />
          <div v-else class="gs-avatar-placeholder">#</div>
          <button class="upload-btn" @click="groupAvatarInput?.click()">更换</button>
        </div>
        <input
          ref="groupAvatarInput"
          type="file"
          accept="image/*"
          style="display: none"
          @change="uploadGroupAvatar"
        />

        <label>群名称</label>
        <input v-model="editGroupName" placeholder="群聊名称" />

        <label>队长任命</label>
        <select v-model="editGroupConductor">
          <option :value="null">无</option>
          <option v-for="m in editGroupAgentMembers" :key="m.member_id" :value="m.member_id">
            {{ m.name }}
          </option>
        </select>

        <button class="cg-submit" @click="saveGroupSettings">保存</button>
      </div>
    </div>

    <!-- Create Group Modal -->
    <div v-if="showCreateGroup" class="cg-overlay" @click.self="showCreateGroup = false">
      <div class="cg-panel">
        <div class="cg-header">创建群聊<button class="cg-close" @click="showCreateGroup = false">×</button></div>
        <label>群名称</label>
        <input v-model="newGroupName" placeholder="输入群聊名称" />

        <label>选择成员</label>
        <div class="cg-agent-list">
          <label
            v-for="a in agentList"
            :key="a.id"
            class="cg-agent-item"
          >
            <input
              type="checkbox"
              :value="a.id"
              v-model="newGroupMembers"
            />
            <img v-if="a.portrait_url" :src="a.portrait_url" class="cg-agent-avatar" />
            <div v-else class="cg-agent-avatar placeholder">{{ a.name?.[0] || '?' }}</div>
            <span class="cg-agent-name">{{ a.name }}</span>
          </label>
        </div>

        <button
          class="cg-submit"
          :disabled="!newGroupName.trim() || !newGroupMembers.length"
          @click="createGroup"
        >
          创建
        </button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, watch } from 'vue'
import { useChatStore } from '@/stores/chat'
import { useAgentsStore } from '@/stores/agents'
import { api } from '@/api/client'
import BackButton from '@/components/BackButton.vue'
import ChatView from '@/components/ChatView.vue'
import GroupChatView from '@/components/GroupChatView.vue'
import PortraitViewer from '@/components/viewer/PortraitViewer.vue'
import Live2DViewer from '@/components/viewer/Live2DViewer.vue'
import VRMViewer from '@/components/viewer/VRMViewer.vue'

const chat = useChatStore()
const agents = useAgentsStore()
const tab = ref<'private' | 'group'>('private')
const selectedId = ref('')
const selectedAgentId = ref('')
const selectedType = ref<'private' | 'group' | ''>('')
const viewerTab = ref<'portrait' | 'live2d' | 'vrm'>('portrait')
const currentAgent = ref<any>(null)
const groupInfo = ref<any>(null)
const groupMembers = ref<any[]>([])
const groupTopics = ref<string[]>([])
const agentMemory = ref<{ topics: any[]; stats: { total_messages: number; compressed_messages: number; compression_rate: number } }>({
  topics: [],
  stats: { total_messages: 0, compressed_messages: 0, compression_rate: 0 },
})
const showCreateGroup = ref(false)
const newGroupName = ref('')
const newGroupMembers = ref<string[]>([])
const showGroupSettings = ref(false)
const editingGroup = ref<any>(null)
const editGroupName = ref('')
const editGroupAvatar = ref('')
const editGroupConductor = ref<string | null>(null)
const editGroupAgentMembers = ref<any[]>([])
const groupAvatarInput = ref<HTMLInputElement>()

const viewerTabs = [
  { key: 'portrait' as const, label: '立绘' },
  { key: 'live2d' as const, label: 'Live2D' },
  { key: 'vrm' as const, label: '3D模型' },
]

const agentList = computed(() => agents.list)
const groupSessions = computed(() => chat.sessions.filter(s => s.type === 'group'))

onMounted(() => {
  agents.fetchList()
  chat.fetchSessions()
})

watch(() => selectedId.value, async () => {
  if (selectedType.value === 'group' && selectedId.value) {
    await fetchGroupInfo(selectedId.value)
  }
})

async function selectAgent(a: any) {
  selectedAgentId.value = a.id
  selectedType.value = 'private'
  currentAgent.value = a
  // Load memory state
  await fetchAgentMemory(a.id)
  // Ensure or create private session
  const json = await api.post('/chats/sessions/private', {
    target_id: a.id,
    target_type: 'agent',
  })
  if (json.code === 0) {
    selectedId.value = json.data.session_id
  }
}

async function fetchAgentMemory(agentId: string) {
  const json = await api.get(`/agents/${agentId}/memory`)
  if (json.code === 0) {
    agentMemory.value = {
      topics: json.data.topics || [],
      stats: json.data.stats || { total_messages: 0, compressed_messages: 0, compression_rate: 0 },
    }
  }
}

async function selectGroup(s: any) {
  selectedId.value = s.session_id
  selectedType.value = 'group'
  await fetchGroupInfo(s.session_id)
}

async function fetchGroupInfo(groupId: string) {
  const json = await api.get(`/chats/groups/${groupId}`)
  if (json.code === 0) {
    groupInfo.value = json.data
    groupMembers.value = json.data.members || []
    groupTopics.value = json.data.topics || []
  }
}

function clearSelection() {
  selectedId.value = ''
  selectedAgentId.value = ''
  selectedType.value = ''
  currentAgent.value = null
  groupInfo.value = null
  groupMembers.value = []
  agentMemory.value = { topics: [], stats: { total_messages: 0, compressed_messages: 0, compression_rate: 0 } }
}

async function createGroup() {
  if (!newGroupName.value.trim()) return
  const json = await api.post('/chats/groups', {
    name: newGroupName.value.trim(),
    member_ids: newGroupMembers.value,
  })
  if (json.code === 0) {
    showCreateGroup.value = false
    newGroupName.value = ''
    newGroupMembers.value = []
    await chat.fetchSessions()
    // Auto switch to group tab and select new group
    tab.value = 'group'
    const newGroup = chat.sessions.find(s => s.session_id === json.data.group_id)
    if (newGroup) {
      selectGroup(newGroup)
    }
  }
}

async function openGroupSettings(s: any) {
  editingGroup.value = s
  editGroupName.value = s.target_name || ''
  editGroupAvatar.value = s.target_avatar || ''
  showGroupSettings.value = true
  // Fetch full group info for conductor + agent members
  const json = await api.get(`/chats/groups/${s.session_id}`)
  if (json.code === 0) {
    const data = json.data
    editGroupConductor.value = data.conductor_agent_id || null
    editGroupAgentMembers.value = (data.members || []).filter((m: any) => m.member_type === 'agent')
  }
}

async function uploadGroupAvatar(e: Event) {
  const file = (e.target as HTMLInputElement).files?.[0]
  if (!file || !editingGroup.value) return
  const fd = new FormData()
  fd.append('file', file)
  const json = await api.upload(`/chats/groups/${editingGroup.value.session_id}/avatar`, fd)
  if (json.code === 0) {
    editGroupAvatar.value = json.data.avatar_url
  }
  ;(e.target as HTMLInputElement).value = ''
}

async function saveGroupSettings() {
  if (!editingGroup.value) return
  const gid = editingGroup.value.session_id

  // Update name / avatar
  const json = await api.put(`/chats/groups/${gid}`, {
    name: editGroupName.value.trim(),
    avatar_url: editGroupAvatar.value,
  })
  if (json.code !== 0) return

  // Update conductor if changed
  const originalConductor = editingGroup.value.conductor_agent_id || null
  const newConductor = editGroupConductor.value
  if (newConductor !== originalConductor) {
    await api.put(`/chats/groups/${gid}/conductor`, { agent_id: newConductor })
  }

  showGroupSettings.value = false
  await chat.fetchSessions()
  if (selectedId.value === gid) {
    await fetchGroupInfo(selectedId.value)
  }
}

function statusLabel(status: string) {
  const map: Record<string, string> = {
    idle: '空闲',
    busy: '思考中',
    introspecting: '内省中',
  }
  return map[status] || status
}
</script>

<style scoped>
.comm-hub {
  position: fixed; inset: 0;
  background: #0B0F17;
  display: flex;
  z-index: 900;
}

/* Left sidebar */
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
  display: flex; align-items: center; gap: 10px;
  padding: 0 14px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.06);
  flex-shrink: 0;
}
.comm-sidebar-title {
  font-size: 14px; color: #D8E1EC; font-weight: 500;
}

.comm-mode-switch {
  display: flex; gap: 4px;
  padding: 10px 12px;
  flex-shrink: 0;
}
.comm-mode-btn {
  flex: 1; padding: 7px 0;
  background: rgba(255, 255, 255, 0.04);
  border: 1px solid rgba(255, 255, 255, 0.06);
  border-radius: 6px;
  color: #8899AA; font-size: 12px; cursor: pointer;
  transition: all 0.15s;
}
.comm-mode-btn.active {
  background: rgba(0, 229, 201, 0.12);
  border-color: rgba(0, 229, 201, 0.3);
  color: #00E5C9;
}

.comm-list {
  flex: 1; overflow-y: auto;
  padding: 4px 10px 10px;
  display: flex; flex-direction: column; gap: 3px;
}
.comm-item {
  display: flex; align-items: center; gap: 10px;
  padding: 9px 10px;
  background: rgba(255, 255, 255, 0.03);
  border: 1px solid rgba(255, 255, 255, 0.04);
  border-radius: 8px;
  cursor: pointer; transition: all 0.15s;
}
.comm-item:hover {
  background: rgba(0, 229, 201, 0.08);
  border-color: rgba(0, 229, 201, 0.2);
}
.comm-item.active {
  background: rgba(0, 229, 201, 0.12);
  border-color: rgba(0, 229, 201, 0.3);
}
.comm-settings-btn {
  width: 24px; height: 24px;
  display: flex; align-items: center; justify-content: center;
  background: transparent; border: none;
  color: #5A6A7A; font-size: 14px; cursor: pointer;
  border-radius: 4px; flex-shrink: 0;
}
.comm-settings-btn:hover {
  background: rgba(255,255,255,0.06);
  color: #D8E1EC;
}
.comm-avatar {
  width: 34px; height: 34px; border-radius: 50%;
  object-fit: cover; flex-shrink: 0;
}
.comm-avatar.placeholder {
  display: flex; align-items: center; justify-content: center;
  background: rgba(255, 255, 255, 0.08);
  color: #8899AA; font-size: 13px; font-weight: 500;
}
.comm-avatar.placeholder.group {
  background: rgba(0, 229, 201, 0.15);
  color: #00E5C9;
}
.comm-info { flex: 1; min-width: 0; }
.comm-name { font-size: 13px; color: #D8E1EC; font-weight: 500; }
.comm-preview {
  font-size: 11px; color: #5A6A7A;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  margin-top: 2px;
}
.comm-badge {
  min-width: 16px; height: 16px;
  padding: 0 4px;
  background: rgba(239, 68, 68, 0.85);
  color: #fff; font-size: 10px;
  border-radius: 8px;
  display: flex; align-items: center; justify-content: center;
  flex-shrink: 0;
}
.comm-empty {
  color: #5A6A7A; text-align: center; padding: 30px 0; font-size: 12px;
}

/* Main chat area */
.comm-main {
  flex: 1;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  min-width: 0;
}
.comm-welcome {
  flex: 1;
  display: flex; flex-direction: column;
  align-items: center; justify-content: center;
  text-align: center; color: #8899AA;
}
.comm-welcome-icon {
  font-size: 32px; color: #00E5C9;
  margin-bottom: 12px; opacity: 0.5;
}
.comm-welcome-title {
  font-size: 16px; color: #D8E1EC; font-weight: 500;
  margin-bottom: 6px;
}
.comm-welcome-sub {
  font-size: 12px; color: #5A6A7A;
}

/* Right panel */
.comm-right-panel {
  width: 300px;
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  background: rgba(11, 15, 23, 0.95);
  border-left: 1px solid rgba(255, 255, 255, 0.06);
  overflow-y: auto;
}
.rp-header {
  padding: 14px 16px 8px;
  font-size: 13px; font-weight: 600;
  color: #D8E1EC;
  flex-shrink: 0;
}

/* Viewer tabs */
.rp-viewer-tabs {
  display: flex; gap: 4px;
  padding: 0 12px 8px;
  flex-shrink: 0;
}
.rp-tab {
  flex: 1; padding: 5px 0;
  background: rgba(255, 255, 255, 0.04);
  border: 1px solid rgba(255, 255, 255, 0.06);
  border-radius: 5px;
  color: #8899AA; font-size: 11px; cursor: pointer;
}
.rp-tab.active {
  background: rgba(0, 229, 201, 0.12);
  border-color: rgba(0, 229, 201, 0.3);
  color: #00E5C9;
}
.rp-viewer {
  flex: 1;
  min-height: 260px;
  max-height: 400px;
  margin: 0 12px;
  background: rgba(255, 255, 255, 0.02);
  border: 1px solid rgba(255, 255, 255, 0.06);
  border-radius: 10px;
  overflow: hidden;
}

/* Agent info */
.rp-agent-info {
  padding: 12px 16px 16px;
  flex-shrink: 0;
}
.rp-agent-name {
  font-size: 15px; color: #D8E1EC; font-weight: 500;
}
.rp-agent-codename {
  font-size: 12px; color: #5A6A7A; margin-top: 2px;
}
.rp-agent-status {
  display: inline-flex; align-items: center; gap: 4px;
  margin-top: 6px;
  font-size: 11px; color: #5A6A7A;
}
.rp-agent-status::before {
  content: '';
  width: 6px; height: 6px; border-radius: 50%;
}
.rp-agent-status.idle { color: #10B981; }
.rp-agent-status.idle::before { background: #10B981; }
.rp-agent-status.busy { color: #F59E0B; }
.rp-agent-status.busy::before { background: #F59E0B; }
.rp-agent-status.introspecting { color: #00E5C9; }
.rp-agent-status.introspecting::before { background: #00E5C9; }

/* Group info */
.rp-group-name {
  padding: 0 16px 8px;
  font-size: 14px; color: #D8E1EC; font-weight: 500;
}
.rp-section-title {
  padding: 10px 16px 6px;
  font-size: 11px; color: #5A6A7A; font-weight: 500;
  text-transform: uppercase;
  letter-spacing: 0.5px;
}
.rp-member-list {
  padding: 0 12px;
  display: flex; flex-direction: column; gap: 6px;
}
.rp-member {
  display: flex; align-items: center; gap: 8px;
  padding: 6px 8px;
  background: rgba(255, 255, 255, 0.03);
  border-radius: 6px;
}
.rp-member-avatar {
  width: 26px; height: 26px; border-radius: 50%; object-fit: cover;
}
.rp-member-name {
  flex: 1; font-size: 12px; color: #D8E1EC;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.rp-member-badge {
  font-size: 10px; padding: 1px 6px;
  background: rgba(0, 229, 201, 0.15);
  color: #00E5C9; border-radius: 4px;
}
.rp-topic-list {
  padding: 0 16px 16px;
}
.rp-topic {
  font-size: 12px; color: #8899AA;
  padding: 6px 0;
  border-bottom: 1px solid rgba(255, 255, 255, 0.04);
}
.rp-empty {
  color: #5A6A7A; font-size: 12px; text-align: center; padding: 16px 0;
}
.rp-empty-panel {
  flex: 1; display: flex; align-items: center; justify-content: center;
}
.rp-empty-hint {
  color: #5A6A7A; font-size: 13px;
}

/* Create group button in sidebar */
.comm-create-group {
  padding: 0 10px 6px;
}
.create-group-btn {
  width: 100%; padding: 7px;
  background: rgba(0, 229, 201, 0.08);
  border: 1px solid rgba(0, 229, 201, 0.2);
  border-radius: 6px;
  color: #00E5C9; font-size: 12px; cursor: pointer;
  transition: all 0.15s;
}
.create-group-btn:hover {
  background: rgba(0, 229, 201, 0.15);
}

/* Create group modal */
.cg-overlay {
  position: fixed; inset: 0;
  background: rgba(0, 0, 0, 0.5);
  display: flex; align-items: center; justify-content: center;
  z-index: 1000;
}
.cg-panel {
  width: 320px;
  max-height: 80vh;
  background: rgba(11, 15, 23, 0.98);
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: 12px;
  padding: 16px;
  display: flex; flex-direction: column;
  gap: 10px;
}
.cg-header {
  display: flex; justify-content: space-between; align-items: center;
  font-size: 14px; font-weight: 600; color: #D8E1EC;
}
.cg-close {
  background: transparent; border: none;
  color: #5A6A7A; font-size: 18px; cursor: pointer;
}
.cg-close:hover { color: #D8E1EC; }
.cg-panel label {
  font-size: 11px; color: #8899AA;
}
.cg-panel input,
.cg-panel select {
  padding: 8px;
  background: #141B24; border: 1px solid #1E2731;
  border-radius: 6px; color: #D8E1EC; font-size: 12px;
  width: 100%; box-sizing: border-box;
}
.cg-panel input:focus,
.cg-panel select:focus { outline: none; border-color: rgba(0, 229, 201, 0.4); }
.cg-agent-list {
  flex: 1; overflow-y: auto;
  display: flex; flex-direction: column; gap: 4px;
  max-height: 240px;
}
.cg-agent-item {
  display: flex; align-items: center; gap: 8px;
  padding: 6px 8px;
  background: rgba(255, 255, 255, 0.03);
  border-radius: 6px;
  cursor: pointer; transition: all 0.15s;
}
.cg-agent-item:hover {
  background: rgba(255, 255, 255, 0.06);
}
.cg-agent-avatar {
  width: 26px; height: 26px; border-radius: 50%; object-fit: cover;
}
.cg-agent-avatar.placeholder {
  display: flex; align-items: center; justify-content: center;
  background: rgba(255, 255, 255, 0.08);
  color: #8899AA; font-size: 11px; font-weight: 500;
}
.cg-agent-name {
  flex: 1; font-size: 12px; color: #D8E1EC;
}
.cg-submit {
  padding: 10px;
  background: #00E5C9; color: #0B0F17;
  border: none; border-radius: 6px;
  font-weight: 600; font-size: 13px; cursor: pointer;
}
.cg-submit:disabled {
  background: #1E2731; color: #5A6A7A;
  cursor: not-allowed;
}
.gs-avatar-row {
  display: flex; align-items: center; gap: 12px;
}
.gs-avatar-preview {
  width: 60px; height: 60px; border-radius: 50%; object-fit: cover;
}
.gs-avatar-placeholder {
  width: 60px; height: 60px; border-radius: 50%;
  background: rgba(0, 229, 201, 0.15);
  color: #00E5C9;
  display: flex; align-items: center; justify-content: center;
  font-size: 20px; font-weight: 500;
}
.upload-btn {
  padding: 6px 12px;
  background: rgba(255, 255, 255, 0.06);
  border: 1px solid rgba(255, 255, 255, 0.1);
  border-radius: 6px;
  color: #8899AA; font-size: 12px; cursor: pointer;
}
.upload-btn:hover {
  border-color: rgba(0, 229, 201, 0.3);
  color: #00E5C9;
}

/* Memory panel */
.rp-memory-panel {
  padding: 0 12px 16px;
  border-top: 1px solid rgba(255, 255, 255, 0.06);
  margin-top: 8px;
}
.rp-memory-stats {
  display: flex; gap: 8px;
  padding: 0 4px 12px;
}
.rp-stat {
  flex: 1;
  background: rgba(255, 255, 255, 0.03);
  border: 1px solid rgba(255, 255, 255, 0.04);
  border-radius: 8px;
  padding: 10px 4px;
  text-align: center;
}
.rp-stat-num {
  display: block;
  font-size: 16px; font-weight: 600;
  color: #D8E1EC;
}
.rp-stat-label {
  display: block;
  font-size: 10px; color: #5A6A7A;
  margin-top: 2px;
}
.rp-topic-item {
  padding: 8px;
  background: rgba(255, 255, 255, 0.03);
  border: 1px solid rgba(255, 255, 255, 0.04);
  border-radius: 6px;
  margin-bottom: 6px;
}
.rp-topic-header {
  display: flex; align-items: center; justify-content: space-between;
  margin-bottom: 4px;
}
.rp-topic-name {
  font-size: 12px; color: #D8E1EC; font-weight: 500;
}
.rp-topic-importance {
  font-size: 10px; padding: 1px 6px;
  border-radius: 4px; text-transform: uppercase;
}
.rp-topic-importance.high {
  background: rgba(239, 68, 68, 0.15); color: #EF4444;
}
.rp-topic-importance.medium {
  background: rgba(245, 158, 11, 0.15); color: #F59E0B;
}
.rp-topic-importance.low {
  background: rgba(16, 185, 129, 0.15); color: #10B981;
}
.rp-topic-summary {
  font-size: 11px; color: #8899AA;
  line-height: 1.4;
  display: -webkit-box;
  -webkit-line-clamp: 3;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
.rp-topic-meta {
  font-size: 10px; color: #5A6A7A;
  margin-top: 4px;
}
</style>
