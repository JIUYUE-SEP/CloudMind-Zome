<template>
  <div
    v-if="visible"
    ref="panelRef"
    class="sys-settings-panel"
    :class="{ dragging }"
    :style="panelStyle"
    @click.stop
    @mousedown="onMouseDown"
  >
    <div class="ss-title">系统设置</div>

    <div class="ss-tabs">
      <button
        v-for="t in tabs"
        :key="t.key"
        class="ss-tab"
        :class="{ active: activeTab === t.key }"
        @click="activeTab = t.key"
      >
        {{ t.label }}
      </button>
    </div>

    <div class="ss-body">
      <!-- 工具 -->
      <div v-if="activeTab === 'tools'" class="ss-section">
        <div class="ss-hint">已注册工具列表（V1.2 支持开关控制）</div>
        <div class="ss-tool-list">
          <div v-for="tool in toolList" :key="tool.name" class="ss-tool-row">
            <span class="ss-tool-name">{{ tool.name }}</span>
            <span class="ss-tool-set">{{ tool.toolset }}</span>
            <span :class="['ss-tool-badge', tool.safe_to_parallel ? 'safe' : 'unsafe']">
              {{ tool.safe_to_parallel ? '并行' : '串行' }}
            </span>
          </div>
        </div>
      </div>

      <!-- 记忆 -->
      <div v-if="activeTab === 'memory'" class="ss-section">
        <label class="ss-field">
          <span>压缩阈值 (0-1)</span>
          <input
            v-model.number="form.context.compact_threshold"
            type="number"
            step="0.05"
            min="0"
            max="1"
          />
        </label>
        <label class="ss-field">
          <span>保留最近消息数</span>
          <input v-model.number="form.context.keep_recent" type="number" min="1" max="20" />
        </label>
        <label class="ss-field">
          <span>热记忆上限</span>
          <input v-model.number="form.context.hot_memory_limit" type="number" min="1" max="50" />
        </label>
        <label class="ss-field">
          <span>温记忆上限</span>
          <input v-model.number="form.context.warm_memory_limit" type="number" min="1" max="50" />
        </label>
      </div>

      <!-- LLM -->
      <div v-if="activeTab === 'llm'" class="ss-section">
        <div class="ss-hint">
          Fallback 链第一个即为默认 Provider。未配置 Fallback 时不启用外部模型。
        </div>

        <div class="ss-sub">Fallback 链（拖拽排序，第一个为默认）</div>
        <div class="ss-tags">
          <span
            v-for="(p, i) in form.provider.fallback_chain"
            :key="p + '-' + i"
            class="ss-tag"
            draggable="true"
            :class="{ 'tag-dragging': dragFallbackIndex === i }"
            @dragstart="onFallbackDragStart($event, i)"
            @dragover.prevent="onFallbackDragOver($event, i)"
            @drop="onFallbackDrop($event, i)"
            @dragend="onFallbackDragEnd"
          >
            <span class="drag-handle">::</span>
            {{ p }}
            <button @click="removeFallback(i)">×</button>
          </span>
        </div>
        <select v-model="fallbackInput" @change="addFallback">
          <option value="">+ 添加 fallback</option>
          <option value="deepseek">deepseek</option>
          <option value="mimo">mimo</option>
          <option value="kimicode">kimicode</option>
          <option value="glm">glm</option>
        </select>

        <div class="ss-sub">Provider 配置</div>
        <div v-for="name in ['deepseek', 'mimo', 'kimicode', 'glm']" :key="name" class="ss-provider-card">
          <div class="ss-provider-name">{{ name }}</div>
          <label class="ss-field small">
            <span>Base URL</span>
            <input v-model="form.provider[name].base_url" />
          </label>
          <label class="ss-field small">
            <span>模型名称</span>
            <input v-model="form.provider[name].model" placeholder="如 deepseek-chat" />
          </label>
          <label class="ss-field small">
            <span>API Key</span>
            <input
              v-model="form.provider[name].api_key"
              :type="showKey[name] ? 'text' : 'password'"
              placeholder="未设置"
            />
            <button class="ss-toggle-key" @click="showKey[name] = !showKey[name]">
              {{ showKey[name] ? '隐藏' : '显示' }}
            </button>
          </label>
        </div>

        <label class="ss-field">
          <span>Tavily API Key</span>
          <input v-model="form.tavily.api_key" :type="showKey.tavily ? 'text' : 'password'" placeholder="未设置" />
          <button class="ss-toggle-key" @click="showKey.tavily = !showKey.tavily">
            {{ showKey.tavily ? '隐藏' : '显示' }}
          </button>
        </label>
      </div>

      <!-- 辅助模型 -->
      <div v-if="activeTab === 'assistant'" class="ss-section">
        <div class="ss-hint">
          辅助模型负责后台 NLP 任务（记忆压缩、相关性过滤等），<br />
          与 Agent 对话模型完全独立。直接输入 URL、模型名称和 API Key 即可。
        </div>
        <label class="ss-field">
          <span>Base URL</span>
          <input v-model="form.assistant_model.base_url" placeholder="如 https://api.deepseek.com/v1" />
        </label>
        <label class="ss-field">
          <span>模型名称</span>
          <input v-model="form.assistant_model.model" placeholder="如 deepseek-chat" />
        </label>
        <label class="ss-field">
          <span>API Key</span>
          <input
            v-model="form.assistant_model.api_key"
            :type="showKey.assistant ? 'text' : 'password'"
            placeholder="未设置"
          />
          <button class="ss-toggle-key" @click="showKey.assistant = !showKey.assistant">
            {{ showKey.assistant ? '隐藏' : '显示' }}
          </button>
        </label>
      </div>

      <!-- Embedding -->
      <div v-if="activeTab === 'embedding'" class="ss-section">
        <div class="ss-hint">
          Embedding 模型用于语义记忆搜索。<br />
          与 Agent 对话模型完全独立。直接输入 URL、模型名称和 API Key 即可。
        </div>
        <label class="ss-field">
          <span>Base URL</span>
          <input v-model="form.embedding_model.base_url" placeholder="如 https://api.openai.com/v1" />
        </label>
        <label class="ss-field">
          <span>模型名称</span>
          <input v-model="form.embedding_model.model" placeholder="如 text-embedding-3-small" />
        </label>
        <label class="ss-field">
          <span>API Key</span>
          <input
            v-model="form.embedding_model.api_key"
            :type="showKey.embedding ? 'text' : 'password'"
            placeholder="未设置"
          />
          <button class="ss-toggle-key" @click="showKey.embedding = !showKey.embedding">
            {{ showKey.embedding ? '隐藏' : '显示' }}
          </button>
        </label>
      </div>

      <!-- Skill -->
      <div v-if="activeTab === 'skill'" class="ss-section">
        <div class="ss-placeholder">技能系统（Skill）即将在 V1.2 推出</div>
      </div>

      <!-- MCP -->
      <div v-if="activeTab === 'mcp'" class="ss-section">
        <div class="ss-placeholder">MCP 服务器管理即将在 V1.2 推出</div>
      </div>

      <!-- ACP -->
      <div v-if="activeTab === 'acp'" class="ss-section">
        <div class="ss-placeholder">ACP 协议管理即将在 V1.2 推出</div>
      </div>
    </div>

    <div v-if="saveMsg" class="ss-msg" :class="saveMsgType">{{ saveMsg }}</div>
    <div class="ss-actions">
      <button class="ss-save" @click="save">保存</button>
      <button class="ss-cancel" @click="emit('close')">关闭</button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, reactive, onMounted, watch } from 'vue'
import { api } from '@/api/client'

const props = defineProps<{ visible: boolean }>()
const emit = defineEmits(['close'])

const panelRef = ref<HTMLElement>()
const dragging = ref(false)
const dragOffset = ref({ x: 0, y: 0 })
const dragPos = ref({ x: 0, y: 0 })
const panelStyle = ref('')

const activeTab = ref('tools')
const tabs = [
  { key: 'tools', label: '工具' },
  { key: 'memory', label: '记忆' },
  { key: 'llm', label: '对话模型' },
  { key: 'assistant', label: '辅助模型' },
  { key: 'embedding', label: 'Embedding' },
  { key: 'skill', label: '技能' },
  { key: 'mcp', label: 'MCP' },
  { key: 'acp', label: 'ACP' },
]

const toolList = ref<any[]>([])
const fallbackInput = ref('')
const showKey = reactive<Record<string, boolean>>({
  deepseek: false,
  mimo: false,
  kimicode: false,
  glm: false,
  tavily: false,
  assistant: false,
  embedding: false,
})

const saveMsg = ref('')
const saveMsgType = ref<'success' | 'error'>('success')
const dragFallbackIndex = ref<number | null>(null)

// Default form structure
const form = reactive<any>({
  context: { compact_threshold: 0.8, keep_recent: 3, hot_memory_limit: 10, warm_memory_limit: 20 },
  provider: {
    default: '',
    fallback_chain: [] as string[],
    deepseek: { base_url: '', model: '', api_key: '' },
    mimo: { base_url: '', model: '', api_key: '' },
    kimicode: { base_url: '', model: '', api_key: '' },
    glm: { base_url: '', model: '', api_key: '' },
  },
  assistant_model: { base_url: '', model: '', api_key: '' },
  embedding_model: { base_url: '', model: '', api_key: '' },
  tavily: { api_key: '' },
})

/** Deep-merge source into target for nested objects. */
function mergeConfig(target: any, source: any) {
  for (const key in source) {
    const sv = source[key]
    if (sv && typeof sv === 'object' && !Array.isArray(sv)) {
      if (!target[key] || typeof target[key] !== 'object') target[key] = {}
      mergeConfig(target[key], sv)
    } else {
      target[key] = sv
    }
  }
}

onMounted(() => {
  loadConfig()
  loadTools()
})

watch(() => props.visible, (v) => {
  if (v) {
    loadConfig()
    loadTools()
  }
})

async function loadConfig() {
  saveMsg.value = ''
  const json = await api.get('/config')
  if (json.code === 0) {
    const d = json.data
    if (d.context) mergeConfig(form.context, d.context)
    if (d.provider) mergeConfig(form.provider, d.provider)
    if (d.assistant_model) mergeConfig(form.assistant_model, d.assistant_model)
    if (d.embedding_model) mergeConfig(form.embedding_model, d.embedding_model)
    if (d.tavily) mergeConfig(form.tavily, d.tavily)
  } else {
    console.error('[Settings] loadConfig failed:', json.message)
  }
}

async function loadTools() {
  const json = await api.get('/config/tools')
  if (json.code === 0) {
    toolList.value = json.data
  }
}

function addFallback() {
  const p = fallbackInput.value
  if (p && !form.provider.fallback_chain.includes(p)) {
    form.provider.fallback_chain.push(p)
  }
  fallbackInput.value = ''
}

function removeFallback(i: number) {
  form.provider.fallback_chain.splice(i, 1)
}

// Fallback chain drag & drop reorder
function onFallbackDragStart(e: DragEvent, index: number) {
  dragFallbackIndex.value = index
  if (e.dataTransfer) {
    e.dataTransfer.effectAllowed = 'move'
    e.dataTransfer.setData('text/plain', String(index))
  }
}

function onFallbackDragOver(e: DragEvent, _index: number) {
  if (e.dataTransfer) e.dataTransfer.dropEffect = 'move'
}

function onFallbackDrop(e: DragEvent, toIndex: number) {
  const fromIndex = Number(e.dataTransfer?.getData('text/plain'))
  if (isNaN(fromIndex) || fromIndex === toIndex) return
  const arr = form.provider.fallback_chain
  const item = arr.splice(fromIndex, 1)[0]
  arr.splice(toIndex, 0, item)
}

function onFallbackDragEnd() {
  dragFallbackIndex.value = null
}

async function save() {
  const payload: any = {}
  payload.context = { ...form.context }
  payload.provider = {
    default: form.provider.fallback_chain[0] || '',
    fallback_chain: [...form.provider.fallback_chain],
    deepseek: { ...form.provider.deepseek },
    mimo: { ...form.provider.mimo },
    kimicode: { ...form.provider.kimicode },
    glm: { ...form.provider.glm },
  }
  payload.assistant_model = { ...form.assistant_model }
  payload.embedding_model = { ...form.embedding_model }
  payload.tavily = { ...form.tavily }

  console.log('[Settings] save payload:', JSON.stringify(payload, null, 2))
  const json = await api.put('/config', payload)
  console.log('[Settings] save response:', json)

  if (json.code === 0) {
    saveMsg.value = '保存成功'
    saveMsgType.value = 'success'
    setTimeout(() => emit('close'), 400)
  } else {
    const detail = json.data?.error || json.message || JSON.stringify(json)
    saveMsg.value = '保存失败: ' + detail
    saveMsgType.value = 'error'
  }
}

// Drag
function onMouseDown(e: MouseEvent) {
  const target = e.target as HTMLElement
  if (!target.classList.contains('ss-title')) return
  dragging.value = true
  dragOffset.value = { x: e.clientX - dragPos.value.x, y: e.clientY - dragPos.value.y }
  document.body.style.userSelect = 'none'
  document.addEventListener('mousemove', onMouseMove)
  document.addEventListener('mouseup', onMouseUp)
}
function onMouseMove(e: MouseEvent) {
  if (!dragging.value) return
  dragPos.value = { x: e.clientX - dragOffset.value.x, y: e.clientY - dragOffset.value.y }
  panelStyle.value = `transform: translate(${dragPos.value.x}px, ${dragPos.value.y}px)`
}
function onMouseUp() {
  dragging.value = false
  document.body.style.userSelect = ''
  document.removeEventListener('mousemove', onMouseMove)
  document.removeEventListener('mouseup', onMouseUp)
}
</script>

<style scoped>
.sys-settings-panel {
  position: absolute;
  bottom: 120px;
  right: 116px;
  width: 380px;
  max-height: 520px;
  padding: 14px;
  background: rgba(11, 15, 23, 0.92);
  backdrop-filter: blur(16px);
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: 12px;
  z-index: 120;
  color: #D8E1EC;
  display: flex;
  flex-direction: column;
}
.ss-title {
  font-size: 13px;
  font-weight: 600;
  margin-bottom: 10px;
  cursor: grab;
  user-select: none;
  flex-shrink: 0;
}
.sys-settings-panel.dragging .ss-title {
  cursor: grabbing;
}
.ss-tabs {
  display: flex;
  gap: 4px;
  margin-bottom: 10px;
  flex-shrink: 0;
  overflow-x: auto;
}
.ss-tab {
  padding: 5px 10px;
  background: rgba(255, 255, 255, 0.04);
  border: 1px solid rgba(255, 255, 255, 0.06);
  border-radius: 6px;
  color: #8899AA;
  font-size: 11px;
  cursor: pointer;
  white-space: nowrap;
}
.ss-tab.active,
.ss-tab:hover {
  background: rgba(0, 229, 201, 0.12);
  border-color: rgba(0, 229, 201, 0.3);
  color: #00E5C9;
}
.ss-body {
  flex: 1;
  overflow-y: auto;
  font-size: 12px;
}
.ss-body::-webkit-scrollbar {
  width: 4px;
}
.ss-body::-webkit-scrollbar-thumb {
  background: rgba(255, 255, 255, 0.1);
  border-radius: 2px;
}
.ss-section {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.ss-field {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.ss-field.small {
  gap: 2px;
}
.ss-field span {
  font-size: 11px;
  color: #8899AA;
}
.ss-field input,
.ss-field select {
  padding: 8px;
  background: #141B24;
  border: 1px solid #1E2731;
  border-radius: 6px;
  color: #D8E1EC;
  font-size: 12px;
  width: 100%;
  box-sizing: border-box;
}
.ss-field input:focus,
.ss-field select:focus {
  outline: none;
  border-color: rgba(0, 229, 201, 0.4);
}
.ss-toggle-key {
  align-self: flex-start;
  margin-top: 2px;
  padding: 2px 8px;
  background: transparent;
  border: 1px solid rgba(255, 255, 255, 0.1);
  border-radius: 4px;
  color: #5A6A7A;
  font-size: 11px;
  cursor: pointer;
}
.ss-toggle-key:hover {
  color: #00E5C9;
  border-color: rgba(0, 229, 201, 0.3);
}
.ss-sub {
  font-size: 11px;
  color: #5A6A7A;
  margin-top: 4px;
}
.ss-tags {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.ss-tag {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 3px 8px;
  background: rgba(0, 229, 201, 0.1);
  color: #00E5C9;
  border-radius: 10px;
  font-size: 11px;
}
.ss-tag button {
  background: transparent;
  border: none;
  color: #00E5C9;
  cursor: pointer;
  font-size: 11px;
  padding: 0;
}
.ss-tag .drag-handle {
  color: #5A6A7A;
  cursor: grab;
  margin-right: 4px;
  font-size: 10px;
}
.ss-tag.tag-dragging {
  opacity: 0.5;
  border: 1px dashed rgba(0, 229, 201, 0.5);
}
.ss-provider-card {
  padding: 8px;
  background: rgba(255, 255, 255, 0.03);
  border: 1px solid rgba(255, 255, 255, 0.06);
  border-radius: 8px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.ss-provider-name {
  font-size: 12px;
  font-weight: 500;
  color: #D8E1EC;
}
.ss-tool-list {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.ss-tool-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 8px;
  background: rgba(255, 255, 255, 0.03);
  border-radius: 6px;
}
.ss-tool-name {
  flex: 1;
  color: #D8E1EC;
}
.ss-tool-set {
  color: #5A6A7A;
  font-size: 11px;
}
.ss-tool-badge {
  font-size: 10px;
  padding: 2px 6px;
  border-radius: 4px;
}
.ss-tool-badge.safe {
  background: rgba(16, 185, 129, 0.15);
  color: #10B981;
}
.ss-tool-badge.unsafe {
  background: rgba(245, 158, 11, 0.15);
  color: #F59E0B;
}
.ss-placeholder {
  color: #5A6A7A;
  text-align: center;
  padding: 30px 0;
}
.ss-hint {
  font-size: 11px;
  color: #5A6A7A;
}
.ss-msg {
  text-align: center;
  font-size: 11px;
  padding: 6px;
  border-radius: 4px;
  flex-shrink: 0;
}
.ss-msg.success {
  color: #10B981;
  background: rgba(16, 185, 129, 0.1);
}
.ss-msg.error {
  color: #EF4444;
  background: rgba(239, 68, 68, 0.1);
}
.ss-actions {
  display: flex;
  gap: 8px;
  margin-top: 6px;
  flex-shrink: 0;
}
.ss-actions button {
  flex: 1;
  padding: 8px;
  border-radius: 6px;
  font-size: 12px;
  cursor: pointer;
  transition: all 0.15s;
}
.ss-save {
  background: #00E5C9;
  color: #0B0F17;
  border: none;
  font-weight: 600;
}
.ss-save:hover {
  background: #00d1b8;
}
.ss-cancel {
  background: transparent;
  border: 1px solid rgba(255, 255, 255, 0.1);
  color: #8899AA;
}
.ss-cancel:hover {
  border-color: rgba(255, 255, 255, 0.2);
  color: #D8E1EC;
}
</style>
