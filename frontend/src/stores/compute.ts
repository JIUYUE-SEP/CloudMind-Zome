import { defineStore } from 'pinia'
import { ref } from 'vue'
import { api } from '@/api/client'

export interface Provider {
  id: string
  provider_type: string
  display_name: string
  base_url: string
  models: string[]
  config: any
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

  async function fetchProviders() {
    isLoading.value = true
    const json = await api.get('/compute/providers')
    if (json.code === 0) providers.value = json.data.items
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

  return { providers, usage, isLoading, fetchProviders, addProvider, updateProvider, testConnection, deleteProvider, fetchUsage }
})
