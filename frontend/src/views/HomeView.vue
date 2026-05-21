<template>
  <div class="home-view" :style="bgStyle">
    <div class="home-overlay">
      <div class="home-content">
        <h1 class="greeting">{{ greeting }}</h1>
        <p class="subtitle">{{ currentTime }}</p>
      </div>

      <button class="settings-btn" @click="showSettings = !showSettings" title="系统设置">
        设置
      </button>

      <button class="log-btn" @click="showLog = !showLog" title="系统日志">
        日志
      </button>

      <button class="wallpaper-btn" @click="showPanel = !showPanel" title="设置壁纸">
        壁纸
      </button>

      <!-- Wallpaper Settings Panel -->
      <div
        v-if="showPanel"
        ref="panelRef"
        class="wp-panel"
        :class="{ dragging: isDragging }"
        :style="panelStyle"
        @click.stop
        @mousedown="onPanelMouseDown"
      >
        <div class="wp-title">壁纸设置</div>

        <button class="wp-row-btn" @click="triggerUpload">上传新壁纸</button>
        <button v-if="wallpaperUrl" class="wp-row-btn danger" @click="clearWallpaper">恢复默认</button>

        <div class="wp-sep" />

        <div class="wp-label">显示模式</div>
        <div class="wp-mode-row">
          <button
            v-for="m in fitModes"
            :key="m.key"
            class="wp-mode-btn"
            :class="{ active: wallpaperFit === m.key }"
            @click="setFit(m.key)"
          >
            {{ m.label }}
          </button>
        </div>

        <div class="wp-sep" />

        <div class="wp-label">锚点位置</div>
        <div class="wp-anchor-grid">
          <button
            v-for="p in anchorList"
            :key="p"
            class="wp-anchor-btn"
            :class="{ active: wallpaperPos === p }"
            @click="setPos(p)"
          />
        </div>
      </div>

      <SystemSettingsPanel :visible="showSettings" @close="showSettings = false" />

      <!-- System Log Panel -->
      <div
        v-if="showLog"
        ref="logPanelRef"
        class="log-panel"
        :class="{ dragging: logDragging }"
        :style="logPanelStyle"
        @click.stop
        @mousedown="onLogPanelMouseDown"
      >
        <div class="log-title">系统日志</div>
        <div class="log-list" ref="logListRef">
          <div
            v-for="log in systemLogs"
            :key="log.id"
            class="log-item"
            :class="log.type"
          >
            <span class="log-time">{{ log.time }}</span>
            <span class="log-source">{{ log.source }}</span>
            <span class="log-msg">{{ log.message }}</span>
          </div>
          <div v-if="!systemLogs.length" class="log-empty">暂无日志</div>
        </div>
        <div class="log-actions">
          <button class="log-clear" @click="clearLogs">清空</button>
          <button class="log-refresh" @click="pushLog({type:'info', source:'系统', message:'手动刷新'})">刷新</button>
        </div>
      </div>

      <input
        ref="fileInput"
        type="file"
        accept="image/*"
        style="display: none"
        @change="onFileChange"
      />
    </div>

  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch, nextTick, onMounted, onBeforeUnmount } from 'vue'
import { api } from '@/api/client'
import { systemLogs, pushLog } from '@/composables/useWebSocket'
import SystemSettingsPanel from '@/components/SystemSettingsPanel.vue'

const fileInput = ref<HTMLInputElement>()
const panelRef = ref<HTMLElement>()
const logPanelRef = ref<HTMLElement>()
const logListRef = ref<HTMLElement>()
const wallpaperUrl = ref(localStorage.getItem('cm_wallpaper') || '')
const wallpaperFit = ref(localStorage.getItem('cm_wallpaper_fit') || 'cover')
const wallpaperPos = ref(localStorage.getItem('cm_wallpaper_pos') || 'center')
const showPanel = ref(false)
const showLog = ref(false)
const showSettings = ref(false)
const currentTime = ref('')

const isDragging = ref(false)
const dragOffset = ref({ x: 0, y: 0 })
const dragPos = ref({ x: 0, y: 0 })

const logDragging = ref(false)
const logDragOffset = ref({ x: 0, y: 0 })
const logDragPos = ref({ x: 0, y: 0 })

const panelStyle = computed(() => ({
  transform: `translate(${dragPos.value.x}px, ${dragPos.value.y}px)`,
}))

const logPanelStyle = computed(() => ({
  transform: `translate(${logDragPos.value.x}px, ${logDragPos.value.y}px)`,
}))

const fitModes = [
  { key: 'cover', label: '填充' },
  { key: 'contain', label: '适应' },
  { key: 'stretch', label: '拉伸' },
  { key: 'center', label: '平铺' },
]

const anchorList = [
  'top-left', 'top-center', 'top-right',
  'center-left', 'center', 'center-right',
  'bottom-left', 'bottom-center', 'bottom-right',
]

function posToCss(p: string): string {
  const map: Record<string, string> = {
    'top-left': '0% 0%',
    'top-center': '50% 0%',
    'top-right': '100% 0%',
    'center-left': '0% 50%',
    center: '50% 50%',
    'center-right': '100% 50%',
    'bottom-left': '0% 100%',
    'bottom-center': '50% 100%',
    'bottom-right': '100% 100%',
  }
  return map[p] || '50% 50%'
}

function fitToCss(f: string): string {
  if (f === 'stretch') return '100% 100%'
  if (f === 'center') return 'auto'
  return f // cover / contain
}

const bgStyle = computed(() => {
  if (wallpaperUrl.value) {
    return {
      backgroundImage: `url(${wallpaperUrl.value})`,
      backgroundSize: fitToCss(wallpaperFit.value),
      backgroundPosition: posToCss(wallpaperPos.value),
      backgroundRepeat: wallpaperFit.value === 'center' ? 'repeat' : 'no-repeat',
    }
  }
  return { background: 'radial-gradient(ellipse at 50% 100%, rgba(0,229,201,0.04) 0%, #0B0F17 60%)' }
})

const greeting = ref('')

function updateGreeting() {
  const h = new Date().getHours()
  if (h < 6) greeting.value = '夜深了，Zome 与你同在'
  else if (h < 12) greeting.value = '早安，开始今天的调度吧'
  else if (h < 18) greeting.value = '下午好，心智阵列待命'
  else greeting.value = '晚上好，复盘今日行动'
}

let timeTimer: ReturnType<typeof setInterval>

function onDocClick(e: MouseEvent) {
  const target = e.target as HTMLElement
  if (showPanel.value && !target.closest('.wp-panel') && !target.closest('.wallpaper-btn')) {
    showPanel.value = false
  }
  if (showLog.value && !target.closest('.log-panel') && !target.closest('.log-btn')) {
    showLog.value = false
  }
  if (showSettings.value && !target.closest('.sys-settings-panel') && !target.closest('.settings-btn')) {
    showSettings.value = false
  }
}

// Wallpaper panel drag
function onPanelMouseDown(e: MouseEvent) {
  const target = e.target as HTMLElement
  if (!target.classList.contains('wp-title')) return
  isDragging.value = true
  dragOffset.value = {
    x: e.clientX - dragPos.value.x,
    y: e.clientY - dragPos.value.y,
  }
  document.body.style.userSelect = 'none'
  document.addEventListener('mousemove', onPanelMouseMove)
  document.addEventListener('mouseup', onPanelMouseUp)
}

function onPanelMouseMove(e: MouseEvent) {
  if (!isDragging.value) return
  dragPos.value = {
    x: e.clientX - dragOffset.value.x,
    y: e.clientY - dragOffset.value.y,
  }
}

function onPanelMouseUp() {
  isDragging.value = false
  document.body.style.userSelect = ''
  document.removeEventListener('mousemove', onPanelMouseMove)
  document.removeEventListener('mouseup', onPanelMouseUp)
}

// Log panel drag
function onLogPanelMouseDown(e: MouseEvent) {
  const target = e.target as HTMLElement
  if (!target.classList.contains('log-title')) return
  logDragging.value = true
  logDragOffset.value = {
    x: e.clientX - logDragPos.value.x,
    y: e.clientY - logDragPos.value.y,
  }
  document.body.style.userSelect = 'none'
  document.addEventListener('mousemove', onLogPanelMouseMove)
  document.addEventListener('mouseup', onLogPanelMouseUp)
}

function onLogPanelMouseMove(e: MouseEvent) {
  if (!logDragging.value) return
  logDragPos.value = {
    x: e.clientX - logDragOffset.value.x,
    y: e.clientY - logDragOffset.value.y,
  }
}

function onLogPanelMouseUp() {
  logDragging.value = false
  document.body.style.userSelect = ''
  document.removeEventListener('mousemove', onLogPanelMouseMove)
  document.removeEventListener('mouseup', onLogPanelMouseUp)
}

function clearLogs() {
  systemLogs.value = []
}

onMounted(() => {
  updateTime()
  updateGreeting()
  timeTimer = setInterval(() => {
    updateTime()
    updateGreeting()
  }, 1000)
  document.addEventListener('click', onDocClick)
  pushLog({ type: 'info', source: '系统', message: 'Zome 已启动' })
})

onBeforeUnmount(() => {
  clearInterval(timeTimer)
  document.removeEventListener('click', onDocClick)
})

function updateTime() {
  const d = new Date()
  currentTime.value = d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
}

// Auto-scroll log list
watch(systemLogs, () => {
  nextTick(() => {
    logListRef.value?.scrollTo({ top: logListRef.value.scrollHeight, behavior: 'smooth' })
  })
}, { deep: true })

function triggerUpload() {
  fileInput.value?.click()
}

async function onFileChange(e: Event) {
  const file = (e.target as HTMLInputElement).files?.[0]
  if (!file) return
  const fd = new FormData()
  fd.append('file', file)
  const json = await api.upload('/upload?folder=wallpapers', fd)
  if (json.code === 0) {
    wallpaperUrl.value = json.data.url
    localStorage.setItem('cm_wallpaper', json.data.url)
    wallpaperFit.value = 'cover'
    wallpaperPos.value = 'center'
    localStorage.setItem('cm_wallpaper_fit', 'cover')
    localStorage.setItem('cm_wallpaper_pos', 'center')
  }
}

function clearWallpaper() {
  wallpaperUrl.value = ''
  localStorage.removeItem('cm_wallpaper')
  localStorage.removeItem('cm_wallpaper_fit')
  localStorage.removeItem('cm_wallpaper_pos')
  wallpaperFit.value = 'cover'
  wallpaperPos.value = 'center'
}

function setFit(key: string) {
  wallpaperFit.value = key
  localStorage.setItem('cm_wallpaper_fit', key)
}

function setPos(pos: string) {
  wallpaperPos.value = pos
  localStorage.setItem('cm_wallpaper_pos', pos)
}
</script>

<style scoped>
.home-view {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
}
.home-overlay {
  position: absolute;
  inset: 0;
  background: rgba(11, 15, 23, 0.35);
  display: flex;
  align-items: center;
  justify-content: center;
}
.home-content {
  text-align: center;
  color: #D8E1EC;
}
.greeting {
  font-size: 32px;
  font-weight: 500;
  margin: 0 0 12px;
  text-shadow: 0 2px 12px rgba(0, 0, 0, 0.5);
}
.subtitle {
  font-size: 16px;
  color: #8899AA;
  margin: 0;
  text-shadow: 0 1px 8px rgba(0, 0, 0, 0.5);
}

/* Settings button */
.settings-btn {
  position: absolute;
  bottom: 72px;
  right: 116px;
  width: 40px;
  height: 40px;
  border-radius: 50%;
  background: rgba(20, 27, 36, 0.7);
  border: 1px solid rgba(255, 255, 255, 0.1);
  color: #D8E1EC;
  font-size: 12px;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  backdrop-filter: blur(8px);
  transition: all 0.2s;
  z-index: 110;
}
.settings-btn:hover {
  background: rgba(0, 229, 201, 0.15);
  border-color: rgba(0, 229, 201, 0.3);
}

/* Log button */
.log-btn {
  position: absolute;
  bottom: 72px;
  right: 68px;
  width: 40px;
  height: 40px;
  border-radius: 50%;
  background: rgba(20, 27, 36, 0.7);
  border: 1px solid rgba(255, 255, 255, 0.1);
  color: #D8E1EC;
  font-size: 12px;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  backdrop-filter: blur(8px);
  transition: all 0.2s;
  z-index: 110;
}
.log-btn:hover {
  background: rgba(0, 229, 201, 0.15);
  border-color: rgba(0, 229, 201, 0.3);
}

/* Wallpaper button */
.wallpaper-btn {
  position: absolute;
  bottom: 72px;
  right: 20px;
  width: 40px;
  height: 40px;
  border-radius: 50%;
  background: rgba(20, 27, 36, 0.7);
  border: 1px solid rgba(255, 255, 255, 0.1);
  color: #D8E1EC;
  font-size: 12px;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  backdrop-filter: blur(8px);
  transition: all 0.2s;
  z-index: 110;
}
.wallpaper-btn:hover {
  background: rgba(0, 229, 201, 0.15);
  border-color: rgba(0, 229, 201, 0.3);
}

/* Wallpaper panel */
.wp-panel {
  position: absolute;
  bottom: 120px;
  right: 16px;
  width: 220px;
  padding: 16px;
  background: rgba(11, 15, 23, 0.85);
  backdrop-filter: blur(16px);
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: 12px;
  z-index: 120;
  color: #D8E1EC;
}
.wp-title {
  font-size: 14px;
  font-weight: 600;
  margin-bottom: 12px;
  cursor: grab;
  user-select: none;
}
.wp-panel.dragging .wp-title {
  cursor: grabbing;
}
.wp-row-btn {
  width: 100%;
  padding: 8px;
  margin-bottom: 8px;
  background: rgba(255, 255, 255, 0.06);
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: 6px;
  color: #D8E1EC;
  font-size: 13px;
  cursor: pointer;
  transition: all 0.15s;
}
.wp-row-btn:hover {
  background: rgba(0, 229, 201, 0.12);
  border-color: rgba(0, 229, 201, 0.25);
}
.wp-row-btn.danger:hover {
  background: rgba(239, 68, 68, 0.12);
  border-color: rgba(239, 68, 68, 0.25);
  color: #EF4444;
}
.wp-sep {
  height: 1px;
  background: rgba(255, 255, 255, 0.06);
  margin: 12px 0;
}
.wp-label {
  font-size: 11px;
  color: #8899AA;
  margin-bottom: 8px;
}
.wp-mode-row {
  display: flex;
  gap: 6px;
}
.wp-mode-btn {
  flex: 1;
  padding: 6px 0;
  background: rgba(255, 255, 255, 0.04);
  border: 1px solid rgba(255, 255, 255, 0.06);
  border-radius: 6px;
  color: #8899AA;
  font-size: 12px;
  cursor: pointer;
  transition: all 0.15s;
}
.wp-mode-btn.active,
.wp-mode-btn:hover {
  background: rgba(0, 229, 201, 0.12);
  border-color: rgba(0, 229, 201, 0.3);
  color: #00E5C9;
}
.wp-anchor-grid {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 6px;
  width: 120px;
  margin: 0 auto;
}
.wp-anchor-btn {
  width: 100%;
  aspect-ratio: 1;
  background: rgba(255, 255, 255, 0.06);
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: 4px;
  cursor: pointer;
  transition: all 0.15s;
}
.wp-anchor-btn:hover {
  background: rgba(0, 229, 201, 0.15);
}
.wp-anchor-btn.active {
  background: rgba(0, 229, 201, 0.3);
  border-color: rgba(0, 229, 201, 0.5);
}

/* Log panel */
.log-panel {
  position: absolute;
  bottom: 120px;
  right: 68px;
  width: 320px;
  max-height: 420px;
  padding: 14px;
  background: rgba(11, 15, 23, 0.88);
  backdrop-filter: blur(16px);
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: 12px;
  z-index: 120;
  color: #D8E1EC;
  display: flex;
  flex-direction: column;
}
.log-title {
  font-size: 13px;
  font-weight: 600;
  margin-bottom: 10px;
  cursor: grab;
  user-select: none;
  flex-shrink: 0;
}
.log-panel.dragging .log-title {
  cursor: grabbing;
}
.log-list {
  flex: 1;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 6px;
  font-size: 11px;
  line-height: 1.45;
  padding-right: 4px;
}
.log-list::-webkit-scrollbar {
  width: 4px;
}
.log-list::-webkit-scrollbar-thumb {
  background: rgba(255, 255, 255, 0.1);
  border-radius: 2px;
}
.log-item {
  display: flex;
  gap: 6px;
  padding: 4px 6px;
  border-radius: 4px;
  background: rgba(255, 255, 255, 0.03);
}
.log-time {
  color: #5A6A7A;
  white-space: nowrap;
  flex-shrink: 0;
}
.log-source {
  color: #8899AA;
  white-space: nowrap;
  flex-shrink: 0;
  min-width: 40px;
}
.log-msg {
  color: #D8E1EC;
  word-break: break-word;
}
.log-item.success .log-msg {
  color: #10B981;
}
.log-item.warn .log-msg {
  color: #F59E0B;
}
.log-item.error .log-msg {
  color: #EF4444;
}
.log-item.info .log-msg {
  color: #00E5C9;
}
.log-empty {
  color: #5A6A7A;
  text-align: center;
  padding: 20px 0;
}
.log-actions {
  display: flex;
  gap: 8px;
  margin-top: 10px;
  flex-shrink: 0;
}
.log-actions button {
  flex: 1;
  padding: 6px;
  background: rgba(255, 255, 255, 0.06);
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: 6px;
  color: #8899AA;
  font-size: 12px;
  cursor: pointer;
  transition: all 0.15s;
}
.log-actions button:hover {
  background: rgba(0, 229, 201, 0.12);
  border-color: rgba(0, 229, 201, 0.25);
  color: #00E5C9;
}
</style>
