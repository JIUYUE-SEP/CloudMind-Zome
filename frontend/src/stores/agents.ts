import { defineStore } from 'pinia'
import { ref } from 'vue'
import { api } from '@/api/client'

export interface AgentItem {
  id: string
  name: string
  codename: string
  status: string
  portrait_url?: string
  live2d_model_url?: string
  model_url?: string
  represent_color: string
  tags?: string[]
  created_at: string
}

export const useAgentsStore = defineStore('agents', () => {
  const list = ref<AgentItem[]>([])
  const detailMap = ref<Map<string, any>>(new Map())
  const isLoading = ref(false)

  async function fetchList() {
    isLoading.value = true
    const json = await api.get('/agents')
    if (json.code === 0) {
      list.value = json.data.items
    }
    isLoading.value = false
  }

  async function fetchAgentDetail(id: string) {
    if (detailMap.value.has(id)) return detailMap.value.get(id)
    const json = await api.get(`/agents/${id}`)
    if (json.code === 0) {
      detailMap.value.set(id, json.data)
    }
    return json.data
  }

  return { list, detailMap, isLoading, fetchList, fetchAgentDetail }
})
