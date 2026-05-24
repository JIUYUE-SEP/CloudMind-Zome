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
      <button class="header-search-btn" @click="showSearch = !showSearch">Q</button>
    </header>
    <div v-if="showSearch" class="search-bar">
      <input v-model="searchQuery" @keydown.enter="doSearch" placeholder="搜索消息..." />
      <button @click="doSearch">搜索</button>
      <button @click="showSearch = false; searchQuery = ''; chat.loadMessages(props.sessionId)">清空</button>
    </div>

    <div ref="msgArea" class="message-area">
      <template v-for="(msg, idx) in groupedMessages" :key="msg.id">
        <div v-if="msg._isDivider" class="date-divider">{{ msg._dateLabel }}</div>
        <div v-else class="msg-row" :class="msg.is_me ? 'me' : 'them'">
          <img
            v-if="!msg.is_me"
            :src="session?.target_avatar || '/uploads/avatars/default.png'"
            class="msg-avatar"
          />
          <div class="bubble">
            <div class="sender" v-if="!msg.is_me">{{ msg.sender_name }}</div>
            <div v-if="msg.reply_to" class="reply-ref">
              <div class="reply-sender">{{ msg.reply_to.sender_type === 'agent' ? 'Agent' : '用户' }}</div>
              <div class="reply-content">{{ msg.reply_to.content }}</div>
            </div>
            <div v-if="msg.content_type === 'image'" class="img-msg">
              <img :src="msg.content" @click="previewUrl = msg.content" />
            </div>
            <div v-else-if="msg.content_type === 'thinking'" class="gray-block">
              <div class="gray-header" @click="toggleExpand(idx)">
                <span>◉ thinking</span>
                <span>{{ expanded[idx] ? '收起' : '展开' }}</span>
              </div>
              <div v-if="expanded[idx]" class="gray-body">{{ msg.content }}</div>
            </div>
            <div v-else-if="msg.content_type === 'tool_call'" class="gray-block">
              <div class="gray-header" @click="toggleExpand(idx)">
                <span>◐ {{ msg.tool_name }}</span>
                <span>{{ expanded[idx] ? '收起' : '展开' }}</span>
              </div>
              <div v-if="expanded[idx]" class="gray-body">{{ msg.tool_input }}</div>
            </div>
            <div v-else class="text">
              <template v-for="(seg, si) in parseContent(msg.content)" :key="si">
                <img v-if="seg.type === 'image'" :src="seg.value" class="inline-img" @click="previewUrl = seg.value" />
                <a v-else-if="seg.type === 'file'" :href="seg.value" class="inline-file" target="_blank">{{ seg.label || '下载文件' }}</a>
                <span v-else>{{ seg.value }}</span>
              </template>
            </div>
            <div class="time">{{ formatTime(msg.timestamp) }}</div>
          </div>
          <img
            v-if="msg.is_me"
            :src="auth.user?.avatar_url || '/uploads/avatars/default.png'"
            class="msg-avatar me-avatar"
          />
        </div>
      </template>

      <div v-if="isTyping" class="typing-indicator">
        <span></span><span></span><span></span>
      </div>
      <div v-if="!messages.length && !isTyping" class="empty-hint">
        <span>暂无消息</span>
      </div>
    </div>

    <div class="input-area">
      <div v-if="replyTarget" class="reply-bar">
        <span>引用: {{ replyTarget.sender_name }}</span>
        <button @click="replyTarget = null">x</button>
      </div>
      <div v-if="pendingImage" class="pending-image-bar">
        <img :src="pendingImage" class="pending-thumb" />
        <button class="pending-cancel" @click="pendingImage = null">x</button>
      </div>
      <input ref="fileInput" type="file" accept="image/*" style="display:none" @change="onFileSelect" />
      <button class="attach-btn" @click="fileInput?.click()">+</button>
      <textarea
        v-model="draft"
        rows="1"
        placeholder="输入消息..."
        @keydown.enter.prevent="send"
        @input="onUserTyping"
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

    <div v-if="previewUrl" class="img-preview-overlay" @click.self="previewUrl = ''">
      <img :src="previewUrl" />
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

const props = defineProps<{ sessionId: string; inline?: boolean }>()
const emit = defineEmits(['close'])
const router = useRouter()

const auth = useAuthStore()
const chat = useChatStore()
const ws = useWebSocket()
const draft = ref('')
const msgArea = ref<HTMLDivElement>()
const fileInput = ref<HTMLInputElement>()
const isTyping = ref(false)
const agentStatus = ref<'idle' | 'busy' | 'introspecting'>('idle')
const messages = ref<any[]>([])
const expanded = ref<Record<number, boolean>>({})
const showSearch = ref(false)
const searchQuery = ref('')
const previewUrl = ref('')
const pendingImage = ref<string | null>(null)
const replyTarget = ref<any>(null)
const typingTimer = ref<any>(null)

const session = computed(() =>
  chat.sessions.find(s => s.session_id === props.sessionId)
)

function toggleExpand(idx: number) {
  expanded.value[idx] = !expanded.value[idx]
}

const isPrivate = computed(() => session.value?.type === 'private')
const statusLabel = computed(() => {
  if (agentStatus.value === 'busy') return '思考中'
  if (agentStatus.value === 'introspecting') return '内省中'
  return '空闲'
})

const groupedMessages = computed(() => {
  const result: any[] = []
  let lastDate = ''
  for (const m of messages.value) {
    const d = m.timestamp ? new Date(m.timestamp).toDateString() : ''
    if (d && d !== lastDate) {
      lastDate = d
      result.push({ id: `div_${d}`, _isDivider: true, _dateLabel: d })
    }
    result.push(m)
  }
  return result
})

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

function onUserTyping() {
  if (typingTimer.value) clearTimeout(typingTimer.value)
  ws.sendTyping(props.sessionId, true)
  typingTimer.value = setTimeout(() => ws.sendTyping(props.sessionId, false), 2000)
}

async function onFileSelect(e: Event) {
  const file = (e.target as HTMLInputElement).files?.[0]
  if (!file) return
  const fd = new FormData()
  fd.append('file', file)
  const json = await api.upload('/upload?folder=chat', fd)
  if (json.code === 0) {
    pendingImage.value = json.data.url
  }
  ;(e.target as HTMLInputElement).value = ''
}

async function doSearch() {
  if (!searchQuery.value.trim()) return
  await chat.loadMessages(props.sessionId, searchQuery.value.trim())
}

function onThinking(e: any) {
  const p = e.detail
  if (p?.session_id !== props.sessionId) return
  const existing = messages.value.find((m: any) => m.content_type === 'thinking' && m.batch_id === p.batch_id)
  if (existing) {
    const idx = messages.value.indexOf(existing)
    messages.value.splice(idx, 1, { ...existing, content: existing.content + p.thinking })
  } else {
    messages.value.push({
      id: `think_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      sender_id: p.agent_id, sender_name: p.agent_name, content: p.thinking,
      sender_type: 'agent', content_type: 'thinking', batch_id: p.batch_id, timestamp: p.timestamp, is_me: false,
    })
  }
  nextTick(() => { if (msgArea.value) msgArea.value.scrollTop = msgArea.value.scrollHeight })
}

function onToolCall(e: any) {
  const p = e.detail
  if (p?.session_id !== props.sessionId) return
  const existing = messages.value.find((m: any) => m.content_type === 'tool_call' && m.batch_id === p.batch_id && m.tool_name === p.tool_name)
  if (existing) {
    const idx = messages.value.indexOf(existing)
    messages.value.splice(idx, 1, { ...existing, content: existing.content + '\n' + JSON.stringify(p.tool_input, null, 2) })
  } else {
    messages.value.push({
      id: `tool_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      sender_id: p.agent_id, sender_name: p.agent_name,
      sender_type: 'agent', content: JSON.stringify(p.tool_input, null, 2), tool_name: p.tool_name,
      tool_input: JSON.stringify(p.tool_input, null, 2), content_type: 'tool_call',
      batch_id: p.batch_id, timestamp: p.timestamp, is_me: false,
    })
  }
  nextTick(() => { if (msgArea.value) msgArea.value.scrollTop = msgArea.value.scrollHeight })
}

watch(() => chat.messagesMap[props.sessionId], () => syncMessages(), { deep: true })

function syncMessages() {
  const list = chat.messagesMap[props.sessionId] || []
  const transient = messages.value.filter(
    (m: any) => (m.content_type === 'thinking' || m.content_type === 'tool_call') && !list.some((x: any) => x.id === m.id)
  )
  if (transient.length > 20) transient.splice(0, transient.length - 20)
  const merged: any[] = []
  const placed = new Set<string>()
  for (const msg of list) {
    if (msg.batch_id) {
      for (const t of transient) {
        if (t.batch_id === msg.batch_id && !placed.has(t.id)) { merged.push(t); placed.add(t.id) }
      }
    }
    merged.push(msg)
  }
  for (const t of transient) { if (!placed.has(t.id)) merged.push(t) }
  messages.value = merged
  nextTick(() => { if (msgArea.value) msgArea.value.scrollTop = msgArea.value.scrollHeight })
}

function send() {
  const text = draft.value.trim()
  if (!text && !pendingImage.value) return
  const opts: any = {}
  if (replyTarget.value) { opts.reply_to = replyTarget.value.id }
  if (pendingImage.value) {
    ws.sendChat(props.sessionId, pendingImage.value, { content_type: 'image', ...opts })
    pendingImage.value = null
    replyTarget.value = null
  }
  if (text) {
    ws.sendChat(props.sessionId, text, opts)
    draft.value = ''
    replyTarget.value = null
  }
}

function pauseAgent() {
  if (!session.value?.target_id) return
  ws.sendAgentStop(props.sessionId, session.value.target_id)
}

function close() {
  chat.currentSessionId = null
  if (props.inline) { emit('close') } else { router.back() }
}

function parseContent(text: string): { type: string, value: string, label?: string }[] {
  if (!text) return []
  const re = /\[image:([^\]]+)\]|\[file:([^\]]+)\]/g
  const segments: { type: string, value: string, label?: string }[] = []
  let last = 0
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) segments.push({ type: 'text', value: text.slice(last, m.index) })
    if (m[1]) {
      segments.push({ type: 'image', value: m[1] })
    } else if (m[2]) {
      const fn = m[2].split('/').pop() || 'file'
      segments.push({ type: 'file', value: m[2], label: fn })
    }
    last = re.lastIndex
  }
  if (last < text.length) segments.push({ type: 'text', value: text.slice(last) })
  return segments
}

function formatTime(ts: string) {
  if (!ts) return ''
  const d = new Date(ts)
  return `${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}`
}
</script>

<style scoped>
.chat-view { position: fixed; inset: 0; background: #0B0F17; display: flex; flex-direction: column; z-index: 900; }
.chat-view.inline-mode { position: relative; z-index: auto; height: 100%; }
.empty-hint { text-align: center; color: #5A6A7A; font-size: 13px; padding: 40px 0; }

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

.message-area { flex: 1; overflow-y: auto; padding: 16px; display: flex; flex-direction: column; gap: 10px; }
.msg-row { display: flex; align-items: flex-start; gap: 8px; }
.msg-row.me { justify-content: flex-end; }
.msg-row.them { justify-content: flex-start; }
.msg-avatar { width: 28px; height: 28px; border-radius: 50%; object-fit: cover; margin-top: 4px; }

.bubble { max-width: 70%; padding: 10px 14px; border-radius: 12px; font-size: 14px; line-height: 1.5; }
.msg-row.them .bubble { background: #1E2731; color: #D8E1EC; border-top-left-radius: 4px; }
.msg-row.me .bubble { background: #E8EDF2; color: #0B0F17; border-top-right-radius: 4px; }
.sender { font-size: 11px; color: #8899AA; margin-bottom: 4px; }
.time { font-size: 10px; color: #5A6A7A; margin-top: 4px; text-align: right; }
.msg-row.me .time { color: #5A6A7A; }

.date-divider { align-self: center; font-size: 11px; color: #5A6A7A; padding: 8px 16px; background: rgba(255,255,255,0.04); border-radius: 12px; }

.reply-ref { background: rgba(0,0,0,0.2); border-left: 2px solid #00E5C9; padding: 4px 8px; border-radius: 4px; margin-bottom: 6px; cursor: pointer; }
.reply-sender { font-size: 10px; color: #00E5C9; }
.reply-content { font-size: 11px; color: #8899AA; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }

.img-msg img { max-width: 200px; max-height: 200px; border-radius: 8px; cursor: pointer; object-fit: cover; }
.inline-img { max-width: 200px; max-height: 200px; border-radius: 8px; cursor: pointer; object-fit: cover; display: block; margin: 4px 0; }
.inline-file { display: inline-block; padding: 4px 10px; background: rgba(0,229,201,0.08); border: 1px solid rgba(0,229,201,0.2); border-radius: 4px; color: #00E5C9; font-size: 12px; text-decoration: none; margin: 2px 0; }
.inline-file:hover { background: rgba(0,229,201,0.15); }

.gray-block { background: #141B24; border: 1px solid #1E2731; border-radius: 6px; padding: 8px 10px; font-size: 12px; color: #5A6A7A; margin: 4px 0; max-width: 100%; }
.gray-header { display: flex; justify-content: space-between; align-items: center; cursor: pointer; user-select: none; }
.gray-body { margin-top: 6px; padding-top: 6px; border-top: 1px solid #1E2731; color: #8899AA; white-space: pre-wrap; word-break: break-word; font-family: monospace; font-size: 11px; line-height: 1.5; }

.typing-indicator { display: flex; gap: 4px; align-self: flex-start; padding: 12px 14px; background: #1E2731; border-radius: 12px; }
.typing-indicator span { width: 6px; height: 6px; background: #5A6A7A; border-radius: 50%; animation: bounce 1.4s infinite ease-in-out both; }
.typing-indicator span:nth-child(1) { animation-delay: -0.32s; }
.typing-indicator span:nth-child(2) { animation-delay: -0.16s; }
@keyframes bounce { 0%, 80%, 100% { transform: scale(0.6); } 40% { transform: scale(1); } }

.input-area { display: flex; gap: 8px; align-items: flex-end; padding: 10px 16px 16px; border-top: 1px solid rgba(255,255,255,0.06); background: #0B0F17; position: relative; flex-direction: row; }
.input-area .reply-bar,
.input-area .pending-image-bar { width: 100%; position: absolute; bottom: 100%; left: 0; padding: 6px 16px; box-sizing: border-box; }
.reply-bar { width: 100%; display: flex; justify-content: space-between; align-items: center; padding: 6px 10px; background: rgba(0,229,201,0.06); border: 1px solid rgba(0,229,201,0.15); border-radius: 6px; font-size: 12px; color: #00E5C9; margin-bottom: 6px; }
.pending-image-bar { width: 100%; display: flex; align-items: center; gap: 8px; padding: 6px 10px; background: rgba(0,229,201,0.04); border: 1px solid rgba(0,229,201,0.15); border-radius: 6px; margin-bottom: 6px; }
.pending-thumb { width: 48px; height: 48px; object-fit: cover; border-radius: 4px; border: 1px solid rgba(255,255,255,0.1); }
.pending-cancel { width: 24px; height: 24px; display: flex; align-items: center; justify-content: center; background: transparent; border: none; color: #8899AA; font-size: 14px; cursor: pointer; }
.reply-bar button { background: transparent; border: none; color: #8899AA; cursor: pointer; }
.pending-cancel:hover { color: #F59E0B; }
.input-area textarea { flex: 1; min-height: 40px; max-height: 120px; background: #141B24; border: 1px solid #1E2731; border-radius: 8px; color: #D8E1EC; padding: 10px 12px; font-size: 14px; resize: none; width: 100%; box-sizing: border-box; }
.input-area textarea:focus { outline: none; border-color: #00E5C9; }
.attach-btn { width: 40px; height: 40px; display: flex; align-items: center; justify-content: center; background: rgba(255,255,255,0.06); border: 1px solid rgba(255,255,255,0.1); border-radius: 8px; color: #8899AA; font-size: 18px; cursor: pointer; }
.attach-btn:hover { border-color: rgba(0,229,201,0.3); color: #00E5C9; }
.pause-btn { width: 40px; height: 40px; display: flex; align-items: center; justify-content: center; background: rgba(245, 158, 11, 0.1); border: 1px solid rgba(245, 158, 11, 0.3); border-radius: 8px; cursor: pointer; }
.pause-icon { width: 12px; height: 14px; border-left: 3px solid #F59E0B; border-right: 3px solid #F59E0B; }
.send-btn { padding: 10px 18px; background: #00E5C9; color: #0B0F17; border: none; border-radius: 8px; font-weight: 600; cursor: pointer; }

.img-preview-overlay { position: fixed; inset: 0; background: rgba(0,0,0,0.85); z-index: 1000; display: flex; align-items: center; justify-content: center; }
.img-preview-overlay img { max-width: 90vw; max-height: 90vh; border-radius: 8px; }
</style>
