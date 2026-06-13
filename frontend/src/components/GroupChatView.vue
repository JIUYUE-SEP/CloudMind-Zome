<template>
  <div class="chat-view" :class="{ 'inline-mode': inline }">
    <header class="chat-header">
      <BackButton @click="close" />
      <div class="group-info" @click="showInfo = !showInfo">
        <span class="name">{{ group?.name || '群聊' }}</span>
        <span class="count">({{ members.length }} 成员)</span>
      </div>
      <button class="header-search-btn" @click="showSearch = !showSearch">Q</button>
      <button class="more-btn" @click="showInfo = !showInfo">⋮</button>
    </header>

    <div v-if="showSearch" class="search-bar">
      <input v-model="searchQuery" @keydown.enter="doSearch" placeholder="搜索消息..." />
      <button @click="doSearch">搜索</button>
      <button @click="showSearch = false; searchQuery = ''; chat.loadMessages(props.groupId)">清空</button>
    </div>

    <div class="chat-body">
      <ChatContainer
        :messages="messages"
        :avatar-resolver="resolveAvatar"
        show-sender
        :conductor-id="group?.conductor_agent_id"
        :show-typing="isTyping"
        @preview-image="previewUrl = $event"
      >
        <template #append>
          <div v-if="intermindActive" class="intermind-divider">
            —— 心智间对话 ——
            <button class="break-btn" @click="breakIntermind">打断</button>
          </div>
        </template>
      </ChatContainer>

      <transition name="slide">
        <div v-if="showInfo" class="member-panel">
          <h4>群成员</h4>
          <div v-for="m in members" :key="m.member_id" class="member-item">
            <img :src="m.avatar || '/uploads/avatars/default.png'" class="m-avatar" />
            <div class="m-info">
              <span class="m-name">{{ m.name }}</span>
              <span v-if="m.is_conductor" class="m-badge">队长</span>
              <span v-else-if="agentStatuses[m.member_id]" :class="['m-status', agentStatuses[m.member_id]]">
                {{ statusLabel(agentStatuses[m.member_id]) }}
              </span>
            </div>
            <div class="m-actions" v-if="isOwner && m.member_type === 'agent'">
              <button
                v-if="!m.is_conductor"
                class="m-action"
                @click="appointConductor(m.member_id)"
              >任命队长</button>
              <button
                class="m-action danger"
                @click="removeMember(m.member_id)"
              >移除</button>
            </div>
          </div>

          <div v-if="isOwner" class="invite-area">
            <button class="invite-btn" @click="showInvite = !showInvite">
              + 邀请心智
            </button>
            <div v-if="showInvite" class="invite-dropdown">
              <div
                v-for="a in availableAgents"
                :key="a.id"
                class="invite-item"
                @click="inviteAgent(a.id)"
              >
                <img :src="a.portrait_url || '/uploads/avatars/default.png'" class="invite-avatar" />
                <span>{{ a.name }}</span>
                <span v-if="a.codename" class="invite-code">{{ a.codename }}</span>
              </div>
              <div v-if="availableAgents.length === 0" class="invite-empty">
                没有可邀请的心智
              </div>
            </div>
          </div>

          <div class="group-settings" v-if="isOwner">
            <h4>群设置</h4>
            <label class="setting-row">
              <span>路由模式</span>
              <select v-model="settings.routing_mode" @change="saveSettings">
                <option value="intent">语义路由</option>
                <option value="mention">仅@回复</option>
                <option value="random">随机回复</option>
              </select>
            </label>
            <label class="setting-row">
              <span>心智互聊</span>
              <input type="checkbox" v-model="settings.intermind_enabled" @change="saveSettings" />
            </label>
            <label class="setting-row">
              <span>随机回复数</span>
              <input type="range" min="1" max="3" v-model.number="settings.random_reply_count" @change="saveSettings" />
              {{ settings.random_reply_count }}
            </label>
            <button v-if="isOwner" class="dissolve-btn" @click="dissolveGroup">解散群聊</button>
          </div>
        </div>
      </transition>
    </div>

    <MessageInput
      v-model:reply-target="replyTarget"
      :members="mentionMembers"
      :placeholder="'输入消息... 使用 @成员名 提及'"
      @send="onSend"
      @typing="onTypingInput"
    />

    <div v-if="previewUrl" class="img-preview-overlay" @click.self="previewUrl = ''">
      <img :src="previewUrl" />
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, watch, onMounted, onBeforeUnmount, computed } from 'vue'
import { useRouter } from 'vue-router'
import { useAuthStore } from '@/stores/auth'
import { useChatStore } from '@/stores/chat'
import { useAgentsStore } from '@/stores/agents'
import { useWebSocket } from '@/composables/useWebSocket'
import { api } from '@/api/client'
import BackButton from '@/components/BackButton.vue'
import ChatContainer from '@/components/chat/ChatContainer.vue'
import MessageInput from '@/components/chat/MessageInput.vue'
import type { MentionMember } from '@/components/chat/MessageInput.vue'

const props = defineProps<{ groupId: string; inline?: boolean }>()
const emit = defineEmits(['close'])
const router = useRouter()

const auth = useAuthStore()
const chat = useChatStore()
const agentsStore = useAgentsStore()
const ws = useWebSocket()

const showInfo = ref(false)
const isTyping = ref(false)
const intermindActive = ref(false)
const group = ref<any>(null)
const members = ref<any[]>([])
const settings = ref({ intermind_enabled: false, random_reply_count: 1, routing_mode: 'intent' })
const messages = ref<any[]>([])
const agentStatuses = ref<Record<string, string>>({})
const showSearch = ref(false)
const searchQuery = ref('')
const previewUrl = ref('')
const replyTarget = ref<any>(null)
const showInvite = ref(false)

const isOwner = computed(() => group.value?.owner_id === auth.user?.user_id)
const availableAgents = computed(() => {
  const memberIds = new Set(members.value.map((m: any) => m.member_id))
  return (agentsStore.list || []).filter((a: any) => !memberIds.has(a.id))
})

const mentionMembers = computed<MentionMember[]>(() =>
  members.value
    .filter((m: any) => m.member_type === 'agent')
    .map((m: any) => ({
      id: m.member_id,
      name: m.name,
      avatar: m.avatar || '/uploads/avatars/default.png',
      badge: m.is_conductor ? '队长' : undefined,
    }))
)

function resolveAvatar(msg: any) {
  if (msg.is_me) return auth.user?.avatar_url || '/uploads/avatars/default.png'
  return memberAvatar(msg.sender_id)
}

async function initGroup() {
  await fetchGroup()
  chat.currentSessionId = props.groupId
  await chat.loadMessages(props.groupId)
  syncMessages()
}

onMounted(async () => {
  await initGroup()
  agentsStore.fetchList()
  window.addEventListener('ws:chat.typing', onTyping as any)
  window.addEventListener('ws:agent.status', onAgentStatus as any)
  window.addEventListener('ws:intermind.start', onIntermindStart as any)
  window.addEventListener('ws:intermind.end', onIntermindEnd as any)
  window.addEventListener('ws:chat.thinking', onThinking as any)
  window.addEventListener('ws:chat.tool_call', onToolCall as any)
  window.addEventListener('ws:chat.ack', onAck as any)
})

watch(() => props.groupId, async (newId, oldId) => {
  if (newId && newId !== oldId) {
    replyTarget.value = null
    await initGroup()
  }
})

onBeforeUnmount(() => {
  window.removeEventListener('ws:chat.typing', onTyping as any)
  window.removeEventListener('ws:agent.status', onAgentStatus as any)
  window.removeEventListener('ws:intermind.start', onIntermindStart as any)
  window.removeEventListener('ws:intermind.end', onIntermindEnd as any)
  window.removeEventListener('ws:chat.thinking', onThinking as any)
  window.removeEventListener('ws:chat.tool_call', onToolCall as any)
  window.removeEventListener('ws:chat.ack', onAck as any)
})

function onTyping(e: any) {
  const p = e.detail
  if (p?.session_id === props.groupId) isTyping.value = p.is_typing
}
function onAgentStatus(e: any) {
  const p = e.detail
  if (p?.agent_id) agentStatuses.value[p.agent_id] = p.status
}
function onAck(e: any) { /* placeholder */ }

function onTypingInput(isTyping: boolean) {
  ws.sendTyping(props.groupId, isTyping)
}

async function doSearch() {
  if (!searchQuery.value.trim()) return
  await chat.loadMessages(props.groupId, searchQuery.value.trim())
}

function onIntermindStart(e: any) {
  const p = e.detail
  if (p?.session_id === props.groupId) intermindActive.value = true
}
function onIntermindEnd(e: any) {
  const p = e.detail
  if (p?.session_id === props.groupId) intermindActive.value = false
}

function onThinking(e: any) {
  const p = e.detail
  if (p?.session_id !== props.groupId) return
  const existing = messages.value.find(
    (m: any) => m.batch_id === p.batch_id && m.sender_id === p.agent_id
  )
  if (existing) {
    existing.reasoning = (existing.reasoning || '') + p.thinking
  } else {
    messages.value.push({
      id: `batch_${p.batch_id}`,
      sender_id: p.agent_id, sender_name: p.agent_name,
      sender_type: 'agent', content_type: 'text', content: '',
      reasoning: p.thinking, tool_calls: [],
      is_generating: true,
      batch_id: p.batch_id, timestamp: p.timestamp, is_me: false,
    })
  }
}

function onToolCall(e: any) {
  const p = e.detail
  if (p?.session_id !== props.groupId) return
  const existing = messages.value.find(
    (m: any) => m.batch_id === p.batch_id && m.sender_id === p.agent_id
  )
  if (existing) {
    const tc = existing.tool_calls?.find((t: any) => t.name === p.tool_name)
    if (tc) {
      tc.input = p.tool_input
    } else {
      existing.tool_calls = existing.tool_calls || []
      existing.tool_calls.push({ name: p.tool_name, input: p.tool_input })
    }
  } else {
    messages.value.push({
      id: `batch_${p.batch_id}`,
      sender_id: p.agent_id, sender_name: p.agent_name,
      sender_type: 'agent', content_type: 'text', content: '',
      reasoning: '', tool_calls: [{ name: p.tool_name, input: p.tool_input }],
      is_generating: true,
      batch_id: p.batch_id, timestamp: p.timestamp, is_me: false,
    })
  }
}

watch(() => chat.messagesMap[props.groupId], () => syncMessages(), { deep: true })

function syncMessages() {
  const list = chat.messagesMap[props.groupId] || []
  for (const msg of list) {
    const localId = msg.batch_id ? `batch_${msg.batch_id}` : msg.id
    const existing = messages.value.find((m: any) => m.id === localId)
    if (existing) {
      existing.content = msg.content || ''
      existing.timestamp = msg.timestamp
      existing.is_generating = msg.is_generating ?? false
      // Preserve accumulated reasoning/tool_calls from streaming events
      if (msg.reasoning !== undefined && msg.reasoning !== null) existing.reasoning = msg.reasoning
      if (msg.tool_calls !== undefined && msg.tool_calls !== null) existing.tool_calls = msg.tool_calls
      if (existing.is_generating) {
        if (existing._genTimeout) clearTimeout(existing._genTimeout)
        existing._genTimeout = setTimeout(() => { existing.is_generating = false }, 3000)
      }
    } else {
      messages.value.push({
        ...msg,
        id: localId,
        reasoning: msg.reasoning ?? '',
        tool_calls: msg.tool_calls ?? [],
        is_generating: msg.is_generating ?? false,
      })
    }
  }
  messages.value.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime())
}

async function fetchGroup() {
  const json = await api.get(`/chats/groups/${props.groupId}`)
  if (json.code === 0) {
    group.value = json.data
    members.value = json.data.members
    settings.value = { ...settings.value, ...json.data.settings }
  }
}

function memberAvatar(senderId: string) {
  const m = members.value.find(x => x.member_id === senderId)
  return m?.avatar || '/uploads/avatars/default.png'
}

async function onSend(payload: { content: string; content_type: string; reply_to?: string }) {
  const text = payload.content.trim()

  // Save task blueprint command
  const cleanText = text.replace(/[。，！？.,!?]/g, '').trim()
  if (cleanText === '保存这个流程' || cleanText === '保存流程') {
    const json = await api.post('/actions/from-task', { session_id: props.groupId, name: '群聊任务蓝图' })
    if (json.code === 0) {
      messages.value.push({
        id: `sys_${Date.now()}`,
        sender_id: 'system', sender_name: '系统',
        content: `流程已保存到行动中心：${json.data.name}`,
        content_type: 'text', timestamp: new Date().toISOString(), is_me: false,
      })
    } else {
      messages.value.push({
        id: `sys_${Date.now()}`,
        sender_id: 'system', sender_name: '系统',
        content: '保存失败：' + (json.message || '无可用流程'),
        content_type: 'text', timestamp: new Date().toISOString(), is_me: false,
      })
    }
    return
  }

  ws.sendChat(props.groupId, payload.content, {
    content_type: payload.content_type,
    reply_to: payload.reply_to,
  })
}

async function dissolveGroup() {
  if (!confirm('确定要解散这个群聊吗？此操作不可撤销。')) return
  const json = await api.delete(`/chats/groups/${props.groupId}`)
  if (json.code === 0) {
    await chat.fetchSessions()
    close()
  }
}

function close() {
  chat.currentSessionId = null
  if (props.inline) { emit('close') } else { router.back() }
}

function breakIntermind() {
  ws.sendChat(props.groupId, '[打断]')
  intermindActive.value = false
}

async function appointConductor(agentId: string) {
  const json = await api.put(`/chats/groups/${props.groupId}/conductor`, { agent_id: agentId })
  if (json.code === 0) await fetchGroup()
}

async function saveSettings() {
  await api.put(`/chats/groups/${props.groupId}`, { settings: settings.value })
}

async function removeMember(memberId: string) {
  if (!confirm('确定要移除该心智吗？')) return
  const json = await api.delete(`/chats/groups/${props.groupId}/members/${memberId}`)
  if (json.code === 0) {
    await fetchGroup()
  }
}

async function inviteAgent(agentId: string) {
  const json = await api.post(`/chats/groups/${props.groupId}/members`, { member_ids: [agentId] })
  if (json.code === 0) {
    showInvite.value = false
    await fetchGroup()
  } else {
    alert(json.message || '邀请失败')
  }
}

function statusLabel(status: string) {
  const map: Record<string, string> = { idle: '空闲', busy: '思考中', introspecting: '内省中' }
  return map[status] || status
}
</script>

<style scoped>
.chat-view { position: fixed; inset: 0; background: #0B0F17; display: flex; flex-direction: column; z-index: 900; }
.chat-view.inline-mode { position: relative; z-index: auto; height: 100%; }
.chat-header { height: 56px; display: flex; align-items: center; gap: 12px; padding: 0 16px; background: rgba(11,15,23,0.9); border-bottom: 1px solid rgba(255,255,255,0.06); }
.header-search-btn { width: 32px; height: 32px; border-radius: 6px; background: rgba(255,255,255,0.06); border: 1px solid rgba(255,255,255,0.1); color: #8899AA; font-size: 12px; cursor: pointer; margin-left: auto; }
.header-search-btn:hover { border-color: rgba(0,229,201,0.3); color: #00E5C9; }
.search-bar { display: flex; gap: 8px; padding: 8px 16px; background: rgba(11,15,23,0.9); border-bottom: 1px solid rgba(255,255,255,0.06); }
.search-bar input { flex: 1; padding: 8px 12px; background: #141B24; border: 1px solid #1E2731; border-radius: 6px; color: #D8E1EC; font-size: 13px; }
.search-bar button { padding: 6px 12px; background: rgba(0,229,201,0.12); border: 1px solid rgba(0,229,201,0.25); border-radius: 6px; color: #00E5C9; font-size: 12px; cursor: pointer; }
.more-btn { background: transparent; border: none; color: #D8E1EC; font-size: 20px; cursor: pointer; }
.group-info { flex: 1; cursor: pointer; display: flex; align-items: center; gap: 8px; }
.name { font-size: 15px; color: #D8E1EC; font-weight: 500; }
.count { font-size: 12px; color: #5A6A7A; }

.chat-body { flex: 1; display: flex; overflow: hidden; }

.intermind-divider { align-self: center; font-size: 12px; color: #5A6A7A; display: flex; align-items: center; gap: 10px; padding: 8px 0; }
.break-btn { padding: 2px 8px; font-size: 11px; border: 1px solid #FF6B35; color: #FF6B35; background: transparent; border-radius: 4px; cursor: pointer; }

.member-panel { width: 280px; background: rgba(20,27,36,0.95); border-left: 1px solid rgba(255,255,255,0.06); padding: 16px; overflow-y: auto; }
.member-panel h4 { margin: 0 0 12px; font-size: 14px; color: #D8E1EC; }
.member-item { display: flex; align-items: center; gap: 10px; padding: 8px 0; }
.m-avatar { width: 32px; height: 32px; border-radius: 50%; object-fit: cover; }
.m-info { flex: 1; display: flex; flex-direction: column; }
.m-name { font-size: 13px; color: #D8E1EC; }
.m-badge { font-size: 11px; color: #FFB800; }
.m-status { font-size: 11px; display: flex; align-items: center; gap: 4px; }
.m-status::before { content: ''; display: inline-block; width: 6px; height: 6px; border-radius: 50%; }
.m-status.idle { color: #5A6A7A; }
.m-status.idle::before { background: #5A6A7A; }
.m-status.busy { color: #FFB800; }
.m-status.busy::before { background: #FFB800; }
.m-status.introspecting { color: #00E5C9; }
.m-status.introspecting::before { background: #00E5C9; }
.m-action { padding: 4px 8px; font-size: 11px; border: 1px solid #00E5C9; color: #00E5C9; background: transparent; border-radius: 4px; cursor: pointer; }
.m-action.danger { border-color: rgba(239,68,68,0.4); color: #EF4444; }
.m-action.danger:hover { background: rgba(239,68,68,0.15); }
.m-actions { display: flex; gap: 4px; margin-left: auto; }

.invite-area { margin-top: 12px; border-top: 1px solid rgba(255,255,255,0.06); padding-top: 12px; }
.invite-btn { width: 100%; padding: 8px; background: rgba(0,229,201,0.08); border: 1px dashed rgba(0,229,201,0.3); color: #00E5C9; border-radius: 6px; font-size: 13px; cursor: pointer; }
.invite-btn:hover { background: rgba(0,229,201,0.15); }
.invite-dropdown { margin-top: 8px; border: 1px solid rgba(255,255,255,0.06); border-radius: 6px; background: #141B24; max-height: 200px; overflow-y: auto; }
.invite-item { display: flex; align-items: center; gap: 8px; padding: 8px 12px; cursor: pointer; border-bottom: 1px solid rgba(255,255,255,0.04); }
.invite-item:hover { background: rgba(0,229,201,0.06); }
.invite-item:last-child { border-bottom: none; }
.invite-avatar { width: 28px; height: 28px; border-radius: 50%; object-fit: cover; }
.invite-code { font-size: 11px; color: #667788; }
.invite-empty { padding: 12px; text-align: center; color: #667788; font-size: 13px; }

.group-settings { margin-top: 20px; border-top: 1px solid rgba(255,255,255,0.06); padding-top: 12px; }
.setting-row { display: flex; align-items: center; justify-content: space-between; padding: 8px 0; font-size: 13px; color: #8899AA; }
.setting-row select { padding: 4px 8px; background: #141B24; border: 1px solid #1E2731; border-radius: 4px; color: #D8E1EC; font-size: 12px; }
.dissolve-btn { margin-top: 12px; width: 100%; padding: 8px; background: rgba(239,68,68,0.1); border: 1px solid rgba(239,68,68,0.3); color: #EF4444; border-radius: 6px; font-size: 12px; cursor: pointer; }
.dissolve-btn:hover { background: rgba(239,68,68,0.2); }

.slide-enter-active, .slide-leave-active { transition: transform 0.25s ease; }
.slide-enter-from, .slide-leave-to { transform: translateX(100%); }

.img-preview-overlay { position: fixed; inset: 0; background: rgba(0,0,0,0.85); z-index: 1000; display: flex; align-items: center; justify-content: center; }
.img-preview-overlay img { max-width: 90vw; max-height: 90vh; border-radius: 8px; }
</style>
