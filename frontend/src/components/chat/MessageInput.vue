<template>
  <div class="message-input">
    <div v-if="replyTarget" class="reply-bar">
      <span>引用: {{ replyTarget.sender_name }}</span>
      <button @click="clearReply">x</button>
    </div>
    <div v-if="pendingImage" class="pending-image-bar">
      <img :src="pendingImage" class="pending-thumb" />
      <button class="pending-cancel" @click="pendingImage = null">x</button>
    </div>

    <input ref="fileInput" type="file" accept="image/*" style="display:none" @change="onFileSelect" />

    <div class="input-row">
      <button class="attach-btn" @click="fileInput?.click()">+</button>

      <div class="mention-box" v-if="showMention && filteredMembers.length">
        <div
          v-for="(m, i) in filteredMembers"
          :key="m.id"
          class="mention-item"
          :class="{ active: i === selectedIndex }"
          @click="selectMention(m)"
          @mouseenter="selectedIndex = i"
        >
          <img v-if="m.avatar" :src="m.avatar" class="mention-avatar" />
          <span class="mention-name">{{ m.name }}</span>
          <span v-if="m.badge" class="mention-badge">{{ m.badge }}</span>
        </div>
      </div>

      <textarea
        ref="textareaRef"
        v-model="draft"
        rows="1"
        :placeholder="placeholder"
        @input="onInput"
        @keydown="onKeydown"
      />
      <button class="send-btn" @click="send">发送</button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, nextTick } from 'vue'
import { api } from '@/api/client'
import type { Message } from '@/stores/chat'

export interface MentionMember {
  id: string
  name: string
  avatar?: string
  badge?: string
}

const props = defineProps<{
  members?: MentionMember[]
  replyTarget?: Message | null
  placeholder?: string
}>()

const emit = defineEmits<{
  send: [payload: { content: string; content_type: string; reply_to?: string }]
  typing: [isTyping: boolean]
  'update:replyTarget': [value: Message | null]
}>()

const draft = ref('')
const pendingImage = ref<string | null>(null)
const fileInput = ref<HTMLInputElement>()
const textareaRef = ref<HTMLTextAreaElement>()

const showMention = ref(false)
const mentionStart = ref(0)
const mentionEnd = ref(0)
const selectedIndex = ref(0)

const everyoneMember: MentionMember = { id: 'everyone', name: '所有人', badge: '全员' }

const mentionableMembers = computed(() => {
  const base = props.members || []
  return [everyoneMember, ...base]
})

const filteredMembers = computed(() => {
  const query = draft.value.slice(mentionStart.value + 1, mentionEnd.value).toLowerCase()
  if (!query) return mentionableMembers.value
  return mentionableMembers.value.filter(m => m.name.toLowerCase().includes(query))
})

function clearReply() {
  emit('update:replyTarget', null)
}

let typingTimer: ReturnType<typeof setTimeout> | null = null

function notifyTyping() {
  emit('typing', true)
  if (typingTimer) clearTimeout(typingTimer)
  typingTimer = setTimeout(() => emit('typing', false), 2000)
}

function onInput() {
  detectMention()
  notifyTyping()
}

function detectMention() {
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
      selectedIndex.value = 0
      return
    }
  }
  showMention.value = false
}

function onKeydown(e: KeyboardEvent) {
  if (showMention.value && filteredMembers.value.length) {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      selectedIndex.value = (selectedIndex.value + 1) % filteredMembers.value.length
      return
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault()
      selectedIndex.value = (selectedIndex.value - 1 + filteredMembers.value.length) % filteredMembers.value.length
      return
    }
    if (e.key === 'Enter') {
      e.preventDefault()
      selectMention(filteredMembers.value[selectedIndex.value])
      return
    }
    if (e.key === 'Escape') {
      e.preventDefault()
      showMention.value = false
      return
    }
  }

  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault()
    send()
  }
}

function selectMention(m: MentionMember) {
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

function send() {
  const text = draft.value.trim()
  if (!text && !pendingImage.value) return

  const payload: { content: string; content_type: string; reply_to?: string } = {
    content: '',
    content_type: 'text',
  }
  if (props.replyTarget) {
    payload.reply_to = props.replyTarget.id
  }

  if (pendingImage.value && text) {
    payload.content = `[image:${pendingImage.value}]\n${text}`
    payload.content_type = 'mixed'
  } else if (pendingImage.value) {
    payload.content = pendingImage.value
    payload.content_type = 'image'
  } else {
    payload.content = text
    payload.content_type = 'text'
  }

  emit('send', payload)
  draft.value = ''
  pendingImage.value = null
  emit('update:replyTarget', null)
  showMention.value = false
}
</script>

<style scoped>
.message-input {
  display: flex;
  flex-direction: column;
  padding: 10px 16px 16px;
  border-top: 1px solid rgba(255, 255, 255, 0.06);
  background: #0b0f17;
  position: relative;
}
.reply-bar,
.pending-image-bar {
  width: 100%;
  position: absolute;
  bottom: 100%;
  left: 0;
  padding: 6px 16px;
  box-sizing: border-box;
}
.reply-bar {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 6px 10px;
  background: rgba(0, 229, 201, 0.06);
  border: 1px solid rgba(0, 229, 201, 0.15);
  border-radius: 6px;
  font-size: 12px;
  color: #00e5c9;
  margin-bottom: 6px;
}
.reply-bar button {
  background: transparent;
  border: none;
  color: #8899aa;
  cursor: pointer;
}
.pending-image-bar {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 10px;
  background: rgba(0, 229, 201, 0.04);
  border: 1px solid rgba(0, 229, 201, 0.15);
  border-radius: 6px;
  margin-bottom: 6px;
}
.pending-thumb {
  width: 48px;
  height: 48px;
  object-fit: cover;
  border-radius: 4px;
  border: 1px solid rgba(255, 255, 255, 0.1);
}
.pending-cancel {
  width: 24px;
  height: 24px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: transparent;
  border: none;
  color: #8899aa;
  font-size: 14px;
  cursor: pointer;
}
.pending-cancel:hover {
  color: #f59e0b;
}

.input-row {
  display: flex;
  gap: 8px;
  align-items: flex-end;
  position: relative;
}

.input-row textarea {
  flex: 1;
  min-height: 40px;
  max-height: 120px;
  background: #141b24;
  border: 1px solid #1e2731;
  border-radius: 8px;
  color: #d8e1ec;
  padding: 10px 12px;
  font-size: 14px;
  resize: none;
  width: 100%;
  box-sizing: border-box;
}
.input-row textarea:focus {
  outline: none;
  border-color: #00e5c9;
}
.attach-btn {
  width: 40px;
  height: 40px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(255, 255, 255, 0.06);
  border: 1px solid rgba(255, 255, 255, 0.1);
  border-radius: 8px;
  color: #8899aa;
  font-size: 18px;
  cursor: pointer;
}
.attach-btn:hover {
  border-color: rgba(0, 229, 201, 0.3);
  color: #00e5c9;
}
.send-btn {
  padding: 10px 18px;
  background: #00e5c9;
  color: #0b0f17;
  border: none;
  border-radius: 8px;
  font-weight: 600;
  cursor: pointer;
}

.mention-box {
  position: absolute;
  bottom: calc(100% + 6px);
  left: 48px;
  right: 80px;
  max-height: 200px;
  overflow-y: auto;
  background: #141b24;
  border: 1px solid #1e2731;
  border-radius: 8px;
  z-index: 100;
}
.mention-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  cursor: pointer;
  transition: background 0.1s;
}
.mention-item:hover,
.mention-item.active {
  background: rgba(0, 229, 201, 0.1);
}
.mention-avatar {
  width: 24px;
  height: 24px;
  border-radius: 50%;
  object-fit: cover;
}
.mention-name {
  font-size: 13px;
  color: #d8e1ec;
}
.mention-badge {
  font-size: 10px;
  padding: 1px 5px;
  background: rgba(0, 229, 201, 0.15);
  color: #00e5c9;
  border-radius: 4px;
  margin-left: auto;
}
</style>
