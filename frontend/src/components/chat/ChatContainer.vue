<template>
  <div class="chat-container">
    <div ref="msgArea" class="message-area" @scroll="onUserScroll">
      <template v-for="msg in groupedMessages" :key="msg.id">
        <div v-if="msg._isDivider" class="date-divider">{{ msg._dateLabel }}</div>
        <MessageBubble
          v-else
          :message="msg"
          :avatar="avatarResolver(msg)"
          :show-sender="showSender"
          :is-conductor="msg.sender_id === conductorId"
          @preview-image="$emit('previewImage', $event)"
        />
      </template>

      <slot name="append" />

      <div v-if="showTyping" class="typing-indicator">
        <span></span><span></span><span></span>
      </div>
      <div v-if="!messages.length && !showTyping" class="empty-hint">
        <span>{{ emptyText || '暂无消息' }}</span>
      </div>
    </div>

    <div v-if="showNewMessageTip" class="new-message-toast" @click="scrollToBottomAndResume">
      <span>↓ 新消息</span>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch, nextTick, onMounted } from 'vue'
import MessageBubble from './MessageBubble.vue'

function formatDateLabel(date: Date): string {
  const today = new Date()
  const isToday = date.getFullYear() === today.getFullYear() &&
    date.getMonth() === today.getMonth() &&
    date.getDate() === today.getDate()
  if (isToday) return '今天'
  const yesterday = new Date(today)
  yesterday.setDate(yesterday.getDate() - 1)
  const isYesterday = date.getFullYear() === yesterday.getFullYear() &&
    date.getMonth() === yesterday.getMonth() &&
    date.getDate() === yesterday.getDate()
  if (isYesterday) return '昨天'
  return date.toLocaleDateString('zh-CN', { year: 'numeric', month: 'long', day: 'numeric', weekday: 'long' })
}

const props = defineProps<{
  messages: any[]
  avatarResolver: (msg: any) => string
  showSender?: boolean
  conductorId?: string
  loading?: boolean
  emptyText?: string
  showTyping?: boolean
}>()

const emit = defineEmits<{
  previewImage: [url: string]
}>()

const msgArea = ref<HTMLDivElement>()
const autoScroll = ref(true)
const isProgrammaticScroll = ref(false)
const showNewMessageTip = ref(false)

const groupedMessages = computed(() => {
  const result: any[] = []
  let lastDate = ''
  for (const m of props.messages) {
    const date = m.timestamp ? new Date(m.timestamp) : null
    const d = date ? date.toDateString() : ''
    if (d && d !== lastDate) {
      lastDate = d
      result.push({ id: `div_${d}`, _isDivider: true, _dateLabel: formatDateLabel(date!) })
    }
    result.push(m)
  }
  return result
})

function onUserScroll() {
  if (isProgrammaticScroll.value) return
  const el = msgArea.value
  if (!el) return
  const distance = el.scrollHeight - el.scrollTop - el.clientHeight
  if (distance < 50 && !autoScroll.value) {
    autoScroll.value = true
    showNewMessageTip.value = false
    return
  }
  autoScroll.value = false
  showNewMessageTip.value = true
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

watch(() => props.messages, () => {
  onNewContent()
}, { deep: true })

onMounted(() => {
  scrollToBottom()
})

defineExpose({ scrollToBottom, scrollToBottomAndResume })
</script>

<style scoped>
.chat-container { flex: 1; display: flex; flex-direction: column; overflow: hidden; position: relative; }
.message-area { flex: 1; overflow-y: auto; padding: 16px; display: flex; flex-direction: column; gap: 10px; }
.empty-hint { text-align: center; color: #5a6a7a; font-size: 13px; padding: 40px 0; }
.date-divider { align-self: center; font-size: 11px; color: #5a6a7a; padding: 8px 16px; background: rgba(255,255,255,0.04); border-radius: 12px; }

.typing-indicator { display: flex; gap: 4px; align-self: flex-start; padding: 12px 14px; background: #1e2731; border-radius: 12px; }
.typing-indicator span { width: 6px; height: 6px; background: #5a6a7a; border-radius: 50%; animation: bounce 1.4s infinite ease-in-out both; }
.typing-indicator span:nth-child(1) { animation-delay: -0.32s; }
.typing-indicator span:nth-child(2) { animation-delay: -0.16s; }
@keyframes bounce { 0%, 80%, 100% { transform: scale(0.6); } 40% { transform: scale(1); } }

.new-message-toast { position: absolute; bottom: 16px; left: 50%; transform: translateX(-50%); padding: 6px 14px; background: rgba(0,229,201,0.15); border: 1px solid rgba(0,229,201,0.3); border-radius: 20px; color: #00e5c9; font-size: 12px; cursor: pointer; z-index: 50; transition: opacity 0.2s; }
.new-message-toast:hover { background: rgba(0,229,201,0.25); }
</style>