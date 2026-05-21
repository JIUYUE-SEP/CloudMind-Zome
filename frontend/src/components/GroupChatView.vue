<template>
  <div class="chat-view" :class="{ 'inline-mode': inline }">
    <header class="chat-header">
      <BackButton @click="close" />
      <div class="group-info" @click="showInfo = !showInfo">
        <span class="name">{{ group?.name || '群聊' }}</span>
        <span class="count">({{ members.length }} 成员)</span>
      </div>
      <button class="more-btn" @click="showInfo = !showInfo">⋮</button>
    </header>

    <div class="chat-body">
      <!-- Message area -->
      <div ref="msgArea" class="message-area">
        <div
          v-for="msg in messages"
          :key="msg.id"
          class="msg-row"
          :class="msg.is_me ? 'me' : 'them'"
        >
          <img
            v-if="!msg.is_me && msg.sender_type === 'agent'"
            :src="memberAvatar(msg.sender_id)"
            class="msg-avatar"
          />
          <img
            v-else-if="!msg.is_me"
            :src="'/uploads/avatars/default.png'"
            class="msg-avatar"
          />
          <div class="bubble">
            <div class="sender" v-if="!msg.is_me">
              {{ msg.sender_name }}
              <span v-if="msg.sender_id === group?.conductor_agent_id" class="crown">队长</span>
            </div>
            <div class="text">{{ msg.content }}</div>
            <div class="time">{{ formatTime(msg.timestamp) }}</div>
          </div>
          <img
            v-if="msg.is_me"
            :src="auth.user?.avatar_url || '/uploads/avatars/default.png'"
            class="msg-avatar me-avatar"
          />
        </div>

        <!-- Intermind divider -->
        <div v-if="intermindActive" class="intermind-divider">
          —— 心智间对话 ——
          <button class="break-btn" @click="breakIntermind">打断</button>
        </div>

        <!-- Inline reply box for conductor Q&A -->
        <div v-if="showInlineReply" class="inline-reply">
          <input
            v-model="inlineText"
            placeholder="回复队长的问题..."
            @keydown.enter.prevent="sendInline"
          />
          <button @click="sendInline">发送</button>
        </div>

        <div v-if="isTyping" class="typing-indicator">
          <span></span><span></span><span></span>
        </div>
      </div>

      <!-- Member side panel (collapsible) -->
      <transition name="slide">
        <div v-if="showInfo" class="member-panel">
          <h4>群成员</h4>
          <div
            v-for="m in members"
            :key="m.member_id"
            class="member-item"
          >
            <img :src="m.avatar || '/uploads/avatars/default.png'" class="m-avatar" />
            <div class="m-info">
              <span class="m-name">{{ m.name }}</span>
              <span v-if="m.is_conductor" class="m-badge">队长</span>
              <span v-else-if="agentStatuses[m.member_id]" :class="['m-status', agentStatuses[m.member_id]]">
                {{ statusLabel(agentStatuses[m.member_id]) }}
              </span>
            </div>
            <button
              v-if="isOwner && m.member_type === 'agent' && !m.is_conductor"
              class="m-action"
              @click="appointConductor(m.member_id)"
            >任命队长</button>
          </div>

          <div class="group-settings" v-if="isOwner">
            <h4>群设置</h4>
            <label class="setting-row">
              <span>心智互聊</span>
              <input type="checkbox" v-model="settings.intermind_enabled" @change="saveSettings" />
            </label>
            <label class="setting-row">
              <span>随机回复数</span>
              <input type="range" min="1" max="3" v-model.number="settings.random_reply_count" @change="saveSettings" />
              {{ settings.random_reply_count }}
            </label>
          </div>
        </div>
      </transition>
    </div>

    <div class="input-area">
      <div class="mention-box" v-if="showMention">
        <div
          v-for="m in mentionableMembers"
          :key="m.member_id"
          class="mention-item"
          @click="selectMention(m)"
        >
          <img :src="m.avatar || '/uploads/avatars/default.png'" class="mention-avatar" />
          <span class="mention-name">{{ m.name }}</span>
          <span v-if="m.is_conductor" class="mention-badge">队长</span>
        </div>
      </div>
      <textarea
        ref="textareaRef"
        v-model="draft"
        rows="1"
        placeholder="输入消息... 使用 @成员名 提及"
        @input="onInput"
        @keydown.enter.prevent="send"
        @keydown.esc="showMention = false"
      />
      <button class="send-btn" @click="send">发送</button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, watch, nextTick, onMounted, onBeforeUnmount, computed } from 'vue'
import { useRouter } from 'vue-router'
import { useAuthStore } from '@/stores/auth'
import { useChatStore } from '@/stores/chat'
import { useWebSocket } from '@/composables/useWebSocket'
import { api } from '@/api/client'
import BackButton from '@/components/BackButton.vue'

const props = defineProps<{ groupId: string; inline?: boolean }>()
const emit = defineEmits(['close'])
const router = useRouter()

const auth = useAuthStore()
const chat = useChatStore()
const ws = useWebSocket()

const draft = ref('')
const msgArea = ref<HTMLDivElement>()
const textareaRef = ref<HTMLTextAreaElement>()
const showInfo = ref(false)
const isTyping = ref(false)
const inlineText = ref('')
const showInlineReply = ref(false)
const intermindActive = ref(false)
const showMention = ref(false)
const mentionStart = ref(0)

const group = ref<any>(null)
const members = ref<any[]>([])
const settings = ref({ intermind_enabled: false, random_reply_count: 1 })
const messages = ref<any[]>([])
const agentStatuses = ref<Record<string, string>>({})

const isOwner = computed(() => group.value?.owner_id === auth.user?.user_id)

const mentionableMembers = computed(() => {
  return members.value.filter((m: any) => m.member_type === 'agent')
})

async function initGroup() {
  await fetchGroup()
  chat.currentSessionId = props.groupId
  await chat.loadMessages(props.groupId)
  syncMessages()
}

onMounted(async () => {
  await initGroup()
  window.addEventListener('ws:chat.typing', onTyping as any)
  window.addEventListener('ws:agent.status', onAgentStatus as any)
  window.addEventListener('ws:intermind.start', onIntermindStart as any)
  window.addEventListener('ws:intermind.end', onIntermindEnd as any)
})

watch(() => props.groupId, async (newId, oldId) => {
  if (newId && newId !== oldId) {
    await initGroup()
  }
})

onBeforeUnmount(() => {
  window.removeEventListener('ws:chat.typing', onTyping as any)
  window.removeEventListener('ws:agent.status', onAgentStatus as any)
  window.removeEventListener('ws:intermind.start', onIntermindStart as any)
  window.removeEventListener('ws:intermind.end', onIntermindEnd as any)
})

function onTyping(e: any) {
  const p = e.detail
  if (p?.session_id === props.groupId) {
    isTyping.value = p.is_typing
  }
}

function onAgentStatus(e: any) {
  const p = e.detail
  if (p?.agent_id) {
    agentStatuses.value[p.agent_id] = p.status
  }
}

function onIntermindStart(e: any) {
  const p = e.detail
  if (p?.session_id === props.groupId) intermindActive.value = true
}
function onIntermindEnd(e: any) {
  const p = e.detail
  if (p?.session_id === props.groupId) intermindActive.value = false
}

watch(() => chat.messagesMap[props.groupId], () => {
  syncMessages()
}, { deep: true })

function syncMessages() {
  const list = chat.messagesMap[props.groupId] || []
  messages.value = list
  const last = list[list.length - 1]
  if (!last) return
  // Close inline reply if user just sent a message
  if (last.sender_type === 'user' && last.is_me) {
    showInlineReply.value = false
  }
  // Detect conductor Q&A inline reply trigger
  if (last.sender_type === 'agent' && last.sender_id === group.value?.conductor_agent_id) {
    if (last.content.includes('？') || last.content.includes('?') || last.content.includes('确认')) {
      showInlineReply.value = true
    }
  }
  nextTick(() => {
    msgArea.value?.scrollTo({ top: msgArea.value.scrollHeight, behavior: 'smooth' })
  })
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

function onInput() {
  const el = textareaRef.value
  if (!el) return
  const cursor = el.selectionStart
  const text = draft.value
  const before = text.slice(0, cursor)
  const lastAt = before.lastIndexOf('@')

  if (lastAt >= 0) {
    const between = before.slice(lastAt + 1)
    if (!between.includes(' ') && !between.includes('\n')) {
      mentionStart.value = lastAt
      showMention.value = true
      return
    }
  }
  showMention.value = false
}

function selectMention(m: any) {
  const el = textareaRef.value
  if (!el) return
  const cursor = el.selectionStart
  const text = draft.value
  const before = text.slice(0, mentionStart.value)
  const after = text.slice(cursor)
  draft.value = before + '@' + m.name + ' ' + after
  showMention.value = false
  nextTick(() => {
    const pos = mentionStart.value + m.name.length + 2
    el.setSelectionRange(pos, pos)
    el.focus()
  })
}

function send() {
  const text = draft.value.trim()
  if (!text) return
  ws.sendChat(props.groupId, text)
  draft.value = ''
  showMention.value = false
}

function sendInline() {
  const text = inlineText.value.trim()
  if (!text) return
  ws.sendChat(props.groupId, text)
  inlineText.value = ''
  showInlineReply.value = false
}

function close() {
  chat.currentSessionId = null
  if (props.inline) {
    emit('close')
  } else {
    router.back()
  }
}

function breakIntermind() {
  ws.sendChat(props.groupId, '[打断]')
  intermindActive.value = false
}

async function appointConductor(agentId: string) {
  const json = await api.put(`/chats/groups/${props.groupId}/conductor`, { agent_id: agentId })
  if (json.code === 0) {
    await fetchGroup()
  }
}

async function saveSettings() {
  await api.put(`/chats/groups/${props.groupId}`, { settings: settings.value })
}

function statusLabel(status: string) {
  const map: Record<string, string> = {
    idle: '空闲',
    busy: '思考中',
    introspecting: '内省中',
  }
  return map[status] || status
}

function formatTime(ts: string) {
  if (!ts) return ''
  const d = new Date(ts)
  return `${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}`
}
</script>

<style scoped>
.chat-view {
  position: fixed; inset: 0;
  background: #0B0F17;
  display: flex; flex-direction: column;
  z-index: 900;
}
.chat-view.inline-mode {
  position: relative;
  z-index: auto;
  height: 100%;
}
.chat-header {
  height: 56px;
  display: flex; align-items: center; gap: 12px;
  padding: 0 16px;
  background: rgba(11,15,23,0.9);
  border-bottom: 1px solid rgba(255,255,255,0.06);
}
.more-btn {
  background: transparent; border: none; color: #D8E1EC;
  font-size: 20px; cursor: pointer;
}
.group-info { flex: 1; cursor: pointer; display: flex; align-items: center; gap: 8px; }
.name { font-size: 15px; color: #D8E1EC; font-weight: 500; }
.count { font-size: 12px; color: #5A6A7A; }

.chat-body {
  flex: 1; display: flex; overflow: hidden;
}
.message-area {
  flex: 1; overflow-y: auto;
  padding: 16px;
  display: flex; flex-direction: column; gap: 10px;
}
.msg-row { display: flex; align-items: flex-start; gap: 8px; }
.msg-row.me { justify-content: flex-end; }
.msg-row.them { justify-content: flex-start; }
.msg-avatar { width: 28px; height: 28px; border-radius: 50%; object-fit: cover; margin-top: 4px; }

.bubble {
  max-width: 70%;
  padding: 10px 14px;
  border-radius: 12px;
  font-size: 14px; line-height: 1.5;
}
.msg-row.them .bubble {
  background: #1E2731; color: #D8E1EC;
  border-top-left-radius: 4px;
}
.msg-row.me .bubble {
  background: #E8EDF2; color: #0B0F17;
  border-top-right-radius: 4px;
}
.sender { font-size: 11px; color: #8899AA; margin-bottom: 4px; display: flex; align-items: center; gap: 6px; }
.crown { color: #FFB800; font-size: 11px; }
.text { white-space: pre-wrap; word-break: break-word; }
.time { font-size: 10px; color: #5A6A7A; margin-top: 4px; text-align: right; }
.msg-row.me .time { color: #5A6A7A; }

.intermind-divider {
  align-self: center;
  font-size: 12px; color: #5A6A7A;
  display: flex; align-items: center; gap: 10px;
  padding: 8px 0;
}
.break-btn {
  padding: 2px 8px; font-size: 11px;
  border: 1px solid #FF6B35; color: #FF6B35;
  background: transparent; border-radius: 4px; cursor: pointer;
}

.inline-reply {
  display: flex; gap: 8px; align-items: center;
  padding: 10px 14px;
  background: rgba(20,27,36,0.9);
  border: 1px solid rgba(0,229,201,0.2);
  border-radius: 8px;
  margin-top: 4px;
}
.inline-reply input {
  flex: 1; background: transparent; border: none; color: #D8E1EC;
  font-size: 14px;
}
.inline-reply input:focus { outline: none; }
.inline-reply button {
  padding: 6px 12px; background: #00E5C9; color: #0B0F17;
  border: none; border-radius: 6px; font-weight: 600; cursor: pointer;
}

.typing-indicator {
  display: flex; gap: 4px; align-self: flex-start;
  padding: 12px 14px;
  background: #1E2731; border-radius: 12px;
}
.typing-indicator span {
  width: 6px; height: 6px; background: #5A6A7A;
  border-radius: 50%; animation: bounce 1.4s infinite ease-in-out both;
}
.typing-indicator span:nth-child(1) { animation-delay: -0.32s; }
.typing-indicator span:nth-child(2) { animation-delay: -0.16s; }
@keyframes bounce {
  0%, 80%, 100% { transform: scale(0.6); }
  40% { transform: scale(1); }
}

.member-panel {
  width: 280px;
  background: rgba(20,27,36,0.95);
  border-left: 1px solid rgba(255,255,255,0.06);
  padding: 16px;
  overflow-y: auto;
}
.member-panel h4 { margin: 0 0 12px; font-size: 14px; color: #D8E1EC; }
.member-item {
  display: flex; align-items: center; gap: 10px;
  padding: 8px 0;
}
.m-avatar { width: 32px; height: 32px; border-radius: 50%; object-fit: cover; }
.m-info { flex: 1; display: flex; flex-direction: column; }
.m-name { font-size: 13px; color: #D8E1EC; }
.m-badge { font-size: 11px; color: #FFB800; }
.m-status {
  font-size: 11px;
  display: flex;
  align-items: center;
  gap: 4px;
}
.m-status::before {
  content: '';
  display: inline-block;
  width: 6px; height: 6px;
  border-radius: 50%;
}
.m-status.idle { color: #5A6A7A; }
.m-status.idle::before { background: #5A6A7A; }
.m-status.busy { color: #FFB800; }
.m-status.busy::before { background: #FFB800; }
.m-status.introspecting { color: #00E5C9; }
.m-status.introspecting::before { background: #00E5C9; }
.m-action {
  padding: 4px 8px; font-size: 11px;
  border: 1px solid #00E5C9; color: #00E5C9;
  background: transparent; border-radius: 4px; cursor: pointer;
}

.group-settings { margin-top: 20px; border-top: 1px solid rgba(255,255,255,0.06); padding-top: 12px; }
.setting-row {
  display: flex; align-items: center; justify-content: space-between;
  padding: 8px 0; font-size: 13px; color: #8899AA;
}

.input-area {
  display: flex; gap: 8px; align-items: flex-end;
  padding: 10px 16px 16px;
  border-top: 1px solid rgba(255,255,255,0.06);
  background: #0B0F17;
  position: relative;
}
.input-area textarea {
  flex: 1; min-height: 40px; max-height: 120px;
  background: #141B24; border: 1px solid #1E2731;
  border-radius: 8px; color: #D8E1EC;
  padding: 10px 12px; font-size: 14px; resize: none;
}
.input-area textarea:focus { outline: none; border-color: #00E5C9; }

.mention-box {
  position: absolute;
  bottom: calc(100% + 6px);
  left: 16px;
  right: 80px;
  max-height: 200px;
  overflow-y: auto;
  background: #141B24;
  border: 1px solid #1E2731;
  border-radius: 8px;
  z-index: 100;
}
.mention-item {
  display: flex; align-items: center; gap: 8px;
  padding: 8px 12px;
  cursor: pointer;
  transition: background 0.1s;
}
.mention-item:hover {
  background: rgba(0, 229, 201, 0.1);
}
.mention-avatar {
  width: 24px; height: 24px; border-radius: 50%; object-fit: cover;
}
.mention-name {
  font-size: 13px; color: #D8E1EC;
}
.mention-badge {
  font-size: 10px; padding: 1px 5px;
  background: rgba(0, 229, 201, 0.15);
  color: #00E5C9; border-radius: 4px;
}
.send-btn {
  padding: 10px 18px; background: #00E5C9; color: #0B0F17;
  border: none; border-radius: 8px; font-weight: 600; cursor: pointer;
}

.slide-enter-active, .slide-leave-active { transition: transform 0.25s ease; }
.slide-enter-from, .slide-leave-to { transform: translateX(100%); }
</style>
