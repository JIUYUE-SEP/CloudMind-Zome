<template>
  <div class="agent-edit">
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

    <main class="ae-center">
      <div class="stage">
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
        <div class="viewer-wrap">
          <PortraitViewer v-if="displayMode === 'portrait'" :url="agent.portrait_url" />
          <Live2DViewer v-else-if="displayMode === 'live2d'" :model-url="agent.live2d_model_url" />
          <VRMViewer v-else-if="displayMode === 'vrm'" :model-url="agent.model_url" />
        </div>
      </div>
      <div class="center-info">
        <div class="info-name">{{ agent.name || '未命名心智' }}</div>
        <div class="info-code">{{ agent.codename || '---' }}</div>
        <div class="info-bar">
          <span class="info-dot" :style="{ background: agent.represent_color }"></span>
          <span class="info-status">{{ isCreate ? '新建' : statusLabel(liveStatus) }}</span>
        </div>
      </div>
    </main>

    <aside class="ae-right">
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

      <Transition name="panel-slide">
        <div v-if="activeTab" class="settings-panel">
          <div class="panel-header">
            <span>{{ currentTab?.label }}</span>
            <button class="panel-close" @click="activeTab = null">×</button>
          </div>

          <div class="panel-scroll">
            <Component
              :is="currentComponent"
              v-if="currentComponent"
              :agent="agent"
              :loading="saving"
              @update:agent="onUpdate"
              @save="onChildSave"
              @reset="onChildReset"
            />

            <div class="panel-actions">
              <button v-if="!isCreate" class="danger-btn" @click="deleteAgent">删除心智</button>
              <button class="save-btn" :disabled="saving" @click="() => save()">
                {{ saving ? '保存中...' : '保存' }}
              </button>
            </div>
          </div>
        </div>
      </Transition>
    </aside>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, onBeforeUnmount, shallowRef, defineAsyncComponent } from 'vue'
import { useRoute } from 'vue-router'
import { useAgentsStore } from '@/stores/agents'
import { useComputeStore } from '@/stores/compute'
import { api } from '@/api/client'
import BackButton from '@/components/BackButton.vue'

const PortraitViewer = defineAsyncComponent(() => import('./viewer/PortraitViewer.vue'))
const Live2DViewer = defineAsyncComponent(() => import('./viewer/Live2DViewer.vue'))
const VRMViewer = defineAsyncComponent(() => import('./viewer/VRMViewer.vue'))
import AgentEditBasic from './agent-edit/AgentEditBasic.vue'
import AgentEditPersona from './agent-edit/AgentEditPersona.vue'
import AgentEditSkills from './agent-edit/AgentEditSkills.vue'
import AgentEditSecurity from './agent-edit/AgentEditSecurity.vue'
import AgentEditTools from './agent-edit/AgentEditTools.vue'
import AgentEditModel from './agent-edit/AgentEditModel.vue'
import AgentEditAppearance from './agent-edit/AgentEditAppearance.vue'
import AgentEditMemory from './agent-edit/AgentEditMemory.vue'

const route = useRoute()
const agentsStore = useAgentsStore()
const computeStore = useComputeStore()

const selectedId = ref<string | null>(null)
const isCreate = ref(false)
const activeTab = ref<string | null>(null)
const displayMode = ref<'portrait' | 'live2d' | 'vrm'>('portrait')
const liveStatus = ref<string>('idle')
const saving = ref(false)

const displayModes = [
  { key: 'portrait' as const, label: '立绘' },
  { key: 'live2d' as const, label: 'Live2D' },
  { key: 'vrm' as const, label: '3D' },
]

const tabs = [
  { key: 'profile', label: '心智档案', icon: '◈', comp: AgentEditBasic },
  { key: 'persona', label: '心智侧写', icon: '◉', comp: AgentEditPersona },
  { key: 'skills', label: '能力标签', icon: '✦', comp: AgentEditSkills },
  { key: 'security', label: '文件权限', icon: '◉', comp: AgentEditSecurity },
  { key: 'tools', label: '工具集', icon: '⚙', comp: AgentEditTools },
  { key: 'compute', label: '算力配置', icon: '⚡', comp: AgentEditModel },
  { key: 'appearance', label: '外观立绘', icon: '◐', comp: AgentEditAppearance },
  { key: 'mind', label: '心智文件', icon: '◆', comp: AgentEditMemory },
]

const currentTab = computed(() => tabs.find((t) => t.key === activeTab.value))
const currentComponent = computed(() => currentTab.value?.comp)

const agent = ref<any>(buildEmptyAgent())

function buildEmptyAgent() {
  const firstLlmProv = computeStore.providers.find((p: any) =>
    p.models?.some((m: any) => m.model_type === 'llm')
  )
  const firstLlmModel = firstLlmProv?.models?.find((m: any) => m.model_type === 'llm')?.id || null
  const firstEmbedProv = computeStore.providers.find((p: any) =>
    p.models?.some((m: any) => m.model_type === 'embedding')
  )
  const firstEmbedModel = firstEmbedProv?.models?.find((m: any) => m.model_type === 'embedding')?.id || null
  const firstImageProv = computeStore.providers.find((p: any) =>
    p.models?.some((m: any) => m.model_type === 'image')
  )
  const firstImageModel = firstImageProv?.models?.find((m: any) => m.model_type === 'image')?.id || null

  return {
    id: null,
    name: '',
    codename: '',
    represent_color: '#00E5C9',
    description: '',
    capabilities: [],
    aliases: [],
    tags: [],
    allowed_paths: [],
    toolsets: [],
    enabled_skills: [],
    provider_id: firstLlmProv?.id || null,
    model_id: firstLlmModel,
    temperature: null,
    top_p: null,
    marker_provider_id: null,
    marker_model_id: null,
    embedder_provider_id: firstEmbedProv?.id || null,
    embedder_model_id: firstEmbedModel,
    compressor_provider_id: null,
    compressor_model_id: null,
    imagegen_provider_id: firstImageProv?.id || null,
    imagegen_model_id: firstImageModel,
    fallbackChain: [],
    useIndependentMarker: false,
    useIndependentCompressor: false,
    portrait_url: '',
    model_url: '',
    live2d_model_url: '',
  }
}

onMounted(async () => {
  await Promise.all([agentsStore.fetchList(), computeStore.fetchProviders()])
  const routeId = route.params.id as string | undefined
  if (routeId) {
    await selectAgent(routeId)
  } else if (agentsStore.list.length) {
    await selectAgent(agentsStore.list[0].id)
  } else {
    createNew()
  }
  window.addEventListener('ws:agent.status', onAgentStatus as any)
})

onBeforeUnmount(() => {
  window.removeEventListener('ws:agent.status', onAgentStatus as any)
})

function onAgentStatus(e: any) {
  const p = e.detail
  if (!p?.agent_id) return
  const idx = agentsStore.list.findIndex((x) => x.id === p.agent_id)
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
  agent.value = buildEmptyAgent()
}

function statusLabel(status: string) {
  const map: Record<string, string> = { idle: '空闲', busy: '思考中', introspecting: '内省中' }
  return map[status] || status
}

async function selectAgent(id: string) {
  isCreate.value = false
  selectedId.value = id
  activeTab.value = activeTab.value || null

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
  const fbChain = Array.isArray(data.fallback_chain)
    ? data.fallback_chain.map((item: any) => ({
        provider_id: item.provider_id || '',
        model_id: item.model_id || item.model || '',
        display_name: item.display_name || '',
      }))
    : Array.isArray(llmCfg.fallback_chain)
      ? llmCfg.fallback_chain.map((item: any) => ({
          provider_id: item.provider_id || '',
          model_id: item.model_id || item.model || '',
          display_name: item.display_name || '',
        }))
      : []

  agent.value = {
    id: data.id,
    name: data.name || '',
    codename: data.codename || '',
    represent_color: data.represent_color || '#00E5C9',
    description: data.description || '',
    capabilities: Array.isArray(data.capabilities) ? [...data.capabilities] : [],
    aliases: Array.isArray(data.aliases) ? [...data.aliases] : [],
    tags: Array.isArray(data.tags) ? [...data.tags] : [],
    allowed_paths: Array.isArray(data.allowed_paths) ? [...data.allowed_paths] : [],
    toolsets: Array.isArray(data.toolsets) ? [...data.toolsets] : [],
    enabled_skills: Array.isArray(data.enabled_skills) ? [...data.enabled_skills] : [],
    provider_id: data.provider_id || llmCfg.provider_id || null,
    model_id: data.model_id || llmCfg.model || null,
    temperature: data.temperature ?? null,
    top_p: data.top_p ?? null,
    marker_provider_id: data.marker_provider_id || llmCfg.marker?.provider_id || null,
    marker_model_id: data.marker_model_id || llmCfg.marker?.model || null,
    embedder_provider_id: data.embedder_provider_id || llmCfg.embedder?.provider_id || null,
    embedder_model_id: data.embedder_model_id || llmCfg.embedder?.model || null,
    compressor_provider_id: data.compressor_provider_id || llmCfg.compressor?.provider_id || null,
    compressor_model_id: data.compressor_model_id || llmCfg.compressor?.model || null,
    imagegen_provider_id: data.imagegen_provider_id || null,
    imagegen_model_id: data.imagegen_model_id || null,
    fallbackChain: fbChain,
    useIndependentMarker: !!(data.marker_provider_id || llmCfg.marker?.provider_id),
    useIndependentCompressor: !!(data.compressor_provider_id || llmCfg.compressor?.provider_id),
    portrait_url: data.portrait_url || '',
    model_url: data.model_url || '',
    live2d_model_url: data.live2d_model_url || '',
  }
}

function toggleTab(key: string) {
  activeTab.value = activeTab.value === key ? null : key
}

function onUpdate(data: Partial<any>) {
  agent.value = { ...agent.value, ...data }
}

function onChildSave(field: string) {
  save(field)
}

function onChildReset(field: string) {
  console.log('[AgentEdit] reset', field)
}

async function save(field?: string) {
  const a = agent.value
  const body: any = {
    name: a.name,
    codename: a.codename,
    represent_color: a.represent_color,
    description: a.description,
    capabilities: a.capabilities,
    aliases: a.aliases,
    tags: a.tags,
    allowed_paths: a.allowed_paths,
    toolsets: a.toolsets,
    enabled_skills: a.enabled_skills,
    portrait_url: a.portrait_url,
    model_url: a.model_url,
    live2d_model_url: a.live2d_model_url,
    provider_id: a.provider_id,
    model_id: a.model_id,
    temperature: a.temperature,
    top_p: a.top_p,
  }

  if (!a.provider_id || !a.model_id) {
    alert('请先选择主模型的 Provider 和模型')
    return
  }
  if (!a.embedder_provider_id || !a.embedder_model_id) {
    alert('嵌入模型（语义搜索）为必填项')
    return
  }
  if (!computeStore.providers.length) {
    alert('暂无可用 Provider，请先前往「算力中枢」添加 API 密钥')
    return
  }

  if (a.useIndependentMarker) {
    body.marker_provider_id = a.marker_provider_id
    body.marker_model_id = a.marker_model_id
  }
  body.embedder_provider_id = a.embedder_provider_id
  body.embedder_model_id = a.embedder_model_id
  if (a.useIndependentCompressor) {
    body.compressor_provider_id = a.compressor_provider_id
    body.compressor_model_id = a.compressor_model_id
  }
  body.imagegen_provider_id = a.imagegen_provider_id
  body.imagegen_model_id = a.imagegen_model_id
  body.fallback_chain = a.fallbackChain?.length
    ? a.fallbackChain.map((item: any) => ({
        provider_id: item.provider_id,
        model_id: item.model_id,
        display_name: item.display_name || '',
      }))
    : []

  const llm: any = {
    provider_id: a.provider_id,
    model: a.model_id,
  }
  if (a.useIndependentMarker) {
    llm.marker = { provider_id: a.marker_provider_id || '', model: a.marker_model_id || '' }
  }
  llm.embedder = { provider_id: a.embedder_provider_id || '', model: a.embedder_model_id || '' }
  if (a.useIndependentCompressor) {
    llm.compressor = { provider_id: a.compressor_provider_id || '', model: a.compressor_model_id || '' }
  }
  if (body.fallback_chain?.length) {
    llm.fallback_chain = body.fallback_chain
  }
  body.llm_config = llm

  saving.value = true
  try {
    if (isCreate.value) {
      const json = await api.post('/agents', body)
      if (json.code === 0) {
        await agentsStore.fetchList()
        const newId = json.data.id
        if (newId) await selectAgent(newId)
      }
    } else if (selectedId.value) {
      const json = await api.put(`/agents/${selectedId.value}`, body)
      if (json.code === 0) {
        agentsStore.detailMap.delete(selectedId.value)
        await agentsStore.fetchList()
        await selectAgent(selectedId.value)
      }
    }
  } finally {
    saving.value = false
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
      await selectAgent(agentsStore.list[0].id)
    } else {
      createNew()
    }
  }
}
</script>

<style scoped>
@import '@/styles/agent-edit.css';

.agent-edit {
  position: fixed;
  inset: 0;
  background: #0b0f17;
  color: #d8e1ec;
  z-index: 900;
  display: flex;
  font-family: system-ui, -apple-system, sans-serif;
}

.ae-sidebar {
  width: 220px;
  flex-shrink: 0;
  border-right: 1px solid var(--ae-border);
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
  border-bottom: 1px solid var(--ae-border);
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
  color: var(--ae-primary);
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
  color: var(--ae-bg);
}

.agent-meta {
  min-width: 0;
}

.agent-name {
  font-size: 13px;
  color: var(--ae-text);
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
  color: var(--ae-text-dim);
}

.header-left {
  display: flex;
  align-items: center;
  gap: 8px;
}

.sidebar-empty {
  padding: 20px;
  text-align: center;
  color: var(--ae-text-dim);
  font-size: 13px;
}

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
  color: var(--ae-text-dim);
  font-size: 12px;
  cursor: pointer;
  transition: all 0.15s;
}

.mode-btn:hover { color: var(--ae-text-muted); }
.mode-btn.active {
  background: rgba(0, 229, 201, 0.1);
  color: var(--ae-primary);
}

.viewer-wrap {
  width: 100%;
  height: 100%;
  max-width: 560px;
  max-height: 560px;
}

.center-info {
  padding: 20px;
  text-align: center;
  border-top: 1px solid var(--ae-border);
}

.info-name { font-size: 20px; font-weight: 500; margin-bottom: 4px; }
.info-code { font-size: 13px; color: var(--ae-text-dim); margin-bottom: 8px; }

.info-bar {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
}

.info-dot { width: 8px; height: 8px; border-radius: 50%; }
.info-status { font-size: 11px; color: var(--ae-text-dim); }

.ae-right {
  display: flex;
  border-left: 1px solid var(--ae-border);
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
  color: var(--ae-text-dim);
  cursor: pointer;
  transition: all 0.15s;
}

.tab-btn:hover { background: rgba(255, 255, 255, 0.04); color: var(--ae-text-muted); }
.tab-btn.active {
  background: rgba(0, 229, 201, 0.08);
  border-color: rgba(0, 229, 201, 0.2);
  color: var(--ae-primary);
}

.tab-icon { font-size: 16px; }
.tab-label { font-size: 10px; }

.settings-panel {
  width: 25vw;
  min-width: 320px;
  max-width: 480px;
  background: var(--ae-panel);
  border-left: 1px solid var(--ae-border);
  display: flex;
  flex-direction: column;
}

.panel-header {
  height: 48px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 16px;
  border-bottom: 1px solid var(--ae-border);
  font-size: 14px;
  font-weight: 500;
}

.panel-close {
  width: 28px;
  height: 28px;
  border-radius: 6px;
  background: transparent;
  border: none;
  color: var(--ae-text-dim);
  font-size: 18px;
  cursor: pointer;
}

.panel-close:hover { background: rgba(255, 255, 255, 0.06); color: var(--ae-text); }

.panel-scroll {
  flex: 1;
  overflow-y: auto;
  padding: 16px;
}

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

.save-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
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
