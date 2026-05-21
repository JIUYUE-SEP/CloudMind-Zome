import { createApp } from 'vue'
import { createPinia } from 'pinia'
import router from './router'
import App from './App.vue'
import { useAuthStore } from './stores/auth'

const app = createApp(App)
app.use(createPinia())

// 全局加载用户信息（所有页面共用）
const auth = useAuthStore()
auth.fetchMe()

app.use(router)
app.mount('#app')
