<template>
  <div ref="container" class="live2d-viewer">
    <div v-if="showEmpty" class="viewer-empty">
      <div class="empty-ring"></div>
      <div class="empty-hint">Live2D 展示区</div>
      <div class="empty-sub">请上传 Live2D 模型文件</div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, onBeforeUnmount, watch } from 'vue'

const props = defineProps<{ modelUrl: string }>()
const container = ref<HTMLDivElement>()
const loadError = ref(false)

// 本地默认模型（离线可用）
const DEFAULT_MODEL = '/live2d-models/shizuku/shizuku.model.json'

const showEmpty = computed(() => !props.modelUrl && loadError.value)

let widgetRoot: HTMLElement | null = null

onMounted(() => {
  initLive2D()
})

watch(() => props.modelUrl, () => {
  destroyWidget()
  initLive2D()
})

onBeforeUnmount(() => {
  destroyWidget()
})

function destroyWidget() {
  if (widgetRoot) {
    widgetRoot.remove()
    widgetRoot = null
  }
  // 清理全局残留
  const el = document.getElementById('live2d-widget')
  if (el) el.remove()
}

async function initLive2D() {
  const url = props.modelUrl || DEFAULT_MODEL
  if (!url) {
    loadError.value = true
    return
  }

  try {
    await ensureScriptLoaded()
    startWidget(url)
  } catch {
    loadError.value = true
  }
}

function ensureScriptLoaded(): Promise<void> {
  return new Promise((resolve, reject) => {
    if ((window as any).L2Dwidget) {
      resolve()
      return
    }

    const existing = document.querySelector('script[data-live2d-local]') as HTMLScriptElement
    if (existing) {
      existing.addEventListener('load', () => resolve())
      existing.addEventListener('error', () => reject())
      return
    }

    const script = document.createElement('script')
    script.src = '/libs/live2d-widget.min.js'
    script.dataset.live2dLocal = 'true'
    script.onload = () => resolve()
    script.onerror = () => reject()
    document.head.appendChild(script)
  })
}

function startWidget(url: string) {
  const L2D = (window as any).L2Dwidget
  if (!L2D || !container.value) return

  L2D.init({
    model: { jsonPath: url },
    display: { width: 280, height: 360, position: 'absolute' },
    mobile: { show: true },
  })

  // 等待 canvas 创建后移入容器
  const tryMove = () => {
    const el = document.getElementById('live2d-widget')
    if (el && container.value) {
      widgetRoot = el
      el.style.position = 'absolute'
      el.style.left = '50%'
      el.style.top = '50%'
      el.style.transform = 'translate(-50%, -50%)'
      el.style.zIndex = '10'

      const canvas = el.querySelector('canvas') as HTMLElement
      if (canvas) {
        canvas.style.width = '280px'
        canvas.style.height = '360px'
      }
      container.value.appendChild(el)
      return true
    }
    return false
  }

  // 轮询直到 canvas 出现
  let attempts = 0
  const timer = setInterval(() => {
    attempts++
    if (tryMove() || attempts > 30) {
      clearInterval(timer)
    }
  }, 100)
}
</script>

<style scoped>
.live2d-viewer {
  position: relative;
  width: 100%;
  height: 100%;
  overflow: hidden;
}
.viewer-empty {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 12px;
}
.empty-ring {
  width: 160px;
  height: 160px;
  border: 1px dashed rgba(0, 229, 201, 0.2);
  border-radius: 50%;
  animation: pulse-ring 3s ease-in-out infinite;
}
.empty-hint {
  font-size: 14px;
  color: #5a6a7a;
}
.empty-sub {
  font-size: 12px;
  color: #3a4a5a;
}
@keyframes pulse-ring {
  0%, 100% { transform: scale(1); opacity: 0.6; }
  50% { transform: scale(1.02); opacity: 1; }
}
</style>
