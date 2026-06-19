<template>
  <div class="image-uploader">
    <div class="preview-wrap">
      <img v-if="url" :src="$uploadUrl(url)" class="preview" />
      <div v-else class="placeholder">暂无图片</div>
    </div>
    <div class="controls">
      <input
        v-model="localUrl"
        class="ae-input url-input"
        placeholder="输入图片 URL"
        @keydown.enter="confirmUrl"
      />
      <button class="ae-mini-btn" @click="triggerFile">本地上传</button>
      <button v-if="url" class="ae-mini-btn secondary" @click="clear">清除</button>
    </div>
    <input ref="fileInput" type="file" accept="image/*" style="display: none" @change="onFileChange" />
  </div>
</template>

<script setup lang="ts">
import { ref, watch } from 'vue'

const props = defineProps<{
  url: string
}>()

const emit = defineEmits<{
  'update:url': [v: string]
  upload: [file: File]
}>()

const fileInput = ref<HTMLInputElement>()
const localUrl = ref(props.url)

watch(() => props.url, (v) => {
  localUrl.value = v
})

function confirmUrl() {
  emit('update:url', localUrl.value.trim())
}

function triggerFile() {
  fileInput.value?.click()
}

function onFileChange(e: Event) {
  const file = (e.target as HTMLInputElement).files?.[0]
  if (!file) return
  emit('upload', file)
  ;(e.target as HTMLInputElement).value = ''
}

function clear() {
  emit('update:url', '')
}
</script>

<style scoped>
@import '@/styles/agent-edit.css';

.image-uploader {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.preview-wrap {
  width: 120px;
  height: 120px;
  border-radius: 8px;
  overflow: hidden;
  background: var(--ae-input-bg);
  border: 1px solid var(--ae-input-border);
}

.preview {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.placeholder {
  width: 100%;
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--ae-text-dim);
  font-size: 12px;
}

.controls {
  display: flex;
  gap: 8px;
  align-items: center;
}

.url-input {
  flex: 1;
}

.ae-mini-btn.secondary {
  background: transparent;
  border-color: var(--ae-input-border);
  color: var(--ae-text-muted);
}
</style>
