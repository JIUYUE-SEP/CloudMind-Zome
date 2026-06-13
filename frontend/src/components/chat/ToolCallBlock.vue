<template>
  <div class="tool-call-block">
    <div class="tool-bar" @click="toggle">
      <span v-for="t in toolCalls" :key="t.name" class="tool-tag" :class="{ failed: t.error }">
        {{ expanded ? '▼' : '▶' }} {{ t.name }}
      </span>
    </div>
    <div v-if="expanded" class="tool-detail">
      <div v-for="t in toolCalls" :key="t.name" class="tool-item">
        <div class="tool-name">{{ t.name }}</div>
        <pre class="tool-input">{{ formatInput(t.input) }}</pre>
        <pre v-if="t.output !== undefined" class="tool-output">{{ formatInput(t.output) }}</pre>
        <div v-if="t.error" class="tool-error">{{ t.error }}</div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref } from 'vue'

export interface ToolCall {
  name: string
  input: any
  output?: any
  error?: string
}

const props = defineProps<{
  toolCalls: ToolCall[]
}>()

const expanded = ref(false)

function toggle() {
  expanded.value = !expanded.value
}

function formatInput(value: any): string {
  if (value === undefined || value === null) return ''
  if (typeof value === 'string') return value
  return JSON.stringify(value, null, 2)
}
</script>

<style scoped>
.tool-bar {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-bottom: 6px;
  cursor: pointer;
}
.tool-tag {
  padding: 2px 8px;
  background: rgba(0, 229, 201, 0.06);
  border: 1px solid rgba(0, 229, 201, 0.15);
  border-radius: 4px;
  font-size: 11px;
  color: #00e5c9;
}
.tool-tag.failed {
  border-color: rgba(239, 68, 68, 0.4);
  color: #ef4444;
  background: rgba(239, 68, 68, 0.06);
}
.tool-detail {
  padding: 8px 10px;
  background: #141b24;
  border: 1px solid #1e2731;
  border-radius: 6px;
  margin-bottom: 8px;
}
.tool-item {
  margin-bottom: 6px;
}
.tool-item:last-child {
  margin-bottom: 0;
}
.tool-name {
  font-size: 11px;
  color: #00e5c9;
  margin-bottom: 4px;
}
.tool-input,
.tool-output {
  font-size: 11px;
  color: #8899aa;
  white-space: pre-wrap;
  word-break: break-word;
  font-family: 'Fira Code', 'Courier New', Courier, monospace;
  margin: 0;
}
.tool-error {
  font-size: 11px;
  color: #ef4444;
  margin-top: 4px;
}
</style>
