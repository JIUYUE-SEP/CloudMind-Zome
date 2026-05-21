<template>
  <div class="chat-view" :class="{ 'inline-mode': inline }">
    <header class="chat-header">
      <BackButton @click="close" />
      <img v-if="session?.target_avatar" :src="session.target_avatar" class="avatar" />
      <div class="header-info">
        <span class="name">{{ session?.target_name || '...' }}</span>
        <div class="status-row" v-if="session?.type === 'private'">
          <span class="status-dot" :class="agentStatus"></span>
          <span class="status-text">{{ statusLabel }}</span>
        </div>
      </div>
    </header>

    <div ref="msgArea" class="message-area">
      <div
        v-for="msg in messages"
        :key="msg.id"
        class="msg-row"
        :class="msg.is_me ? 'me' : 'them'"
      >
        <img
          v-if="!msg.is_me"
          :src="session?.target_avatar || '/uploads/avatars/default.png'"
          class="msg-avatar"
        />
        <div class="bubble">
          <div class="sender" v-if="!msg.is_me">{{ msg.sender_name }}</div>
          <div class="text">{{ msg.content }}</div>
          <div class="time">{{ formatTime(msg.timestamp) }}</div>
        </div>
        <img
          v-if="msg.is_me"
          :src="auth.user?.avatar_url || '/uploads/avatars/default.png'"
          class="msg-avatar me-avatar"
        />
      </div>

      <div v-if="isTyping" class="typing-indicator">
        <span></span><span></span><span></span>
      </div>

      <div v-if="!messages.length && !isTyping" class="empty-hint">
        <span>暂无消息</span>
      </div>
    </div>

    <div class="input-area">
      <textarea
        v-model="draft"
        rows="1"
        placeholder="输入消息..."
        @keydown.enter.prevent="send"
      />
      <button
        v-if="isPrivate && agentStatus === 'busy'"
        class="pause-btn"
        @click="pauseAgent"
        title="暂停心智"
      >
        <span class="pause-icon"></span>
      </button>
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
import BackButton from '@/components/BackButton.vue'

const props = defineProps<{ sessionId: string; inline?: boolean }>()
const emit = defineEmits(['close'])
const router = useRouter()

const auth = useAuthStore()
const chat = useChatStore()
const ws = useWebSocket()
const draft = ref('')
const msgArea = ref<HTMLDivElement>()
const isTyping = ref(false)
const agentStatus = ref<'idle' | 'busy' | 'introspecting'>('idle')

const session = ref<any>(null)
const messages = ref<any[]>([])

const isPrivate = computed(() => session.value?.type === 'private')
const statusLabel = computed(() => {
  if (agentStatus.value === 'busy') return '思考中'
  if (agentStatus.value === 'introspecting') return '内省中'
  return '空闲'
})

async function initSession() {
  chat.currentSessionId = props.sessionId
  await chat.loadMessages(props.sessionId)
  if (!chat.sessions.length) await chat.fetchSessions()
  session.value = chat.sessions.find(s => s.session_id === props.sessionId)
  syncMessages()
}

onMounted(async () => {
  await initSession()
  window.addEventListener('ws:chat.typing', onTyping as any)
  window.addEventListener('ws:agent.status', onAgentStatus as any)
})

watch(() => props.sessionId, async (newId, oldId) => {
  if (newId && newId !== oldId) {
    await initSession()
  }
})

onBeforeUnmount(() => {
  window.removeEventListener('ws:chat.typing', onTyping as any)
  window.removeEventListener('ws:agent.status', onAgentStatus as any)
})

function onTyping(e: any) {
  const p = e.detail
  if (p?.session_id === props.sessionId) {
    isTyping.value = p.is_typing
  }
}

function onAgentStatus(e: any) {
  const p = e.detail
  if (p?.agent_id === session.value?.target_id) {
    agentStatus.value = p.status
  }
}

watch(() => chat.messagesMap[props.sessionId], () => {
  syncMessages()
}, { deep: true })

function syncMessages() {
  const list = chat.messagesMap[props.sessionId] || []
  messages.value = list
  nextTick(() => {
    msgArea.value?.scrollTo({ top: msgArea.value.scrollHeight, behavior: 'smooth' })
  })
}

function send() {
  const text = draft.value.trim()
  if (!text) return
  ws.sendChat(props.sessionId, text)
  draft.value = ''
}

function pauseAgent() {
  if (!session.value?.target_id) return
  ws.sendAgentStop(props.sessionId, session.value.target_id)
}

function close() {
  chat.currentSessionId = null
  if (props.inline) {
    emit('close')
  } else {
    router.back()
  }
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
.empty-hint {
  text-align: center;
  color: #5A6A7A;
  font-size: 13px;
  padding: 40px 0;
}
.loading-spinner {
  width: 32px; height: 32px;
  border: 2px solid #1E2731;
  border-top-color: #00E5C9;
  border-radius: 50%;
  animation: spin 1s linear infinite;
}
@keyframes spin { to { transform: rotate(360deg); } }

.chat-header {
  height: 56px;
  display: flex; align-items: center; gap: 12px;
  padding: 0 16px;
  background: rgba(11,15,23,0.9);
  border-bottom: 1px solid rgba(255,255,255,0.06);
}

.avatar { width: 28px; height: 28px; border-radius: 50%; object-fit: cover; }
.header-info { display: flex; flex-direction: column; gap: 2px; }
.name { font-size: 15px; color: #D8E1EC; font-weight: 500; }
.status-row { display: flex; align-items: center; gap: 4px; }
.status-dot { width: 6px; height: 6px; border-radius: 50%; }
.status-dot.idle { background: #10B981; }
.status-dot.busy { background: #F59E0B; animation: pulse-dot 1.5s ease-in-out infinite; }
@keyframes pulse-dot {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.4; }
}
.status-text { font-size: 11px; color: #5A6A7A; }

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
.sender { font-size: 11px; color: #8899AA; margin-bottom: 4px; }
.time { font-size: 10px; color: #5A6A7A; margin-top: 4px; text-align: right; }
.msg-row.me .time { color: #5A6A7A; }

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

.input-area {
  display: flex; gap: 8px; align-items: flex-end;
  padding: 10px 16px 16px;
  border-top: 1px solid rgba(255,255,255,0.06);
  background: #0B0F17;
}
.input-area textarea {
  flex: 1; min-height: 40px; max-height: 120px;
  background: #141B24; border: 1px solid #1E2731;
  border-radius: 8px; color: #D8E1EC;
  padding: 10px 12px; font-size: 14px; resize: none;
}
.input-area textarea:focus { outline: none; border-color: #00E5C9; }
.pause-btn {
  width: 40px; height: 40px;
  display: flex; align-items: center; justify-content: center;
  background: rgba(245, 158, 11, 0.1);
  border: 1px solid rgba(245, 158, 11, 0.3);
  border-radius: 8px;
  cursor: pointer;
  transition: all 0.15s;
}
.pause-btn:hover {
  background: rgba(245, 158, 11, 0.2);
  border-color: rgba(245, 158, 11, 0.5);
}
.pause-icon {
  width: 12px; height: 14px;
  border-left: 3px solid #F59E0B;
  border-right: 3px solid #F59E0B;
}
.send-btn {
  padding: 10px 18px; background: #00E5C9; color: #0B0F17;
  border: none; border-radius: 8px; font-weight: 600; cursor: pointer;
}
</style>
