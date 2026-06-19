import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import { api } from '@/api/client'

const TOKEN_KEY = 'cloudmind-token'

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
  const token = ref<string | null>(localStorage.getItem(TOKEN_KEY))

  const isAuthenticated = computed(() => token.value !== null && user.value !== null)
  const isGuest = computed(() => user.value?.role === 'guest')

  async function ensureToken() {
    if (token.value) return token.value
    const json = await api.get('/auth/guest-token')
    if (json.code === 0 && json.data?.token) {
      token.value = json.data.token
      localStorage.setItem(TOKEN_KEY, json.data.token)
    }
    return token.value
  }

  async function fetchMe() {
    await ensureToken()
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

  function logout() {
    token.value = null
    user.value = null
    localStorage.removeItem(TOKEN_KEY)
  }

  return { user, isLoading, token, isAuthenticated, isGuest, ensureToken, fetchMe, updateProfile, logout }
})
