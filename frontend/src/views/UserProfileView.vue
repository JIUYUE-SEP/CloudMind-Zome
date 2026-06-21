<template>
  <div class="user-profile-view">
    <!-- 顶部导航 -->
    <div class="up-header">
      <BackButton />
      <h3>用户档案</h3>
      <div class="save-status">
        <span v-if="saving" class="status-saving">保存中…</span>
        <span v-else-if="dirty" class="status-dirty">未保存</span>
        <span v-else class="status-saved">已保存</span>
        <button class="save-btn" :disabled="saving || !dirty" @click="save">
          保存
        </button>
      </div>
    </div>

    <!-- 提示栏 -->
    <div class="up-hint">
      <span class="hint-icon">◈</span>
      <span class="hint-text">
        这是<b>你</b>的自设档案，保存在 ~/.cloudmind-zome/userdata/profile.md。
        所有心智都可以读取这份档案来了解你，但它们<b>无权修改</b>。
        心智对用户的理解和印象保存在各自的心智文件夹下的 USER.md 中。
      </span>
    </div>

    <!-- 编辑器 -->
    <div class="up-editor">
      <textarea
        v-model="content"
        class="up-textarea"
        placeholder="# 用户档案\n\n写下关于你自己的一切——你是谁、你喜欢什么、你的习惯、你的目标…"
        spellcheck="false"
        @input="onInput"
      />
      <div class="up-footer">
        <span>{{ content.length }} 字符</span>
        <span>快捷键 Ctrl+S 保存</span>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted, onUnmounted } from 'vue'
import { api } from '@/api/client'
import BackButton from '@/components/BackButton.vue'

const content = ref('')
const original = ref('')
const dirty = ref(false)
const saving = ref(false)

function onInput() {
  dirty.value = content.value !== original.value
}

async function load() {
  const res = await api.get<{ content: string }>('/user/profile-md')
  if (res.code === 0 && res.data) {
    content.value = res.data.content
    original.value = res.data.content
    dirty.value = false
  }
}

async function save() {
  if (!dirty.value) return
  saving.value = true
  const res = await api.put('/user/profile-md', { content: content.value })
  saving.value = false
  if (res.code === 0) {
    original.value = content.value
    dirty.value = false
  } else {
    alert('保存失败：' + (res.message || '未知错误'))
  }
}

function onKeyDown(e: KeyboardEvent) {
  if ((e.ctrlKey || e.metaKey) && e.key === 's') {
    e.preventDefault()
    save()
  }
}

onMounted(() => {
  window.addEventListener('keydown', onKeyDown)
  load()
})

onUnmounted(() => {
  window.removeEventListener('keydown', onKeyDown)
})
</script>

<style scoped>
.user-profile-view {
  position: fixed;
  inset: 0;
  background: #0b0f17;
  z-index: 900;
  display: flex;
  flex-direction: column;
  color: #d8e1ec;
  font-family: system-ui, -apple-system, sans-serif;
}

.up-header {
  height: 56px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 20px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.06);
  flex-shrink: 0;
}
.up-header h3 {
  margin: 0;
  font-size: 15px;
  font-weight: 600;
  flex: 1;
  padding-left: 12px;
}

.save-status {
  display: flex;
  align-items: center;
  gap: 12px;
  font-size: 12px;
}
.status-saving { color: #f0c040; }
.status-dirty { color: #ff7b72; }
.status-saved { color: #3fb950; }
.save-btn {
  padding: 5px 14px;
  border-radius: 6px;
  border: none;
  background: #00e5c9;
  color: #0b0f17;
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
  transition: opacity 0.15s;
}
.save-btn:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}
.save-btn:not(:disabled):hover {
  opacity: 0.85;
}

.up-hint {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  padding: 12px 20px;
  background: rgba(0, 229, 201, 0.04);
  border-bottom: 1px solid rgba(255, 255, 255, 0.06);
  font-size: 12px;
  line-height: 1.6;
  color: #8899aa;
  flex-shrink: 0;
}
.hint-icon {
  color: #00e5c9;
  font-size: 14px;
  margin-top: 1px;
}
.hint-text b {
  color: #d8e1ec;
  font-weight: 500;
}

.up-editor {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-height: 0;
  padding: 16px 20px 0;
}
.up-textarea {
  flex: 1;
  width: 100%;
  resize: none;
  border: 1px solid rgba(255, 255, 255, 0.06);
  border-radius: 8px;
  background: rgba(20, 27, 36, 0.6);
  color: #d8e1ec;
  font-family: 'JetBrains Mono', 'Fira Code', ui-monospace, monospace;
  font-size: 13px;
  line-height: 1.7;
  padding: 16px;
  outline: none;
}
.up-textarea::placeholder {
  color: #5a6a7a;
}
.up-textarea:focus {
  border-color: rgba(0, 229, 201, 0.3);
}
.up-footer {
  display: flex;
  justify-content: space-between;
  padding: 8px 4px 12px;
  font-size: 11px;
  color: #5a6a7a;
  flex-shrink: 0;
}
</style>
