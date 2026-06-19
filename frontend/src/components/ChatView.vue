<template>
  <div class="chat-view" :class="{ 'inline-mode': inline }">
    <header class="chat-header">
      <BackButton @click="close" />
      <img v-if="session?.target_avatar" :src="$uploadUrl(session.target_avatar)" class="avatar" />
      <div class="header-info">
        <span class="name">{{ session?.target_name || '...' }}</span>
        <div class="status-row" v-if="session?.type === 'private'">
          <span class="status-dot" :class="agentStatus"></span>
          <span class="status-text">{{ statusLabel }}</span>
        </div>
      </div>
      <button class="header-search-btn" @click="showSearch = !showSearch">Q</button>
    </header>

    <div v-if="showSearch" class="search-bar">
      <input v-model="searchQuery" @keydown.enter="doSearch" placeholder="搜索消息..." />
      <button @click="doSearch">搜索</button>
      <button @click="showSearch = false; searchQuery = ''; chat.loadMessages(props.sessionId)">清空</button>
    </div>

    <ChatContainer
      :messages="messages"
      :avatar-resolver="resolveAvatar"
      show-sender
      :show-typing="isTyping"
      @preview-image="previewUrl = $event"
    />

    <MessageInput
      v-model:reply-target="replyTarget"
      :placeholder="'输入消息...'"
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
import { useWebSocket } from '@/composables/useWebSocket'
import { getUploadUrl } from '@/api/client'
import BackButton from '@/components/BackButton.vue'
import ChatContainer from '@/components/chat/ChatContainer.vue'
import MessageInput from '@/components/chat/MessageInput.vue'

const props = defineProps<{ sessionId: string; inline?: boolean }>()
const emit = defineEmits(['close'])
const router = useRouter()

const auth = useAuthStore()
const chat = useChatStore()
const ws = useWebSocket()

const isTyping = ref(false)
const agentStatus = ref<'idle' | 'busy' | 'introspecting'>('idle')
const messages = ref<any[]>([])
const showSearch = ref(false)
const searchQuery = ref('')
const previewUrl = ref('')
const replyTarget = ref<any>(null)

const session = computed(() =>
  chat.sessions.find(s => s.session_id === props.sessionId)
)

const statusLabel = computed(() => {
  if (agentStatus.value === 'busy') return '思考中'
  if (agentStatus.value === 'introspecting') return '内省中'
  return '空闲'
})

function resolveAvatar(msg: any) {
  if (msg.is_me) return getUploadUrl(auth.user?.avatar_url) || '/uploads/avatars/default.png'
  return getUploadUrl(session.value?.target_avatar) || '/uploads/avatars/default.png'
}

async function initSession() {
  chat.currentSessionId = props.sessionId
  await chat.loadMessages(props.sessionId)
  if (!chat.sessions.length) await chat.fetchSessions()
  syncMessages()
}

onMounted(async () => {
  await initSession()
  window.addEventListener('ws:chat.typing', onTyping as any)
  window.addEventListener('ws:agent.status', onAgentStatus as any)
  window.addEventListener('ws:chat.thinking', onThinking as any)
  window.addEventListener('ws:chat.tool_call', onToolCall as any)
  window.addEventListener('ws:chat.ack', onAck as any)
})

watch(() => props.sessionId, async (newId, oldId) => {
  if (newId && newId !== oldId) {
    replyTarget.value = null
    await initSession()
  }
})

onBeforeUnmount(() => {
  window.removeEventListener('ws:chat.typing', onTyping as any)
  window.removeEventListener('ws:agent.status', onAgentStatus as any)
  window.removeEventListener('ws:chat.thinking', onThinking as any)
  window.removeEventListener('ws:chat.tool_call', onToolCall as any)
  window.removeEventListener('ws:chat.ack', onAck as any)
})

function onTyping(e: any) {
  const p = e.detail
  if (p?.session_id === props.sessionId) isTyping.value = p.is_typing
}
function onAgentStatus(e: any) {
  const p = e.detail
  if (p?.agent_id === session.value?.target_id) agentStatus.value = p.status
}
function onAck(e: any) { /* placeholder for ack handling */ }

function onTypingInput(isTyping: boolean) {
  ws.sendTyping(props.sessionId, isTyping)
}

async function doSearch() {
  if (!searchQuery.value.trim()) return
  await chat.loadMessages(props.sessionId, searchQuery.value.trim())
}

function onThinking(e: any) {
  const p = e.detail
  if (p?.session_id !== props.sessionId) return
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
  if (p?.session_id !== props.sessionId) return
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

watch(() => chat.messagesMap[props.sessionId], () => syncMessages(), { deep: true })

function syncMessages() {
  const list = chat.messagesMap[props.sessionId] || []
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

function onSend(payload: { content: string; content_type: string; reply_to?: string }) {
  ws.sendChat(props.sessionId, payload.content, {
    content_type: payload.content_type,
    reply_to: payload.reply_to,
  })
}

function close() {
  chat.currentSessionId = null
  if (props.inline) { emit('close') } else { router.back() }
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

.avatar { width: 28px; height: 28px; border-radius: 50%; object-fit: cover; }
.header-info { display: flex; flex-direction: column; gap: 2px; }
.name { font-size: 15px; color: #D8E1EC; font-weight: 500; }
.status-row { display: flex; align-items: center; gap: 4px; }
.status-dot { width: 6px; height: 6px; border-radius: 50%; }
.status-dot.idle { background: #10B981; }
.status-dot.busy { background: #F59E0B; animation: pulse-dot 1.5s ease-in-out infinite; }
@keyframes pulse-dot { 0%, 100% { opacity: 1; } 50% { opacity: 0.4; } }
.status-text { font-size: 11px; color: #5A6A7A; }

.img-preview-overlay { position: fixed; inset: 0; background: rgba(0,0,0,0.85); z-index: 1000; display: flex; align-items: center; justify-content: center; }
.img-preview-overlay img { max-width: 90vw; max-height: 90vh; border-radius: 8px; }
</style>
