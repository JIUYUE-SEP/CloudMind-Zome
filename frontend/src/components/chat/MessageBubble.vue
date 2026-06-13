<template>
  <div class="msg-row" :class="message.is_me ? 'me' : 'them'">
    <img v-if="!message.is_me" :src="avatar" class="msg-avatar" />
    <div class="bubble" :class="{ 'bubble-light': message.is_me }">
      <div v-if="showSender && !message.is_me" class="sender">
        {{ message.sender_name }}
        <span v-if="isConductor" class="crown">队长</span>
      </div>
      <div v-if="message.reply_to" class="reply-ref">
        <div class="reply-sender">{{ message.reply_to.sender_type === 'agent' ? 'Agent' : '用户' }}</div>
        <div class="reply-content">{{ message.reply_to.content }}</div>
      </div>

      <!-- image only -->
      <div v-if="message.content_type === 'image'" class="img-msg">
        <img :src="message.content" @click="$emit('previewImage', message.content)" />
      </div>

      <!-- text / mixed -->
      <div v-else class="text" :class="{ 'typing-cursor': message.is_generating }">
        <template v-for="(seg, si) in segments" :key="si">
          <img
            v-if="seg.type === 'image'"
            :src="seg.value"
            class="inline-img"
            @click="$emit('previewImage', seg.value)"
          />
          <a v-else-if="seg.type === 'file'" :href="seg.value" class="inline-file" target="_blank">{{ seg.label || '下载文件' }}</a>
          <span v-else-if="message.is_generating">{{ seg.value }}</span>
          <div v-else class="md-segment" v-html="renderMarkdown(seg.value)"></div>
        </template>
      </div>

      <ReasoningBlock v-if="message.reasoning" :content="message.reasoning" />
      <ToolCallBlock v-if="message.tool_calls?.length" :tool-calls="message.tool_calls" />
      <div class="time">{{ formatTime(message.timestamp) }}</div>
    </div>
    <img v-if="message.is_me" :src="avatar" class="msg-avatar me-avatar" />
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { useMarkdownRenderer, parseContent } from '@/composables/useMarkdownRenderer'
import ReasoningBlock from './ReasoningBlock.vue'
import ToolCallBlock from './ToolCallBlock.vue'

const props = defineProps<{
  message: any
  avatar: string
  showSender?: boolean
  isConductor?: boolean
}>()

const emit = defineEmits<{
  previewImage: [url: string]
}>()

const { renderMarkdown } = useMarkdownRenderer()

const segments = computed(() => parseContent(props.message.content))

function formatTime(ts: string) {
  if (!ts) return ''
  const d = new Date(ts)
  return `${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}`
}
</script>

<style scoped>
.msg-row { display: flex; align-items: flex-start; gap: 8px; }
.msg-row.me { justify-content: flex-end; }
.msg-row.them { justify-content: flex-start; }
.msg-avatar { width: 28px; height: 28px; border-radius: 50%; object-fit: cover; margin-top: 4px; }

.bubble { max-width: 70%; padding: 10px 14px; border-radius: 12px; font-size: 14px; line-height: 1.5; animation: bubbleIn 0.18s ease-out; }
@keyframes bubbleIn { from { opacity: 0; transform: translateY(4px); } to { opacity: 1; transform: translateY(0); } }
.msg-row.them .bubble { background: #1e2731; color: #d8e1ec; border-top-left-radius: 4px; }
.msg-row.me .bubble { background: #e8edf2; color: #0b0f17; border-top-right-radius: 4px; }
.sender { font-size: 11px; color: #8899aa; margin-bottom: 4px; display: flex; align-items: center; gap: 6px; }
.crown { color: #ffb800; font-size: 11px; }
.time { font-size: 10px; color: #5a6a7a; margin-top: 4px; text-align: right; }
.msg-row.me .time { color: #5a6a7a; }

.reply-ref { background: rgba(0, 0, 0, 0.2); border-left: 2px solid #00e5c9; padding: 4px 8px; border-radius: 4px; margin-bottom: 6px; cursor: pointer; }
.reply-sender { font-size: 10px; color: #00e5c9; }
.reply-content { font-size: 11px; color: #8899aa; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }

.img-msg img { max-width: 200px; max-height: 200px; border-radius: 8px; cursor: pointer; object-fit: cover; }
.inline-img { max-width: 200px; max-height: 200px; border-radius: 8px; cursor: pointer; object-fit: cover; display: block; margin: 4px 0; }
.inline-file { display: inline-block; padding: 4px 10px; background: rgba(0, 229, 201, 0.08); border: 1px solid rgba(0, 229, 201, 0.2); border-radius: 4px; color: #00e5c9; font-size: 12px; text-decoration: none; margin: 2px 0; }
.inline-file:hover { background: rgba(0, 229, 201, 0.15); }

.typing-cursor::after { content: '▌'; animation: blink 1s step-end infinite; color: #00e5c9; margin-left: 2px; }
@keyframes blink { 50% { opacity: 0; } }

/* Markdown rendering in bubbles */
.md-segment { line-height: 1.6; }
.md-segment :deep(p) { margin: 0 0 8px 0; }
.md-segment :deep(p):last-child { margin-bottom: 0; }
.md-segment :deep(ul),
.md-segment :deep(ol) { padding-left: 20px; margin: 4px 0; }
.md-segment :deep(li) { margin: 2px 0; }
.md-segment :deep(pre) {
  background: #141b24;
  border: 1px solid #1e2731;
  border-radius: 6px;
  padding: 10px;
  overflow-x: auto;
  margin: 8px 0;
  color: #d8e1ec;
}
.md-segment :deep(code) {
  font-family: 'Fira Code', 'Courier New', Courier, monospace;
  font-size: 12px;
  background: rgba(0, 0, 0, 0.2);
  padding: 2px 4px;
  border-radius: 3px;
  color: #d8e1ec;
}
.md-segment :deep(pre code) {
  background: transparent;
  padding: 0;
}
.md-segment :deep(blockquote) {
  border-left: 3px solid #00e5c9;
  margin: 8px 0;
  padding: 6px 10px;
  color: #8899aa;
  background: rgba(0, 229, 201, 0.05);
  border-radius: 0 4px 4px 0;
}
.md-segment :deep(a) {
  color: #00e5c9;
  text-decoration: none;
}
.md-segment :deep(a):hover { text-decoration: underline; }
.md-segment :deep(table) {
  border-collapse: collapse;
  width: 100%;
  margin: 8px 0;
  font-size: 13px;
}
.md-segment :deep(th),
.md-segment :deep(td) {
  border: 1px solid #1e2731;
  padding: 6px 8px;
  text-align: left;
}
.md-segment :deep(th) {
  background: rgba(0, 0, 0, 0.2);
  font-weight: 600;
}
.md-segment :deep(hr) {
  border: none;
  border-top: 1px solid #1e2731;
  margin: 10px 0;
}
.md-segment :deep(h1),
.md-segment :deep(h2),
.md-segment :deep(h3),
.md-segment :deep(h4) {
  margin: 10px 0 6px;
  font-weight: 600;
  line-height: 1.3;
}
.md-segment :deep(h1) { font-size: 18px; }
.md-segment :deep(h2) { font-size: 16px; }
.md-segment :deep(h3) { font-size: 14px; }
.md-segment :deep(h4) { font-size: 13px; }

/* Light-bubble (user / me) markdown overrides */
.bubble-light .md-segment :deep(pre) {
  background: #d0d5db;
  border-color: #b0b5bb;
  color: #0b0f17;
}
.bubble-light .md-segment :deep(code) {
  background: rgba(0, 0, 0, 0.1);
  color: #0b0f17;
}
.bubble-light .md-segment :deep(blockquote) {
  background: rgba(0, 0, 0, 0.04);
  color: #3a4a5a;
  border-left-color: #00a08a;
}
.bubble-light .md-segment :deep(a) {
  color: #006b5e;
}
.bubble-light .md-segment :deep(th),
.bubble-light .md-segment :deep(td) {
  border-color: #b0b5bb;
}
.bubble-light .md-segment :deep(hr) {
  border-top-color: #b0b5bb;
}
</style>
