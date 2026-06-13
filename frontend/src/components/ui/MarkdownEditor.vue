<template>
  <div class="md-editor">
    <div class="md-toolbar">
      <button :class="{ active: mode === 'edit' }" @click="mode = 'edit'">编辑</button>
      <button :class="{ active: mode === 'preview' }" @click="mode = 'preview'">预览</button>
    </div>
    <div class="md-body">
      <textarea
        v-if="mode === 'edit'"
        class="ae-textarea md-textarea"
        :value="modelValue"
        :placeholder="placeholder"
        :disabled="readonly"
        rows="14"
        @input="$emit('update:modelValue', ($event.target as HTMLTextAreaElement).value)"
        @keydown="onKeydown"
      />
      <div v-else class="md-preview" v-html="rendered" />
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed } from 'vue'
import { marked } from 'marked'

const props = withDefaults(defineProps<{
  modelValue: string
  placeholder?: string
  readonly?: boolean
}>(), {
  placeholder: '输入 Markdown...',
  readonly: false,
})

const emit = defineEmits<{
  'update:modelValue': [v: string]
  save: []
}>()

const mode = ref<'edit' | 'preview'>('edit')

const rendered = computed(() => marked.parse(props.modelValue || '', { async: false }) as string)

function onKeydown(e: KeyboardEvent) {
  if (e.ctrlKey && e.key === 's') {
    e.preventDefault()
    emit('save')
  }
}
</script>

<style scoped>
@import '@/styles/agent-edit.css';

.md-editor {
  display: flex;
  flex-direction: column;
  gap: 8px;
  border: 1px solid var(--ae-input-border);
  border-radius: 8px;
  overflow: hidden;
  background: var(--ae-input-bg);
}

.md-toolbar {
  display: flex;
  gap: 4px;
  padding: 6px;
  background: rgba(255, 255, 255, 0.02);
  border-bottom: 1px solid var(--ae-input-border);
}

.md-toolbar button {
  padding: 4px 10px;
  background: transparent;
  border: 1px solid transparent;
  border-radius: 4px;
  color: var(--ae-text-muted);
  font-size: 11px;
  cursor: pointer;
}

.md-toolbar button.active {
  background: rgba(0, 229, 201, 0.1);
  border-color: rgba(0, 229, 201, 0.2);
  color: var(--ae-primary);
}

.md-body {
  min-height: 260px;
}

.md-textarea {
  border: none;
  border-radius: 0;
  resize: vertical;
  min-height: 260px;
}

.md-preview {
  padding: 12px;
  color: var(--ae-text);
  font-size: 13px;
  line-height: 1.6;
  min-height: 260px;
  overflow-y: auto;
}

.md-preview :deep(h1),
.md-preview :deep(h2),
.md-preview :deep(h3) {
  color: var(--ae-primary);
  margin: 8px 0 4px;
}

.md-preview :deep(code) {
  background: rgba(255, 255, 255, 0.05);
  padding: 2px 4px;
  border-radius: 4px;
  font-family: monospace;
}

.md-preview :deep(pre) {
  background: rgba(0, 0, 0, 0.3);
  padding: 10px;
  border-radius: 6px;
  overflow-x: auto;
}
</style>
