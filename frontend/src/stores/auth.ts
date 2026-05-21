import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import { api } from '@/api/client'

interface Profile {
  bio: string
  quote: string
  tags: string[]
  radar: Record<string, number>
}

interface User {
  user_id: string
  codename: string
  nickname: string
  role: 'guest' | 'user' | 'admin'
  level: number
  exp: number
  avatar_url: string
  profile: Profile
}

const USER_CACHE_KEY = 'cm_user_cache'

function loadCachedUser(): User | null {
  try {
    const raw = localStorage.getItem(USER_CACHE_KEY)
    if (raw) return JSON.parse(raw)
  } catch { /* ignore */ }
  return null
}

export const useAuthStore = defineStore('auth', () => {
  const token = ref<string | null>(localStorage.getItem('cm_token'))
  const user = ref<User | null>(loadCachedUser())
  const isLoading = ref(false)

  const isAuthenticated = computed(() => true)
  const isGuest = computed(() => false)

  async function fetchMe() {
    const json = await api.get('/auth/me')
    if (json.code === 0) {
      user.value = json.data
      localStorage.setItem(USER_CACHE_KEY, JSON.stringify(json.data))
    }
  }

  async function updateProfile(body: Partial<User & { bio?: string; quote?: string; tags?: string[]; radar?: Record<string, number> }>) {
    const json = await api.put('/auth/me', body)
    if (json.code === 0) {
      user.value = json.data
      localStorage.setItem(USER_CACHE_KEY, JSON.stringify(json.data))
    }
    return json
  }

  async function login(codename: string, password: string) {
    isLoading.value = true
    const json = await api.post('/auth/login', { codename, password })
    if (json.code === 0) {
      token.value = json.data.token
      localStorage.setItem('cm_token', json.data.token)
      await fetchMe()
    }
    isLoading.value = false
    return json
  }

  async function register(nickname: string, codename: string, password?: string) {
    const json = await api.post('/auth/register', { nickname, codename, password })
    if (json.code === 0) {
      token.value = json.data.token
      localStorage.setItem('cm_token', json.data.token)
      await fetchMe()
    }
    return json
  }

  function logout() {
    token.value = null
    user.value = null
    localStorage.removeItem('cm_token')
    localStorage.removeItem(USER_CACHE_KEY)
  }

  async function init() {
    await fetchMe()
  }

  return { token, user, isLoading, isAuthenticated, isGuest, login, register, logout, fetchMe, updateProfile, init }
})
