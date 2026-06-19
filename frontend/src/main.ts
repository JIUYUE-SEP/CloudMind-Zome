import { createApp } from 'vue'
import { createPinia } from 'pinia'
import router from './router'
import App from './App.vue'
import '@/styles/global.css'
import { useAuthStore } from './stores/auth'
import { setApiBase, setWsBase, getApiBase } from './api/config'
import { getUploadUrl } from './api/client'

async function waitForBackend(url: string, maxWaitMs = 30000) {
  const start = Date.now()
  while (Date.now() - start < maxWaitMs) {
    try {
      const resp = await fetch(`${url}/api/v1/system/health`, {
        signal: AbortSignal.timeout(2000),
      })
      if (resp.ok) return
    } catch {}
    await new Promise((r) => setTimeout(r, 500))
  }
  throw new Error('backend not ready')
}

async function init() {
  // Tauri desktop build: ask the Rust side for the embedded backend URL.
  if ((window as any).__TAURI_INTERNALS__) {
    try {
      const { invoke } = await import('@tauri-apps/api/core')
      const url = await invoke<string>('backend_url')
      await waitForBackend(url)
      const wsUrl = url.replace(/^http/, 'ws')
      setApiBase(`${url}/api/v1`)
      setWsBase(wsUrl)
      console.log('[Tauri] backend URL:', url)
    } catch (e) {
      console.error('[Tauri] failed to get backend_url:', e)
    }
  }

  if (import.meta.env.DEV) {
    console.log('[DEV] API base:', getApiBase())
  }

  const app = createApp(App)
  app.config.globalProperties.$uploadUrl = getUploadUrl
  app.use(createPinia())

  // 全局加载用户信息（所有页面共用）；必须先获取 guest token 才能调用后续 API/WS。
  const auth = useAuthStore()
  await auth.fetchMe()

  app.use(router)
  app.mount('#app')
}

init()
