import { defineStore } from 'pinia'
import { ref, computed } from 'vue'

// Single-user local app — no auth needed.
// Keep a minimal user object so UI components that reference auth.user still work.
const DEFAULT_USER = {
  user_id: 'user',
  codename: 'user',
  nickname: '用户',
  role: 'user' as const,
  level: 1,
  exp: 0,
  avatar_url: '',
}

export const useAuthStore = defineStore('auth', () => {
  const user = ref(DEFAULT_USER)
  const isLoading = ref(false)

  const isAuthenticated = computed(() => true)
  const isGuest = computed(() => false)

  async function fetchMe() {
    // No-op: user is always present in single-user mode
    user.value = { ...DEFAULT_USER }
  }

  async function updateProfile(body: { nickname?: string; avatar_url?: string }) {
    if (body.nickname) user.value.nickname = body.nickname
    if (body.avatar_url) user.value.avatar_url = body.avatar_url
    return { code: 0, data: user.value, message: '' }
  }

  function logout() {
    // No-op: no login/logout in single-user mode
  }

  return { user, isLoading, isAuthenticated, isGuest, fetchMe, updateProfile, logout }
})
