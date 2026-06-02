<template>
  <div class="agent-edit">
    <!-- ========== 左侧：心智列表 ========== -->
    <aside class="ae-sidebar">
      <div class="sidebar-header">
        <div class="header-left">
          <BackButton />
          <h3>心智整备</h3>
        </div>
        <button class="sidebar-add" @click="createNew">+ 新建</button>
      </div>
      <div class="sidebar-list">
        <div
          v-for="a in agentsStore.list"
          :key="a.id"
          class="agent-row"
          :class="{ active: selectedId === a.id }"
          @click="selectAgent(a.id)"
        >
          <img v-if="a.portrait_url" :src="a.portrait_url" class="agent-avatar" />
          <div
            v-else
            class="agent-avatar fallback"
            :style="{ backgroundColor: a.represent_color }"
          >
            {{ a.name.charAt(0) }}
          </div>
          <div class="agent-meta">
            <div class="agent-name">
              {{ a.name }}
              <span :class="['status-dot', a.status || 'idle']" />
            </div>
            <div class="agent-code">{{ a.codename }}</div>
          </div>
        </div>
        <div v-if="!agentsStore.list.length" class="sidebar-empty">暂无心智</div>
      </div>
    </aside>

    <!-- ========== 中间：展示区 ========== -->
    <main class="ae-center">
      <div class="stage">
        <!-- 展示模式切换 -->
        <div class="display-modes">
          <button
            v-for="m in displayModes"
            :key="m.key"
            class="mode-btn"
            :class="{ active: displayMode === m.key }"
            @click="displayMode = m.key"
          >
            {{ m.label }}
          </button>
        </div>

        <!-- Viewer -->
        <div class="viewer-wrap">
          <PortraitViewer
            v-if="displayMode === 'portrait'"
            :url="form.portrait_url"
          />
          <Live2DViewer
            v-else-if="displayMode === 'live2d'"
            :model-url="form.live2d_model_url"
          />
          <VRMViewer
            v-else-if="displayMode === 'vrm'"
            :model-url="form.model_url"
          />
        </div>
      </div>

      <div class="center-info">
        <div class="info-name">{{ form.name || '未命名心智' }}</div>
        <div class="info-code">{{ form.codename || '---' }}</div>
        <div class="info-bar">
          <span class="info-dot" :style="{ background: form.represent_color }"></span>
          <span class="info-status">{{ isCreate ? '新建' : statusLabel(liveStatus) }}</span>
        </div>
      </div>
    </main>

    <!-- ========== 右侧：选项栏 + 设置面板 ========== -->
    <aside class="ae-right">
      <!-- 选项按钮 -->
      <div class="right-tabs">
        <button
          v-for="tab in tabs"
          :key="tab.key"
          class="tab-btn"
          :class="{ active: activeTab === tab.key }"
          @click="toggleTab(tab.key)"
        >
          <span class="tab-icon">{{ tab.icon }}</span>
          <span class="tab-label">{{ tab.label }}</span>
        </button>
      </div>

      <!-- 设置面板（滑出） -->
      <Transition name="panel-slide">
        <div v-if="activeTab" class="settings-panel">
          <div class="panel-header">
            <span>{{ currentTab?.label }}</span>
            <button class="panel-close" @click="activeTab = null">×</button>
          </div>

          <div class="panel-scroll">
            <!-- 心智档案 -->
            <div v-if="activeTab === 'profile'" class="panel-section">
              <label>名称</label>
              <input v-model="form.name" placeholder="心智名称" />

              <label>代号</label>
              <input v-model="form.codename" placeholder="自动分配" />

              <label>代表色</label>
              <div class="color-row">
                <input type="color" v-model="form.represent_color" />
                <span class="color-value">{{ form.represent_color }}</span>
              </div>
            </div>

            <!-- 人格内核 -->
            <div v-if="activeTab === 'persona'" class="panel-section">
              <label>人格 Prompt</label>
              <textarea
                v-model="form.personality_prompt"
                rows="10"
                placeholder="描述这个心智的人格、行为方式、说话风格、专业知识领域..."
              />
            </div>

            <!-- 能力标签 -->
            <div v-if="activeTab === 'skills'" class="panel-section">
              <label>能力标签</label>
              <div class="tag-list">
                <span
                  v-for="(t, i) in form.capabilities"
                  :key="i"
                  class="tag"
                >
                  {{ t }}
                  <button @click="removeCap(i)">×</button>
                </span>
                <input
                  v-model="capInput"
                  @keydown.enter.prevent="addCap"
                  placeholder="+ 添加能力"
                />
              </div>

              <label style="margin-top: 16px">代称 / 昵称</label>
              <div class="tag-list">
                <span
                  v-for="(t, i) in form.aliases"
                  :key="i"
                  class="tag"
                >
                  {{ t }}
                  <button @click="removeAlias(i)">×</button>
                </span>
                <input
                  v-model="aliasInput"
                  @keydown.enter.prevent="addAlias"
                  placeholder="+ 添加代称（如 vivi）"
                />
              </div>

              <label style="margin-top: 16px">分组标签</label>
              <div class="tag-list">
                <span
                  v-for="(t, i) in form.tags"
                  :key="i"
                  class="tag"
                  style="background: rgba(255,184,0,0.1); color: #FFB800;"
                >
                  {{ t }}
                  <button @click="removeTag(i)" style="color: #FFB800">×</button>
                </span>
                <input
                  v-model="tagInput"
                  @keydown.enter.prevent="addTag"
                  placeholder="+ 添加分组标签"
                />
              </div>
            </div>

            <!-- 算力配置 -->
            <div v-if="activeTab === 'compute'" class="panel-section">
              <label>推理模型</label>
              <select v-model="form.llm_config.provider" @change="onLlmProviderChange">
                <option value="">请选择平台</option>
                <option v-for="p in llmProviders" :key="p.name" :value="p.name">
                  {{ p.display_name }}
                </option>
              </select>

              <div v-if="currentLlmProvider" class="model-select-row">
                <select v-model="form.llm_config.model" :disabled="!currentLlmModels.length">
                  <option value="">请选择模型</option>
                  <option v-for="m in currentLlmModels" :key="m" :value="m">
                    {{ m }}
                  </option>
                </select>
                <div class="capability-icons">
                  <span v-if="currentLlmProvider.supports_vision" title="支持图片输入">👁️</span>
                  <span v-if="currentLlmProvider.supports_reasoning" title="支持推理">🧠</span>
                  <span v-if="currentLlmProvider.supports_streaming" title="支持流式">⚡</span>
                </div>
              </div>
              <div v-if="!currentLlmModels.length && form.llm_config.provider" class="hint-text">
                该平台未配置模型
              </div>

              <div class="sep" />

              <label class="checkbox-label">
                <input type="checkbox" v-model="form.useIndependentMarker" />
                使用独立标注模型
              </label>
              <div v-if="form.useIndependentMarker" class="sub-config">
                <select v-model="form.llm_config.marker.provider" @change="onMarkerProviderChange">
                  <option value="">请选择平台</option>
                  <option v-for="p in llmProviders" :key="p.name" :value="p.name">
                    {{ p.display_name }}
                  </option>
                </select>
                <select v-model="form.llm_config.marker.model" :disabled="!currentMarkerModels.length">
                  <option value="">请选择模型</option>
                  <option v-for="m in currentMarkerModels" :key="m" :value="m">
                    {{ m }}
                  </option>
                </select>
              </div>

              <div class="sep" />

              <label class="checkbox-label">
                <input type="checkbox" v-model="form.useIndependentEmbedder" />
                使用独立嵌入模型
              </label>
              <div v-if="form.useIndependentEmbedder" class="sub-config">
                <select v-model="form.llm_config.embedder.provider" @change="onEmbedderProviderChange">
                  <option value="">请选择平台</option>
                  <option v-for="p in llmProviders" :key="p.name" :value="p.name">
                    {{ p.display_name }}
                  </option>
                </select>
                <select v-model="form.llm_config.embedder.model" :disabled="!currentEmbedderModels.length">
                  <option value="">请选择模型</option>
                  <option v-for="m in currentEmbedderModels" :key="m" :value="m">
                    {{ m }}
                  </option>
                </select>
              </div>
            </div>

            <!-- 外观立绘 -->
            <div v-if="activeTab === 'appearance'" class="panel-section">
              <label>立绘</label>
              <div class="portrait-row">
                <img
                  v-if="form.portrait_url"
                  :src="form.portrait_url"
                  class="portrait-preview"
                />
                <div v-else class="portrait-placeholder">暂无</div>
                <button class="upload-btn" @click="triggerPortraitUpload">
                  上传
                </button>
              </div>

              <div class="sep" />

              <label>3D 模型 (VRM)</label>
              <div v-if="form.model_url" class="model-info">
                <div class="model-filename">{{ modelFileName }}</div>
                <button class="upload-btn" @click="triggerModelUpload">替换</button>
              </div>
              <button v-else class="upload-btn wide" @click="triggerModelUpload">
                导入 3D 模型
              </button>

              <div class="sep" />

              <label>Live2D 模型</label>
              <div v-if="form.live2d_model_url" class="model-info">
                <div class="model-filename">已上传</div>
                <button class="upload-btn" @click="triggerLive2dUpload">替换</button>
              </div>
              <button v-else class="upload-btn wide" @click="triggerLive2dUpload">
                上传 Live2D 模型
              </button>
            </div>

            <div class="panel-actions">
              <button v-if="!isCreate" class="danger-btn" @click="deleteAgent">
                删除心智
              </button>
              <button class="save-btn" @click="save">保存</button>
            </div>
          </div>
        </div>
      </Transition>
    </aside>

    <!-- 隐藏的文件输入 -->
    <input
      ref="portraitInput"
      type="file"
      accept="image/*"
      style="display: none"
      @change="uploadPortrait"
    />
    <input
      ref="modelInput"
      type="file"
      accept=".vrm,.glb,.gltf,.fbx,.obj"
      style="display: none"
      @change="uploadModel"
    />
    <input
      ref="live2dInput"
      type="file"
      accept=".zip,.json"
      style="display: none"
      @change="uploadLive2d"
    />
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, onBeforeUnmount } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useAgentsStore } from '@/stores/agents'
import { useComputeStore } from '@/stores/compute'
import { api } from '@/api/client'
import PortraitViewer from './viewer/PortraitViewer.vue'
import Live2DViewer from './viewer/Live2DViewer.vue'
import VRMViewer from './viewer/VRMViewer.vue'
import BackButton from '@/components/BackButton.vue'

const route = useRoute()
const router = useRouter()
const agentsStore = useAgentsStore()
const computeStore = useComputeStore()

const selectedId = ref<string | null>(null)
const isCreate = ref(false)
const capInput = ref('')
const aliasInput = ref('')
const tagInput = ref('')
const activeTab = ref<string | null>(null)
const portraitInput = ref<HTMLInputElement>()
const modelInput = ref<HTMLInputElement>()
const live2dInput = ref<HTMLInputElement>()
const displayMode = ref<'portrait' | 'live2d' | 'vrm'>('portrait')
const liveStatus = ref<string>('idle')

const displayModes = [
  { key: 'portrait' as const, label: '立绘' },
  { key: 'live2d' as const, label: 'Live2D' },
  { key: 'vrm' as const, label: '3D' },
]

const llmProviders = ref<any[]>([])

const form = ref<any>({
  name: '',
  codename: '',
  personality_prompt: '',
  represent_color: '#00E5C9',
  capabilities: [],
  aliases: [],
  tags: [],
  llm_config: { provider: '', model: '' },
  useIndependentMarker: false,
  useIndependentEmbedder: false,
  portrait_url: '',
  model_url: '',
  live2d_model_url: '',
})

const currentLlmProvider = computed(() => {
  const name = form.value.llm_config.provider
  if (!name) return null
  return llmProviders.value.find((p: any) => p.name === name)
})

const currentLlmModels = computed(() => {
  return currentLlmProvider.value?.models || []
})

const currentMarkerModels = computed(() => {
  const name = form.value.llm_config.marker?.provider
  if (!name) return []
  const p = llmProviders.value.find((x: any) => x.name === name)
  return p?.models || []
})

const currentEmbedderModels = computed(() => {
  const name = form.value.llm_config.embedder?.provider
  if (!name) return []
  const p = llmProviders.value.find((x: any) => x.name === name)
  return p?.models || []
})

const currentProviderModels = computed(() => {
  // Backward compat
  const pid = form.value.llm_config.provider_id
  if (!pid) return []
  const p = computeStore.providers.find(x => x.id === pid)
  return p?.models || []
})

const tabs = [
  { key: 'profile', label: '心智档案', icon: '◈' },
  { key: 'persona', label: '人格内核', icon: '◉' },
  { key: 'skills', label: '能力标签', icon: '✦' },
  { key: 'compute', label: '算力配置', icon: '⚡' },
  { key: 'appearance', label: '外观立绘', icon: '◐' },
]

const currentTab = computed(() => tabs.find((t) => t.key === activeTab.value))

const modelFileName = computed(() => {
  if (!form.value.model_url) return ''
  const parts = form.value.model_url.split('/')
  return parts[parts.length - 1] || 'unknown'
})

onMounted(async () => {
  await Promise.all([
    agentsStore.fetchList(),
    computeStore.fetchProviders(),
    fetchLlmProviders(),
  ])

  const routeId = route.params.id as string | undefined
  if (routeId) {
    selectAgent(routeId)
  } else if (agentsStore.list.length) {
    selectAgent(agentsStore.list[0].id)
  } else {
    createNew()
  }
  window.addEventListener('ws:agent.status', onAgentStatus as any)
})

async function fetchLlmProviders() {
  const json = await api.get('/agents/providers')
  if (json.code === 0) {
    llmProviders.value = json.data || []
  }
}

onBeforeUnmount(() => {
  window.removeEventListener('ws:agent.status', onAgentStatus as any)
})

function onAgentStatus(e: any) {
  const p = e.detail
  if (!p?.agent_id) return
  const idx = agentsStore.list.findIndex(x => x.id === p.agent_id)
  if (idx >= 0) {
    agentsStore.list[idx] = { ...agentsStore.list[idx], status: p.status }
  }
  if (selectedId.value === p.agent_id) {
    liveStatus.value = p.status
  }
}

function createNew() {
  isCreate.value = true
  selectedId.value = null
  activeTab.value = 'profile'
  displayMode.value = 'portrait'
  const firstProv = llmProviders.value[0]
  form.value = {
    name: '',
    codename: '',
    personality_prompt: '',
    represent_color: '#00E5C9',
    capabilities: [],
    aliases: [],
    tags: [],
    llm_config: {
      provider: firstProv?.name || '',
      model: firstProv?.models?.[0] || '',
    },
    useIndependentMarker: false,
    useIndependentEmbedder: false,
    portrait_url: '',
    model_url: '',
    live2d_model_url: '',
  }
}

function onLlmProviderChange() {
  const name = form.value.llm_config.provider
  const p = llmProviders.value.find((x: any) => x.name === name)
  form.value.llm_config.model = p?.models?.[0] || ''
}

function onMarkerProviderChange() {
  const name = form.value.llm_config.marker?.provider
  const p = llmProviders.value.find((x: any) => x.name === name)
  if (!form.value.llm_config.marker) form.value.llm_config.marker = {}
  form.value.llm_config.marker.model = p?.models?.[0] || ''
}

function onEmbedderProviderChange() {
  const name = form.value.llm_config.embedder?.provider
  const p = llmProviders.value.find((x: any) => x.name === name)
  if (!form.value.llm_config.embedder) form.value.llm_config.embedder = {}
  form.value.llm_config.embedder.model = p?.models?.[0] || ''
}

function onProviderChange() {
  const pid = form.value.llm_config.provider_id
  const p = computeStore.providers.find(x => x.id === pid)
  form.value.llm_config.model = p?.models?.[0] || ''
}

function statusLabel(status: string) {
  const map: Record<string, string> = {
    idle: '空闲',
    busy: '思考中',
    introspecting: '内省中',
  }
  return map[status] || status
}

async function selectAgent(id: string) {
  isCreate.value = false
  selectedId.value = id
  activeTab.value = null

  let data = agentsStore.detailMap.get(id)
  if (!data) {
    const json = await api.get(`/agents/${id}`)
    if (json.code === 0) {
      data = json.data
      agentsStore.detailMap.set(id, data)
    }
  }
  if (!data) return
  liveStatus.value = data.status || 'idle'

  const llmCfg = data.llm_config || {}
  // New format: { provider, model, marker?, embedder? }
  // Old format: { provider_id, model }
  const isNewFormat = !!llmCfg.provider

  const newLlmConfig = isNewFormat
    ? {
        provider: llmCfg.provider || llmProviders.value[0]?.name || '',
        model: llmCfg.model || '',
        marker: llmCfg.marker ? { ...llmCfg.marker } : undefined,
        embedder: llmCfg.embedder ? { ...llmCfg.embedder } : undefined,
      }
    : {
        provider: llmProviders.value[0]?.name || '',
        model: '',
      }

  form.value = {
    name: data.name || '',
    codename: data.codename || '',
    personality_prompt: data.personality_prompt || '',
    represent_color: data.represent_color || '#00E5C9',
    capabilities: Array.isArray(data.capabilities) ? [...data.capabilities] : [],
    aliases: Array.isArray(data.aliases) ? [...data.aliases] : [],
    tags: Array.isArray(data.tags) ? [...data.tags] : [],
    llm_config: newLlmConfig,
    useIndependentMarker: !!llmCfg.marker,
    useIndependentEmbedder: !!llmCfg.embedder,
    portrait_url: data.portrait_url || '',
    model_url: data.model_url || '',
    live2d_model_url: data.live2d_model_url || '',
  }
}

function toggleTab(key: string) {
  activeTab.value = activeTab.value === key ? null : key
}

function addCap() {
  const t = capInput.value.trim()
  if (t && !form.value.capabilities.includes(t)) form.value.capabilities.push(t)
  capInput.value = ''
}
function removeCap(i: number) {
  form.value.capabilities.splice(i, 1)
}
function addAlias() {
  const t = aliasInput.value.trim()
  if (t && !form.value.aliases.includes(t)) form.value.aliases.push(t)
  aliasInput.value = ''
}
function removeAlias(i: number) {
  form.value.aliases.splice(i, 1)
}
function addTag() {
  const t = tagInput.value.trim()
  if (t && !form.value.tags.includes(t)) form.value.tags.push(t)
  tagInput.value = ''
}
function removeTag(i: number) {
  form.value.tags.splice(i, 1)
}

async function save() {
  const body: any = {
    name: form.value.name,
    codename: form.value.codename,
    personality_prompt: form.value.personality_prompt,
    represent_color: form.value.represent_color,
    capabilities: form.value.capabilities,
    aliases: form.value.aliases,
    tags: form.value.tags,
    portrait_url: form.value.portrait_url,
    model_url: form.value.model_url,
    live2d_model_url: form.value.live2d_model_url,
  }

  // Build llm_config
  const llm: any = {
    provider: form.value.llm_config.provider,
    model: form.value.llm_config.model,
  }
  if (form.value.useIndependentMarker && form.value.llm_config.marker?.provider) {
    llm.marker = {
      provider: form.value.llm_config.marker.provider,
      model: form.value.llm_config.marker.model,
    }
  }
  if (form.value.useIndependentEmbedder && form.value.llm_config.embedder?.provider) {
    llm.embedder = {
      provider: form.value.llm_config.embedder.provider,
      model: form.value.llm_config.embedder.model,
    }
  }
  body.llm_config = llm

  if (isCreate.value) {
    const json = await api.post('/agents', body)
    if (json.code === 0) {
      await agentsStore.fetchList()
      const newId = json.data.id
      if (newId) selectAgent(newId)
    }
  } else if (selectedId.value) {
    const json = await api.put(`/agents/${selectedId.value}`, body)
    if (json.code === 0) {
      agentsStore.detailMap.delete(selectedId.value)
      await agentsStore.fetchList()
      await selectAgent(selectedId.value)
    }
  }
}

async function deleteAgent() {
  if (!selectedId.value) return
  if (!confirm('确定要删除这个心智吗？')) return
  const json = await api.delete(`/agents/${selectedId.value}`)
  if (json.code === 0) {
    agentsStore.detailMap.delete(selectedId.value)
    await agentsStore.fetchList()
    if (agentsStore.list.length) {
      selectAgent(agentsStore.list[0].id)
    } else {
      createNew()
    }
  }
}

function triggerPortraitUpload() {
  portraitInput.value?.click()
}
function triggerModelUpload() {
  modelInput.value?.click()
}

async function uploadPortrait(e: Event) {
  const file = (e.target as HTMLInputElement).files?.[0]
  if (!file) return

  let targetId = selectedId.value
  if (isCreate.value) {
    const json = await api.post('/agents', { ...form.value })
    if (json.code !== 0) return
    targetId = json.data.id
    isCreate.value = false
    selectedId.value = targetId
    await agentsStore.fetchList()
  }
  if (!targetId) return

  const fd = new FormData()
  fd.append('file', file)
  const json = await api.upload(`/agents/${targetId}/portrait`, fd)
  if (json.code === 0) {
    form.value.portrait_url = json.data.portrait_url
    agentsStore.detailMap.delete(targetId)
    await agentsStore.fetchList()
  }
  ;(e.target as HTMLInputElement).value = ''
}

async function uploadModel(e: Event) {
  const file = (e.target as HTMLInputElement).files?.[0]
  if (!file) return

  let targetId = selectedId.value
  if (isCreate.value) {
    const json = await api.post('/agents', { ...form.value })
    if (json.code !== 0) return
    targetId = json.data.id
    isCreate.value = false
    selectedId.value = targetId
    await agentsStore.fetchList()
  }
  if (!targetId) return

  const fd = new FormData()
  fd.append('file', file)
  const json = await api.upload(`/agents/${targetId}/model`, fd)
  if (json.code === 0) {
    form.value.model_url = json.data.model_url
    agentsStore.detailMap.delete(targetId)
    await agentsStore.fetchList()
  }
  ;(e.target as HTMLInputElement).value = ''
}

function triggerLive2dUpload() {
  live2dInput.value?.click()
}

async function uploadLive2d(e: Event) {
  const file = (e.target as HTMLInputElement).files?.[0]
  if (!file) return

  let targetId = selectedId.value
  if (isCreate.value) {
    const json = await api.post('/agents', { ...form.value })
    if (json.code !== 0) return
    targetId = json.data.id
    isCreate.value = false
    selectedId.value = targetId
    await agentsStore.fetchList()
  }
  if (!targetId) return

  const fd = new FormData()
  fd.append('file', file)
  const json = await api.upload(`/agents/${targetId}/live2d`, fd)
  if (json.code === 0) {
    form.value.live2d_model_url = json.data.live2d_model_url
    agentsStore.detailMap.delete(targetId)
    await agentsStore.fetchList()
  }
  ;(e.target as HTMLInputElement).value = ''
}
</script>

<style scoped>
/* ========== Layout ========== */
.agent-edit {
  position: fixed;
  inset: 0;
  background: #0b0f17;
  z-index: 900;
  display: flex;
  color: #d8e1ec;
  font-family: system-ui, -apple-system, sans-serif;
}

/* ========== Left Sidebar ========== */
.ae-sidebar {
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
  justify-content: space-between;
  padding: 0 16px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.06);
}
.sidebar-header h3 {
  margin: 0;
  font-size: 14px;
  font-weight: 600;
}
.sidebar-add {
  padding: 4px 10px;
  background: rgba(0, 229, 201, 0.12);
  border: 1px solid rgba(0, 229, 201, 0.25);
  border-radius: 6px;
  color: #00e5c9;
  font-size: 12px;
  cursor: pointer;
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
  display: flex;
  align-items: center;
  gap: 6px;
}
.status-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  display: inline-block;
}
.status-dot.idle { background: #5a6a7a; }
.status-dot.busy { background: #ffb800; }
.status-dot.introspecting { background: #00e5c9; }
.agent-code {
  font-size: 11px;
  color: #5a6a7a;
}
.header-left {
  display: flex;
  align-items: center;
  gap: 8px;
}
.sidebar-empty {
  padding: 20px;
  text-align: center;
  color: #5a6a7a;
  font-size: 13px;
}

/* ========== Center: 3D Stage ========== */
.ae-center {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-width: 0;
  position: relative;
}
.stage {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  position: relative;
  padding: 20px;
}
.display-modes {
  position: absolute;
  top: 12px;
  left: 50%;
  transform: translateX(-50%);
  display: flex;
  gap: 4px;
  background: rgba(11, 15, 23, 0.8);
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: 8px;
  padding: 4px;
  z-index: 20;
}
.mode-btn {
  padding: 5px 14px;
  background: transparent;
  border: none;
  border-radius: 6px;
  color: #5a6a7a;
  font-size: 12px;
  cursor: pointer;
  transition: all 0.15s;
}
.mode-btn:hover {
  color: #8899aa;
}
.mode-btn.active {
  background: rgba(0, 229, 201, 0.1);
  color: #00e5c9;
}
.viewer-wrap {
  width: 100%;
  height: 100%;
  max-width: 560px;
  max-height: 560px;
}

/* Center info bar */
.center-info {
  padding: 20px;
  text-align: center;
  border-top: 1px solid rgba(255, 255, 255, 0.04);
}
.info-name {
  font-size: 20px;
  font-weight: 500;
  margin-bottom: 4px;
}
.info-code {
  font-size: 13px;
  color: #5a6a7a;
  margin-bottom: 8px;
}
.info-bar {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
}
.info-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
}
.info-status {
  font-size: 11px;
  color: #5a6a7a;
}

/* ========== Right: Tabs + Panel ========== */
.ae-right {
  display: flex;
  border-left: 1px solid rgba(255, 255, 255, 0.06);
  position: relative;
}
.right-tabs {
  width: 64px;
  display: flex;
  flex-direction: column;
  padding: 12px 8px;
  gap: 8px;
  background: rgba(11, 15, 23, 0.6);
}
.tab-btn {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
  padding: 10px 4px;
  background: transparent;
  border: 1px solid transparent;
  border-radius: 8px;
  color: #5a6a7a;
  cursor: pointer;
  transition: all 0.15s;
}
.tab-btn:hover {
  background: rgba(255, 255, 255, 0.04);
  color: #8899aa;
}
.tab-btn.active {
  background: rgba(0, 229, 201, 0.08);
  border-color: rgba(0, 229, 201, 0.2);
  color: #00e5c9;
}
.tab-icon {
  font-size: 16px;
}
.tab-label {
  font-size: 10px;
}

/* Settings panel */
.settings-panel {
  width: 280px;
  background: rgba(11, 15, 23, 0.95);
  border-left: 1px solid rgba(255, 255, 255, 0.06);
  display: flex;
  flex-direction: column;
}
.panel-header {
  height: 48px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 16px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.06);
  font-size: 14px;
  font-weight: 500;
}
.panel-close {
  width: 28px;
  height: 28px;
  border-radius: 6px;
  background: transparent;
  border: none;
  color: #5a6a7a;
  font-size: 18px;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
}
.panel-close:hover {
  background: rgba(255, 255, 255, 0.06);
  color: #d8e1ec;
}
.panel-scroll {
  flex: 1;
  overflow-y: auto;
  padding: 16px;
}
.panel-section {
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.panel-section label {
  font-size: 12px;
  color: #8899aa;
}
.panel-section input,
.panel-section textarea,
.panel-section select {
  width: 100%;
  padding: 10px;
  background: #141b24;
  border: 1px solid #1e2731;
  border-radius: 8px;
  color: #d8e1ec;
  font-size: 13px;
  box-sizing: border-box;
}
.panel-section input:focus,
.panel-section textarea:focus,
.panel-section select:focus {
  outline: none;
  border-color: rgba(0, 229, 201, 0.4);
}
.hint-text { font-size: 11px; color: #5A6A7A; margin-top: 4px; }
.model-select-row {
  display: flex;
  align-items: center;
  gap: 8px;
}
.model-select-row select {
  flex: 1;
}
.capability-icons {
  display: flex;
  gap: 4px;
  font-size: 14px;
}
.checkbox-label {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
  color: #d8e1ec;
  cursor: pointer;
}
.checkbox-label input[type='checkbox'] {
  width: auto;
}
.sub-config {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding-left: 16px;
  border-left: 2px solid rgba(0, 229, 201, 0.15);
}
.panel-section input[type='color'] {
  width: 48px;
  height: 36px;
  padding: 2px;
  cursor: pointer;
}
.color-row {
  display: flex;
  align-items: center;
  gap: 10px;
}
.color-value {
  font-size: 12px;
  color: #5a6a7a;
  font-family: monospace;
}

/* Tags */
.tag-list {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  align-items: center;
}
.tag {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 4px 10px;
  background: rgba(0, 229, 201, 0.1);
  color: #00e5c9;
  border-radius: 12px;
  font-size: 12px;
}
.tag button {
  background: transparent;
  border: none;
  color: #00e5c9;
  cursor: pointer;
  font-size: 12px;
  padding: 0;
  width: 14px;
}

/* Portrait */
.portrait-row {
  display: flex;
  align-items: center;
  gap: 12px;
}
.portrait-preview {
  width: 60px;
  height: 60px;
  border-radius: 8px;
  object-fit: cover;
}
.portrait-placeholder {
  width: 60px;
  height: 60px;
  border-radius: 8px;
  background: #141b24;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 12px;
  color: #3a4a5a;
}
.upload-btn {
  padding: 6px 12px;
  background: rgba(255, 255, 255, 0.06);
  border: 1px solid rgba(255, 255, 255, 0.1);
  border-radius: 6px;
  color: #8899aa;
  font-size: 12px;
  cursor: pointer;
}
.upload-btn:hover {
  border-color: rgba(0, 229, 201, 0.3);
  color: #00e5c9;
}
.upload-btn.wide {
  width: 100%;
  padding: 10px;
}
.sep {
  height: 1px;
  background: rgba(255, 255, 255, 0.06);
  margin: 4px 0;
}
.model-info {
  display: flex;
  align-items: center;
  gap: 10px;
}
.model-filename {
  flex: 1;
  font-size: 12px;
  color: #8899aa;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* Panel actions */
.panel-actions {
  margin-top: 20px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.save-btn {
  width: 100%;
  padding: 10px;
  background: #00e5c9;
  color: #0b0f17;
  border: none;
  border-radius: 8px;
  font-weight: 600;
  font-size: 13px;
  cursor: pointer;
}
.danger-btn {
  width: 100%;
  padding: 10px;
  background: transparent;
  border: 1px solid rgba(239, 68, 68, 0.3);
  color: #ef4444;
  border-radius: 8px;
  font-size: 13px;
  cursor: pointer;
}
.danger-btn:hover {
  background: rgba(239, 68, 68, 0.1);
}

/* Slide animation */
.panel-slide-enter-active,
.panel-slide-leave-active {
  transition: all 0.25s ease;
}
.panel-slide-enter-from,
.panel-slide-leave-to {
  opacity: 0;
  transform: translateX(20px);
}
</style>
