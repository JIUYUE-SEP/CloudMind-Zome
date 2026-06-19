<template>
  <div class="self-image-view">
    <!-- 左侧：心智列表 -->
    <aside class="si-sidebar">
      <div class="sidebar-header">
        <BackButton />
        <h3>心智侧写</h3>
      </div>
      <div class="sidebar-list">
        <div
          v-for="a in agentsStore.list"
          :key="a.id"
          class="agent-row"
          :class="{ active: selectedId === a.id }"
          @click="selectAgent(a.id)"
        >
          <img v-if="a.portrait_url" :src="$uploadUrl(a.portrait_url)" class="agent-avatar" />
          <div
            v-else
            class="agent-avatar fallback"
            :style="{ backgroundColor: a.represent_color }"
          >
            {{ a.name.charAt(0) }}
          </div>
          <div class="agent-meta">
            <div class="agent-name">{{ a.name }}</div>
            <div class="agent-code">{{ a.codename }}</div>
          </div>
        </div>
        <div v-if="!agentsStore.list.length" class="sidebar-empty">暂无心智</div>
      </div>
    </aside>

    <!-- 中间：心智文件编辑器 -->
    <main v-if="selectedAgent" class="si-main">
      <div class="editor-header">
        <div class="agent-info">
          <img
            v-if="selectedAgent.portrait_url"
            :src="$uploadUrl(selectedAgent.portrait_url)"
            class="editor-avatar"
          />
          <div
            v-else
            class="editor-avatar fallback"
            :style="{ backgroundColor: selectedAgent.represent_color }"
          >
            {{ selectedAgent.name.charAt(0) }}
          </div>
          <div>
            <div class="editor-name">{{ selectedAgent.name }}</div>
            <div class="editor-sub">{{ selectedAgent.codename }}</div>
          </div>
        </div>
        <div class="save-status">
          <span v-if="saving" class="status-saving">保存中…</span>
          <span v-else-if="dirty" class="status-dirty">未保存</span>
          <span v-else class="status-saved">已保存</span>
          <button class="save-btn" :disabled="saving || !dirty" @click="saveCurrent">
            保存
          </button>
        </div>
      </div>

      <!-- Tab 栏 -->
      <div class="tab-bar">
        <button
          v-for="tab in tabs"
          :key="tab.key"
          class="tab-btn"
          :class="{ active: currentTab === tab.key }"
          @click="switchTab(tab.key)"
        >
          {{ tab.label }}
          <span v-if="dirtyMap[tab.key]" class="tab-dirty">●</span>
        </button>
      </div>

      <!-- 编辑器 -->
      <div class="editor-body">
        <textarea
          v-model="contentMap[currentTab]"
          class="editor-textarea"
          :placeholder="currentPlaceholder"
          spellcheck="false"
          @input="onInput"
        />
        <div class="editor-footer">
          <span class="footer-hint">
            {{ currentTabDesc }} · {{ contentLength }} 字符
          </span>
          <span class="footer-hint">
            快捷键 Ctrl+S 保存
          </span>
        </div>
      </div>
    </main>

    <!-- 空状态 -->
    <main v-else class="si-main empty">
      <div class="empty-hint">选择一个心智，编辑它的心智文件</div>
    </main>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted } from 'vue'
import { useAgentsStore } from '@/stores/agents'
import { api } from '@/api/client'
import BackButton from '@/components/BackButton.vue'

const agentsStore = useAgentsStore()
const selectedId = ref<string | null>(null)

const tabs = [
  { key: 'USER', label: 'USER', desc: '心智眼中的用户：你对指挥官的理解和印象' },
  { key: 'SOUL', label: 'SOUL', desc: '灵魂内核：人格、创伤、原则、说话风格' },
  { key: 'AGENT', label: 'AGENT', desc: '工作规范：规则、安全、心跳、记忆策略' },
  { key: 'MEMORY', label: 'MEMORY', desc: '记忆日记：事件、互动、情感记录' },
] as const

type TabKey = typeof tabs[number]['key']
const currentTab = ref<TabKey>('USER')

const contentMap = ref<Record<TabKey, string>>({
  USER: '',
  SOUL: '',
  AGENT: '',
  MEMORY: '',
})

const originalMap = ref<Record<TabKey, string>>({
  USER: '',
  SOUL: '',
  AGENT: '',
  MEMORY: '',
})

const dirtyMap = ref<Record<TabKey, boolean>>({
  USER: false,
  SOUL: false,
  AGENT: false,
  MEMORY: false,
})

const saving = ref(false)

const selectedAgent = computed(() =>
  agentsStore.list.find((a) => a.id === selectedId.value)
)

const dirty = computed(() => dirtyMap.value[currentTab.value])

const currentPlaceholder = computed(() => {
  const t = tabs.find((x) => x.key === currentTab.value)
  return t ? `${t.label}.md — ${t.desc}` : ''
})

const currentTabDesc = computed(() => {
  const t = tabs.find((x) => x.key === currentTab.value)
  return t?.desc || ''
})

const contentLength = computed(() =>
  (contentMap.value[currentTab.value] || '').length
)

function onInput() {
  const key = currentTab.value
  dirtyMap.value[key] = contentMap.value[key] !== originalMap.value[key]
}

async function loadFile(key: TabKey) {
  if (!selectedId.value) return
  const res = await api.get<{ content: string }>(
    `/agents/${selectedId.value}/mind/${key}`
  )
  if (res.code === 0 && res.data) {
    contentMap.value[key] = res.data.content
    originalMap.value[key] = res.data.content
    dirtyMap.value[key] = false
  }
}

async function loadAll() {
  for (const tab of tabs) {
    await loadFile(tab.key)
  }
}

async function saveCurrent() {
  if (!selectedId.value || !dirty.value) return
  const key = currentTab.value
  saving.value = true
  const res = await api.put(`/agents/${selectedId.value}/mind/${key}`, {
    content: contentMap.value[key],
  })
  saving.value = false
  if (res.code === 0) {
    originalMap.value[key] = contentMap.value[key]
    dirtyMap.value[key] = false
  } else {
    alert('保存失败：' + (res.message || '未知错误'))
  }
}

function switchTab(key: TabKey) {
  currentTab.value = key
}

function selectAgent(id: string) {
  if (selectedId.value === id) return
  selectedId.value = id
  loadAll()
}

// Ctrl+S shortcut
function onKeyDown(e: KeyboardEvent) {
  if ((e.ctrlKey || e.metaKey) && e.key === 's') {
    e.preventDefault()
    saveCurrent()
  }
}

onMounted(() => {
  window.addEventListener('keydown', onKeyDown)
  agentsStore.fetchList().then(() => {
    if (agentsStore.list.length && !selectedId.value) {
      selectedId.value = agentsStore.list[0].id
      loadAll()
    }
  })
})

onUnmounted(() => {
  window.removeEventListener('keydown', onKeyDown)
})
</script>

<style scoped>
.self-image-view {
  position: fixed;
  inset: 0;
  background: #0b0f17;
  z-index: 900;
  display: flex;
  color: #d8e1ec;
  font-family: system-ui, -apple-system, sans-serif;
}

/* Sidebar */
.si-sidebar {
  width: 220px;
  flex-shrink: 0;
  border-right: 1px solid rgba(255, 255, 255, 0.06);
  display: flex;
  flex-direction: column;
  background: rgba(11, 15, 23, 0.8);
}
.sidebar-header {
  height: 56px;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 0 16px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.06);
}
.sidebar-header h3 {
  margin: 0;
  font-size: 14px;
  font-weight: 600;
}
.sidebar-list {
  flex: 1;
  overflow-y: auto;
  padding: 8px;
}
.agent-row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 8px;
  border-radius: 8px;
  cursor: pointer;
  transition: background 0.15s;
}
.agent-row:hover {
  background: rgba(255, 255, 255, 0.04);
}
.agent-row.active {
  background: rgba(0, 229, 201, 0.08);
}
.agent-avatar {
  width: 36px;
  height: 36px;
  border-radius: 50%;
  object-fit: cover;
  flex-shrink: 0;
}
.agent-avatar.fallback {
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 14px;
  font-weight: 600;
  color: #0b0f17;
}
.agent-meta {
  min-width: 0;
}
.agent-name {
  font-size: 13px;
  color: #d8e1ec;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.agent-code {
  font-size: 11px;
  color: #5a6a7a;
}
.sidebar-empty {
  padding: 20px;
  text-align: center;
  color: #5a6a7a;
  font-size: 13px;
}

/* Main */
.si-main {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-width: 0;
}
.si-main.empty {
  align-items: center;
  justify-content: center;
  color: #5a6a7a;
  font-size: 14px;
}

/* Editor header */
.editor-header {
  height: 56px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 20px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.06);
  flex-shrink: 0;
}
.agent-info {
  display: flex;
  align-items: center;
  gap: 12px;
}
.editor-avatar {
  width: 32px;
  height: 32px;
  border-radius: 50%;
  object-fit: cover;
}
.editor-avatar.fallback {
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 14px;
  font-weight: 600;
  color: #0b0f17;
}
.editor-name {
  font-size: 14px;
  font-weight: 500;
  color: #d8e1ec;
}
.editor-sub {
  font-size: 11px;
  color: #5a6a7a;
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

/* Tab bar */
.tab-bar {
  display: flex;
  gap: 4px;
  padding: 8px 20px 0;
  border-bottom: 1px solid rgba(255, 255, 255, 0.06);
  flex-shrink: 0;
}
.tab-btn {
  padding: 8px 16px;
  border: none;
  background: transparent;
  color: #8899aa;
  font-size: 13px;
  cursor: pointer;
  border-bottom: 2px solid transparent;
  margin-bottom: -1px;
  transition: color 0.15s;
  display: flex;
  align-items: center;
  gap: 4px;
}
.tab-btn:hover {
  color: #d8e1ec;
}
.tab-btn.active {
  color: #00e5c9;
  border-bottom-color: #00e5c9;
}
.tab-dirty {
  color: #ff7b72;
  font-size: 8px;
}

/* Editor body */
.editor-body {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-height: 0;
  padding: 12px 20px 0;
}
.editor-textarea {
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
.editor-textarea::placeholder {
  color: #5a6a7a;
}
.editor-textarea:focus {
  border-color: rgba(0, 229, 201, 0.3);
}
.editor-footer {
  display: flex;
  justify-content: space-between;
  padding: 8px 4px 12px;
  font-size: 11px;
  color: #5a6a7a;
  flex-shrink: 0;
}
</style>
