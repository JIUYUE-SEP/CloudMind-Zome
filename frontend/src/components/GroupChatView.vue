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
      <!-- Message area -->
      <div ref="msgArea" class="message-area">
        <template v-for="(msg, idx) in groupedMessages" :key="msg.id">
          <div v-if="msg._isDivider" class="date-divider">{{ msg._dateLabel }}</div>
          <div v-else class="msg-row" :class="msg.is_me ? 'me' : 'them'">
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
              <div v-if="msg.reply_to" class="reply-ref">
                <div class="reply-sender">{{ msg.reply_to.sender_type === 'agent' ? 'Agent' : '用户' }}</div>
                <div class="reply-content">{{ msg.reply_to.content }}</div>
              </div>
              <div v-if="msg.content_type === 'image'" class="img-msg">
                <img :src="msg.content" @click="previewUrl = msg.content" />
              </div>
              <div v-else-if="msg.content_type === 'mixed'" class="text">
                <template v-for="(seg, si) in parseContent(msg.content)" :key="si">
                  <img v-if="seg.type === 'image'" :src="seg.value" class="inline-img" @click="previewUrl = seg.value" />
                  <a v-else-if="seg.type === 'file'" :href="seg.value" class="inline-file" target="_blank">{{ seg.label || '下载文件' }}</a>
                  <span v-else>{{ seg.value }}</span>
                </template>
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

        <!-- Intermind divider -->
        <div v-if="intermindActive" class="intermind-divider">
          —— 心智间对话 ——
          <button class="break-btn" @click="breakIntermind">打断</button>
        </div>

        <!-- Inline reply removed — Conductor Q&A deleted -->

        <div v-if="isTyping" class="typing-indicator">
          <span></span><span></span><span></span>
        </div>
      </div>

      <!-- Member side panel (collapsible) -->
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
      <div class="mention-box" v-if="showMention">
        <div class="mention-item" @click="selectMention({ name: '所有人' })">
          <span class="mention-name" style="color:#00E5C9;">@所有人</span>
        </div>
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

    <div v-if="showNewMessageTip" class="new-message-toast" @click="scrollToBottomAndResume">
      <span>↓ 新消息</span>
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
import { useAgentsStore } from '@/stores/agents'
import { useWebSocket } from '@/composables/useWebSocket'
import { api } from '@/api/client'
import BackButton from '@/components/BackButton.vue'

const props = defineProps<{ groupId: string; inline?: boolean }>()
const emit = defineEmits(['close'])
const router = useRouter()

const auth = useAuthStore()
const chat = useChatStore()
const agentsStore = useAgentsStore()
const ws = useWebSocket()

const draft = ref('')
const msgArea = ref<HTMLDivElement>()
const fileInput = ref<HTMLInputElement>()
const textareaRef = ref<HTMLTextAreaElement>()
const showInfo = ref(false)
const isTyping = ref(false)
const intermindActive = ref(false)
const showMention = ref(false)
const mentionStart = ref(0)
const mentionEnd = ref(0)

const group = ref<any>(null)
const members = ref<any[]>([])
const settings = ref({ intermind_enabled: false, random_reply_count: 1, routing_mode: 'intent' })
const messages = ref<any[]>([])
const agentStatuses = ref<Record<string, string>>({})
const expanded = ref<Record<number, boolean>>({})
const showSearch = ref(false)
const searchQuery = ref('')
const previewUrl = ref('')
const pendingImage = ref<string | null>(null)
const replyTarget = ref<any>(null)
const typingTimer = ref<any>(null)
const showInvite = ref(false)
const autoScroll = ref(true)
const isProgrammaticScroll = ref(false)
const showNewMessageTip = ref(false)

function onUserScroll() {
  if (isProgrammaticScroll.value) return
  autoScroll.value = false
  showNewMessageTip.value = true
}

function checkAutoScrollRecovery() {
  const el = msgArea.value
  if (!el) return
  const distance = el.scrollHeight - el.scrollTop - el.clientHeight
  if (distance < 50 && !autoScroll.value) {
    autoScroll.value = true
    showNewMessageTip.value = false
  }
}

function scrollToBottom() {
  const el = msgArea.value
  if (!el) return
  isProgrammaticScroll.value = true
  el.scrollTop = el.scrollHeight
  nextTick(() => { isProgrammaticScroll.value = false })
}

function onNewContent() {
  if (autoScroll.value) {
    scrollToBottom()
  } else {
    showNewMessageTip.value = true
  }
}

function scrollToBottomAndResume() {
  autoScroll.value = true
  showNewMessageTip.value = false
  scrollToBottom()
}

const isOwner = computed(() => group.value?.owner_id === auth.user?.user_id)
const availableAgents = computed(() => {
  const memberIds = new Set(members.value.map((m: any) => m.member_id))
  return (agentsStore.list || []).filter((a: any) => !memberIds.has(a.id))
})

function toggleExpand(idx: number) {
  expanded.value[idx] = !expanded.value[idx]
}

const mentionableMembers = computed(() => {
  return members.value.filter((m: any) => m.member_type === 'agent')
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
  msgArea.value?.addEventListener('scroll', onUserScroll)
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
  msgArea.value?.removeEventListener('scroll', onUserScroll)
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

function onUserTyping() {
  if (typingTimer.value) clearTimeout(typingTimer.value)
  ws.sendTyping(props.groupId, true)
  typingTimer.value = setTimeout(() => ws.sendTyping(props.groupId, false), 2000)
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
  const last = messages.value[messages.value.length - 1]
  if (last && last.content_type === 'thinking' && last.batch_id === p.batch_id) {
    messages.value[messages.value.length - 1] = { ...last, content: last.content + p.thinking }
  } else {
    messages.value.push({
      id: `think_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      sender_id: p.agent_id, sender_name: p.agent_name, content: p.thinking,
      sender_type: 'agent', content_type: 'thinking', batch_id: p.batch_id, timestamp: p.timestamp, is_me: false,
    })
  }
  nextTick(() => onNewContent())
}

function onToolCall(e: any) {
  const p = e.detail
  if (p?.session_id !== props.groupId) return
  const last = messages.value[messages.value.length - 1]
  if (last && last.content_type === 'tool_call' && last.batch_id === p.batch_id && last.tool_name === p.tool_name) {
    messages.value[messages.value.length - 1] = { ...last, content: last.content + '\n' + JSON.stringify(p.tool_input, null, 2) }
  } else {
    messages.value.push({
      id: `tool_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      sender_id: p.agent_id, sender_name: p.agent_name,
      sender_type: 'agent', content: JSON.stringify(p.tool_input, null, 2), tool_name: p.tool_name,
      tool_input: JSON.stringify(p.tool_input, null, 2), content_type: 'tool_call',
      batch_id: p.batch_id, timestamp: p.timestamp, is_me: false,
    })
  }
  nextTick(() => onNewContent())
}

watch(() => chat.messagesMap[props.groupId], () => syncMessages(), { deep: true })

function syncMessages() {
  const list = chat.messagesMap[props.groupId] || []
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

  const last = list[list.length - 1]
  if (!last) return
  nextTick(() => onNewContent())
}

async function fetchGroup() {
  const json = await api.get(`/chats/groups/${props.groupId}`)
  if (json.code === 0) {
    group.value = json.data
    members.value = json.data.members
    settings.value = { ...settings.value, ...json.data.settings }
  }
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
      mentionEnd.value = cursor
      showMention.value = true
      return
    }
  }
  showMention.value = false
}

function selectMention(m: any) {
  const el = textareaRef.value
  if (!el) return
  const text = draft.value
  const before = text.slice(0, mentionStart.value)
  const after = text.slice(mentionEnd.value)
  draft.value = before + '@' + m.name + ' ' + after
  showMention.value = false
  nextTick(() => {
    const pos = mentionStart.value + m.name.length + 2
    el.setSelectionRange(pos, pos)
    el.focus()
  })
}

async function send() {
  const text = draft.value.trim()
  if (!text && !pendingImage.value) return

  // Save task blueprint command
  const cleanText = text.replace(/[。，！？.,!?]/g, '').trim()
  if (cleanText === '保存这个流程' || cleanText === '保存流程') {
    draft.value = ''
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

  const opts: any = {}
  if (replyTarget.value) opts.reply_to = replyTarget.value.id
  if (pendingImage.value && text) {
    ws.sendChat(props.groupId, `[image:${pendingImage.value}]\n${text}`, { content_type: 'mixed', ...opts })
    pendingImage.value = null
    draft.value = ''
    replyTarget.value = null
  } else if (pendingImage.value) {
    ws.sendChat(props.groupId, pendingImage.value, { content_type: 'image', ...opts })
    pendingImage.value = null
    replyTarget.value = null
  } else if (text) {
    ws.sendChat(props.groupId, text, opts)
    draft.value = ''
    replyTarget.value = null
  }
  showMention.value = false
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

function formatTime(ts: string) {
  if (!ts) return ''
  const d = new Date(ts)
  return `${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}`
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
.message-area { flex: 1; overflow-y: auto; padding: 16px; display: flex; flex-direction: column; gap: 10px; }
.msg-row { display: flex; align-items: flex-start; gap: 8px; }
.msg-row.me { justify-content: flex-end; }
.msg-row.them { justify-content: flex-start; }
.msg-avatar { width: 28px; height: 28px; border-radius: 50%; object-fit: cover; margin-top: 4px; }

.bubble { max-width: 70%; padding: 10px 14px; border-radius: 12px; font-size: 14px; line-height: 1.5; }
.msg-row.them .bubble { background: #1E2731; color: #D8E1EC; border-top-left-radius: 4px; }
.msg-row.me .bubble { background: #E8EDF2; color: #0B0F17; border-top-right-radius: 4px; }
.sender { font-size: 11px; color: #8899AA; margin-bottom: 4px; display: flex; align-items: center; gap: 6px; }
.crown { color: #FFB800; font-size: 11px; }
.text { white-space: pre-wrap; word-break: break-word; }
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

.intermind-divider { align-self: center; font-size: 12px; color: #5A6A7A; display: flex; align-items: center; gap: 10px; padding: 8px 0; }
.break-btn { padding: 2px 8px; font-size: 11px; border: 1px solid #FF6B35; color: #FF6B35; background: transparent; border-radius: 4px; cursor: pointer; }

.inline-reply { display: flex; gap: 8px; align-items: center; padding: 10px 14px; background: rgba(20,27,36,0.9); border: 1px solid rgba(0,229,201,0.2); border-radius: 8px; margin-top: 4px; }
.inline-reply input { flex: 1; background: transparent; border: none; color: #D8E1EC; font-size: 14px; }
.inline-reply input:focus { outline: none; }
.inline-reply button { padding: 6px 12px; background: #00E5C9; color: #0B0F17; border: none; border-radius: 6px; font-weight: 600; cursor: pointer; }

.typing-indicator { display: flex; gap: 4px; align-self: flex-start; padding: 12px 14px; background: #1E2731; border-radius: 12px; }
.typing-indicator span { width: 6px; height: 6px; background: #5A6A7A; border-radius: 50%; animation: bounce 1.4s infinite ease-in-out both; }
.typing-indicator span:nth-child(1) { animation-delay: -0.32s; }
.typing-indicator span:nth-child(2) { animation-delay: -0.16s; }
@keyframes bounce { 0%, 80%, 100% { transform: scale(0.6); } 40% { transform: scale(1); } }

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

.input-area { display: flex; gap: 8px; align-items: flex-end; padding: 10px 16px 16px; border-top: 1px solid rgba(255,255,255,0.06); background: #0B0F17; position: relative; flex-direction: row; }
.input-area .reply-bar,
.input-area .pending-image-bar { width: 100%; position: absolute; bottom: 100%; left: 0; padding: 6px 16px; box-sizing: border-box; }
.reply-bar { width: 100%; display: flex; justify-content: space-between; align-items: center; padding: 6px 10px; background: rgba(0,229,201,0.06); border: 1px solid rgba(0,229,201,0.15); border-radius: 6px; font-size: 12px; color: #00E5C9; margin-bottom: 6px; }
.pending-image-bar { width: 100%; display: flex; align-items: center; gap: 8px; padding: 6px 10px; background: rgba(0,229,201,0.04); border: 1px solid rgba(0,229,201,0.15); border-radius: 6px; margin-bottom: 6px; }
.pending-thumb { width: 48px; height: 48px; object-fit: cover; border-radius: 4px; border: 1px solid rgba(255,255,255,0.1); }
.pending-cancel { width: 24px; height: 24px; display: flex; align-items: center; justify-content: center; background: transparent; border: none; color: #8899AA; font-size: 14px; cursor: pointer; }
.pending-cancel:hover { color: #F59E0B; }
.reply-bar button { background: transparent; border: none; color: #8899AA; cursor: pointer; }
.input-area textarea { flex: 1; min-height: 40px; max-height: 120px; background: #141B24; border: 1px solid #1E2731; border-radius: 8px; color: #D8E1EC; padding: 10px 12px; font-size: 14px; resize: none; width: 100%; box-sizing: border-box; }
.input-area textarea:focus { outline: none; border-color: #00E5C9; }
.attach-btn { width: 40px; height: 40px; display: flex; align-items: center; justify-content: center; background: rgba(255,255,255,0.06); border: 1px solid rgba(255,255,255,0.1); border-radius: 8px; color: #8899AA; font-size: 18px; cursor: pointer; }
.attach-btn:hover { border-color: rgba(0,229,201,0.3); color: #00E5C9; }
.send-btn { padding: 10px 18px; background: #00E5C9; color: #0B0F17; border: none; border-radius: 8px; font-weight: 600; cursor: pointer; }

.mention-box { position: absolute; bottom: calc(100% + 6px); left: 16px; right: 80px; max-height: 200px; overflow-y: auto; background: #141B24; border: 1px solid #1E2731; border-radius: 8px; z-index: 100; }
.mention-item { display: flex; align-items: center; gap: 8px; padding: 8px 12px; cursor: pointer; transition: background 0.1s; }
.mention-item:hover { background: rgba(0, 229, 201, 0.1); }
.mention-avatar { width: 24px; height: 24px; border-radius: 50%; object-fit: cover; }
.mention-name { font-size: 13px; color: #D8E1EC; }
.mention-badge { font-size: 10px; padding: 1px 5px; background: rgba(0, 229, 201, 0.15); color: #00E5C9; border-radius: 4px; }

.slide-enter-active, .slide-leave-active { transition: transform 0.25s ease; }
.slide-enter-from, .slide-leave-to { transform: translateX(100%); }

.new-message-toast { position: absolute; bottom: 80px; left: 50%; transform: translateX(-50%); padding: 6px 14px; background: rgba(0,229,201,0.15); border: 1px solid rgba(0,229,201,0.3); border-radius: 20px; color: #00E5C9; font-size: 12px; cursor: pointer; z-index: 50; transition: opacity 0.2s; }
.new-message-toast:hover { background: rgba(0,229,201,0.25); }
.img-preview-overlay { position: fixed; inset: 0; background: rgba(0,0,0,0.85); z-index: 1000; display: flex; align-items: center; justify-content: center; }
.img-preview-overlay img { max-width: 90vw; max-height: 90vh; border-radius: 8px; }
</style>
