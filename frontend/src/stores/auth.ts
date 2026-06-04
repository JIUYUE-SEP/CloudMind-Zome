import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import { api } from '@/api/client'

interface User {
  user_id: string
  codename: string
  nickname: string
  role: 'guest' | 'user' | 'admin'
  level: number
  exp: number
  avatar_url: string
}

export const useAuthStore = defineStore('auth', () => {
  const user = ref<User | null>(null)
  const isLoading = ref(false)

  const isAuthenticated = computed(() => true)
  const isGuest = computed(() => false)

  async function fetchMe() {
    const json = await api.get('/auth/me')
    if (json.code === 0) {
      user.value = json.data
    }
  }

  async function updateProfile(body: { nickname?: string; avatar_url?: string }) {
    const json = await api.put('/auth/me', body)
    if (json.code === 0) {
      user.value = json.data
    }
    return json
  }

  return { user, isLoading, isAuthenticated, isGuest, fetchMe, updateProfile }
})
