import { defineStore } from 'pinia'
import { ref } from 'vue'
import { api } from '@/api/client'

export interface ModelInfo {
  id: string
  display_name: string
  model_type: 'llm' | 'embedding' | 'image' | 'stt'
  context_window: number | null
  max_output_tokens: number | null
  supports_multimodal: boolean
  supports_streaming: boolean
  supports_tool_calling: boolean
  supports_reasoning: boolean
  status: string
}

export interface Provider {
  id: string
  provider_type: string
  display_name: string
  base_url: string
  models: ModelInfo[]
  has_api_key: boolean
  auth_mode: string
  request_timeout: number
  max_retries: number
  rate_limit_qpm: number
  require_api_key: boolean
  is_builtin?: boolean
  description: string | null
  quota_total: number
  quota_used: number
  quota_remaining: number
  expires_at: string | null
  status: string
}

export const useComputeStore = defineStore('compute', () => {
  const providers = ref<Provider[]>([])
  const usage = ref<{ dates: string[]; tokens: number[] }>({ dates: [], tokens: [] })
  const isLoading = ref(false)
  const modelCacheTs = ref(0)

  function getModelsByProvider(providerId: string): ModelInfo[] {
    const p = providers.value.find((x) => x.id === providerId)
    return p?.models || []
  }

  function getModelInfo(providerId: string, modelId: string): ModelInfo | undefined {
    const models = getModelsByProvider(providerId)
    return models.find((m) => m.id === modelId)
  }

  function getProviderById(id: string): Provider | undefined {
    return providers.value.find((p) => p.id === id)
  }

  async function fetchProviders(force = false) {
    if (!force && Date.now() - modelCacheTs.value < 30000 && providers.value.length > 0) {
      return // Cache for 30s
    }
    isLoading.value = true
    const json = await api.get('/compute/providers')
    if (json.code === 0) {
      providers.value = json.data.items
      modelCacheTs.value = Date.now()
    }
    isLoading.value = false
  }

  async function addProvider(body: any) {
    const json = await api.post('/compute/providers', body)
    await fetchProviders()
    return json
  }

  async function updateProvider(id: string, body: any) {
    const json = await api.put(`/compute/providers/${id}`, body)
    await fetchProviders()
    return json
  }

  async function testConnection(id: string) {
    return api.post(`/compute/providers/${id}/test`)
  }

  async function deleteProvider(id: string) {
    await api.delete(`/compute/providers/${id}`)
    await fetchProviders()
  }

  async function fetchUsage(days = 7) {
    const json = await api.get(`/compute/usage?days=${days}`)
    if (json.code === 0) usage.value = json.data
  }

  async function addModel(body: any) {
    const json = await api.post('/models', body)
    await fetchProviders(true)
    return json
  }

  function groupByModelType(providers: Provider[]) {
    const types = [
      { type: 'llm' as const, label: '对话模型', icon: '🧠' },
      { type: 'embedding' as const, label: 'Embedding 模型', icon: '🧬' },
      { type: 'image' as const, label: '图片生成模型', icon: '🎨' },
      { type: 'stt' as const, label: '语音识别模型', icon: '🎙️' },
    ]
    return types.map(t => {
      const filtered = providers
        .map(p => ({
          ...p,
          models: (p.models || []).filter(m => m.model_type === t.type)
        }))
        .filter(p => p.models.length > 0)
      return { ...t, providers: filtered }
    })
  }

  async function updateModel(providerId: string, modelId: string, body: any) {
    const json = await api.put(`/models/${providerId}/${modelId}`, body)
    await fetchProviders(true)
    return json
  }

  async function deleteModel(providerId: string, modelId: string) {
    const json = await api.delete(`/models/${providerId}/${modelId}`)
    await fetchProviders(true)
    return json
  }

  return { providers, usage, isLoading, modelCacheTs, getModelsByProvider, getModelInfo, getProviderById, fetchProviders, addProvider, updateProvider, testConnection, deleteProvider, fetchUsage, addModel, groupByModelType, updateModel, deleteModel }
})
