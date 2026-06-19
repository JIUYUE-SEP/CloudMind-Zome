<template>
  <div class="app-shell">
    <div class="main-visual">
      <RouterView />
    </div>

    <nav class="right-nav">
      <RouterLink
        v-for="item in navItems"
        :key="item.label"
        :to="item.to"
        class="nav-item"
        @click="handleNav($event, item)"
      >
        <span class="nav-label">{{ item.label }}</span>
        <span v-if="item.label === '通讯中枢' && chat.totalUnread > 0" class="nav-badge" />
      </RouterLink>
    </nav>

    <footer class="bottom-bar">
      <div class="bar-left">
        <button class="bar-avatar" @click="showProfileModal = true" title="个人信息">
          <img v-if="auth.user?.avatar_url" :src="$uploadUrl(auth.user.avatar_url)" />
          <span v-else>我</span>
        </button>
        <button class="bar-btn" @click="goProfile">心智侧写</button>
        <button class="bar-btn" @click="goUserProfile">用户档案</button>
        <button class="bar-btn" @click="goCompute">算力余量</button>
      </div>
    </footer>

    <UserProfileModal v-if="showProfileModal" @close="showProfileModal = false" />
  </div>
</template>

<script setup lang="ts">
import { ref } from 'vue'
import { useRouter } from 'vue-router'
import { useAuthStore } from '@/stores/auth'
import { useChatStore } from '@/stores/chat'
import UserProfileModal from '@/components/UserProfileModal.vue'

const router = useRouter()
const auth = useAuthStore()
const chat = useChatStore()
const showProfileModal = ref(false)

const navItems = [
  { label: '行动中心', to: '/actions' },
  { label: '心智整备', to: '/agents/new' },
  { label: '自动委托', to: '/commissions' },
  { label: '心智招募', to: '/agents/new' },
  { label: '通讯中枢', to: '/communications' },
  { label: '广播站', to: '', placeholder: true },
]

function handleNav(e: Event, item: typeof navItems[0]) {
  if (item.placeholder) {
    e.preventDefault()
  }
}

function goProfile() { router.push('/self-image') }
function goUserProfile() { router.push('/user-profile') }
function goCompute() { router.push('/compute') }
</script>

<style scoped>
.app-shell { position: fixed; inset: 0; background: #0B0F17; color: #D8E1EC; font-family: system-ui, -apple-system, sans-serif; overflow: hidden; }
.main-visual { position: absolute; inset: 0; z-index: 0; }
.right-nav { position: absolute; right: 0; top: 120px; bottom: 120px; width: 180px; display: flex; flex-direction: column; justify-content: center; gap: 8px; padding: 16px; z-index: 100; background: linear-gradient(to left, rgba(11,15,23,0.9), transparent); }
.nav-item { display: flex; align-items: center; gap: 10px; padding: 10px 12px; border-radius: 8px; cursor: pointer; background: transparent; border: none; color: #D8E1EC; text-decoration: none; transition: background 0.2s; }
.nav-item:hover { background: rgba(0,229,201,0.08); }
.nav-icon { font-size: 18px; }
.nav-label { font-size: 13px; }
.nav-badge {
  width: 6px; height: 6px;
  background: #EF4444;
  border-radius: 50%;
  margin-left: 4px;
}
.bottom-bar { position: absolute; bottom: 0; left: 0; right: 0; height: 56px; display: flex; align-items: center; justify-content: space-between; padding: 0 20px; background: rgba(11,15,23,0.25); backdrop-filter: blur(12px); border-top: 1px solid rgba(255,255,255,0.06); z-index: 100; }
.bar-left { display: flex; align-items: center; gap: 12px; }
.bar-btn { background: transparent; border: none; color: #8899AA; font-size: 13px; cursor: pointer; padding: 6px 12px; }
.bar-btn:hover { color: #00E5C9; }
.bar-avatar { width: 28px; height: 28px; border-radius: 50%; background: rgba(20,27,36,0.7); border: 1px solid rgba(255,255,255,0.1); color: #8899AA; font-size: 11px; cursor: pointer; display: flex; align-items: center; justify-content: center; overflow: hidden; padding: 0; flex-shrink: 0; }
.bar-avatar:hover { border-color: rgba(0,229,201,0.3); }
.bar-avatar img { width: 100%; height: 100%; object-fit: cover; }
</style>
