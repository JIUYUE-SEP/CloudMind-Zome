<template>
  <div class="compute-center">
    <header class="cc-header">
      <BackButton />
      <h2>算力中枢</h2>
      <button class="primary-btn" @click="showAdd = true">+ 添加平台</button>
    </header>

    <div class="cc-cards">
      <div class="cc-card">
        <div class="cc-label">今日消耗</div>
        <div class="cc-value">{{ todayTokens }}</div>
        <div class="cc-unit">Tokens</div>
      </div>
      <div class="cc-card">
        <div class="cc-label">可用额度</div>
        <div class="cc-value">{{ totalRemaining }}</div>
        <div class="cc-unit">Tokens</div>
      </div>
      <div class="cc-card">
        <div class="cc-label">预估剩余</div>
        <div class="cc-value">{{ estDays }}</div>
        <div class="cc-unit">天</div>
      </div>
    </div>

    <div class="cc-list">
      <div v-for="p in store.providers" :key="p.id" class="cc-row">
        <div class="cc-left">
          <div class="cc-dot" :class="p.status === 'active' ? 'green' : 'red'"></div>
          <div class="cc-info">
            <div class="cc-name">{{ p.display_name }}</div>
            <div class="cc-type">{{ p.provider_type }}</div>
          </div>
        </div>
        <div class="cc-mid">
          <div class="cc-bar-bg">
            <div class="cc-bar-fill" :style="{ width: barPercent(p) + '%', background: barColor(p) }"></div>
          </div>
          <div class="cc-nums">{{ p.quota_remaining }} / {{ p.quota_total || '∞' }}</div>
        </div>
        <div class="cc-right">
          <button class="cc-action" @click="testProv(p.id)">测试连接</button>
          <button class="cc-action danger" @click="store.deleteProvider(p.id)">断开</button>
        </div>
      </div>
      <div v-if="!store.providers.length" class="cc-empty">
        <p>尚未接入算力源</p>
        <button class="primary-btn" @click="showAdd = true">添加第一个 API 密钥</button>
      </div>
    </div>

    <div class="cc-chart" v-if="store.usage.dates.length">
      <canvas ref="chartCanvas" width="600" height="200"></canvas>
    </div>

    <!-- Add Provider Modal -->
    <div v-if="showAdd" class="modal-overlay" @click="showAdd = false">
      <div class="modal-card" @click.stop>
        <h3>添加算力平台</h3>
        <label class="field-label">显示名称 *</label>
        <input v-model="form.display_name" placeholder="如：我的 DeepSeek" />
        <label class="field-label">API Key *</label>
        <input v-model="form.api_key" placeholder="从服务商获取的 API Key" type="password" />
        <label class="field-label">Base URL（可选）</label>
        <input v-model="form.base_url" placeholder="如：https://api.deepseek.com/v1" />
        <label class="field-label">总配额 Token 数（可选，0=无限）</label>
        <input v-model.number="form.quota_total" placeholder="0" type="number" />
        <div v-if="addError" class="add-error">{{ addError }}</div>
        <div class="modal-actions">
          <button @click="submitAdd">保存</button>
          <button class="secondary" @click="showAdd = false">取消</button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted, onBeforeUnmount, nextTick } from 'vue'
import { useComputeStore } from '@/stores/compute'
import BackButton from '@/components/BackButton.vue'

const emit = defineEmits(['close'])
const store = useComputeStore()
const showAdd = ref(false)
const addError = ref('')
const chartCanvas = ref<HTMLCanvasElement>()
const form = ref({
  display_name: '',
  api_key: '',
  base_url: '',
  quota_total: 0,
})

const todayTokens = ref(0)
const totalRemaining = ref(0)
const estDays = ref('--')

onMounted(async () => {
  await store.fetchProviders()
  await store.fetchUsage(7)
  computeStats()
  nextTick(drawChart)
  window.addEventListener('resize', drawChart)
})

onBeforeUnmount(() => {
  window.removeEventListener('resize', drawChart)
})

function computeStats() {
  const today = new Date().toISOString().slice(0, 10)
  const idx = store.usage.dates.indexOf(today)
  todayTokens.value = idx >= 0 ? store.usage.tokens[idx] : 0
  totalRemaining.value = store.providers.reduce((s, p) => s + (p.quota_remaining || 0), 0)
  const avg = store.usage.tokens.length ? store.usage.tokens.reduce((a, b) => a + b, 0) / store.usage.tokens.length : 0
  estDays.value = avg > 0 ? String(Math.round(totalRemaining.value / avg)) : '--'
}

function barPercent(p: any) {
  if (!p.quota_total) return 0
  return ((p.quota_used || 0) / p.quota_total) * 100
}
function barColor(p: any) {
  const pct = barPercent(p)
  if (pct < 50) return '#00E5C9'
  if (pct < 80) return '#F59E0B'
  return '#EF4444'
}

async function testProv(id: string) {
  const res = await store.testConnection(id)
  alert(res.data.message)
}

async function submitAdd() {
  addError.value = ''
  if (!form.value.display_name.trim()) {
    addError.value = '请填写显示名称'
    return
  }
  if (!form.value.api_key.trim()) {
    addError.value = '请填写 API Key'
    return
  }
  const body = {
    display_name: form.value.display_name,
    api_key: form.value.api_key,
    config: { base_url: form.value.base_url },
    quota_total: form.value.quota_total || 0,
  }
  const res = await store.addProvider(body)
  console.log('addProvider response:', res)
  if (res.code !== 0 && res.code !== undefined) {
    addError.value = res.message || '保存失败'
    return
  }
  // Force refresh list
  await store.fetchProviders()
  console.log('Providers after add:', store.providers.length, store.providers)
  showAdd.value = false
  form.value = { display_name: '', api_key: '', base_url: '', quota_total: 0 }
  computeStats()
}

function drawChart() {
  const cvs = chartCanvas.value
  if (!cvs || !store.usage.dates.length) return
  const dpr = window.devicePixelRatio || 1
  const rect = cvs.getBoundingClientRect()
  cvs.width = rect.width * dpr
  cvs.height = rect.height * dpr
  const ctx = cvs.getContext('2d')!
  ctx.scale(dpr, dpr)
  const w = rect.width
  const h = rect.height
  ctx.clearRect(0, 0, w, h)
  const data = store.usage.tokens
  const max = Math.max(...data, 1)
  const step = w / (data.length - 1 || 1)
  ctx.beginPath()
  ctx.strokeStyle = '#00E5C9'
  ctx.lineWidth = 2
  data.forEach((v, i) => {
    const x = i * step
    const y = h - (v / max) * (h - 20) - 10
    if (i === 0) ctx.moveTo(x, y)
    else ctx.lineTo(x, y)
  })
  ctx.stroke()
}
</script>

<style scoped>
.compute-center { position: fixed; inset: 0; background: #0B0F17; z-index: 900; display: flex; flex-direction: column; }
.cc-header { height: 56px; display: flex; align-items: center; gap: 16px; padding: 0 20px; border-bottom: 1px solid rgba(255,255,255,0.06); }
h2 { flex: 1; font-size: 18px; margin: 0; color: #D8E1EC; }
.primary-btn { padding: 8px 16px; background: #00E5C9; color: #0B0F17; border: none; border-radius: 6px; font-weight: 600; cursor: pointer; }

.cc-cards { display: flex; gap: 12px; padding: 20px; }
.cc-card { flex: 1; background: rgba(20,27,36,0.6); border-radius: 12px; padding: 20px; }
.cc-label { font-size: 12px; color: #8899AA; }
.cc-value { font-size: 28px; font-weight: 700; color: #D8E1EC; margin-top: 8px; }
.cc-unit { font-size: 12px; color: #5A6A7A; }

.cc-list { flex: 1; overflow-y: auto; padding: 0 20px; }
.cc-row { display: flex; align-items: center; gap: 16px; padding: 14px; background: rgba(20,27,36,0.4); border-radius: 10px; margin-bottom: 8px; }
.cc-left { display: flex; align-items: center; gap: 12px; width: 180px; }
.cc-dot { width: 10px; height: 10px; border-radius: 50%; }
.cc-dot.green { background: #10B981; }
.cc-dot.red { background: #EF4444; }
.cc-name { font-size: 14px; color: #D8E1EC; font-weight: 500; }
.cc-type { font-size: 11px; color: #5A6A7A; }
.cc-mid { flex: 1; }
.cc-bar-bg { height: 6px; background: #1E2731; border-radius: 3px; overflow: hidden; }
.cc-bar-fill { height: 100%; border-radius: 3px; }
.cc-nums { font-size: 11px; color: #5A6A7A; margin-top: 4px; }
.cc-right { display: flex; gap: 8px; }
.cc-action { padding: 6px 12px; font-size: 12px; background: transparent; border: 1px solid #1E2731; color: #8899AA; border-radius: 6px; cursor: pointer; }
.cc-action:hover { border-color: #00E5C9; color: #00E5C9; }
.cc-action.danger:hover { border-color: #EF4444; color: #EF4444; }

.cc-empty { text-align: center; padding: 40px; color: #8899AA; }

.cc-chart { padding: 0 20px 20px; }
.cc-chart canvas { width: 100%; height: 200px; }

.modal-overlay { position: fixed; inset: 0; background: rgba(0,0,0,0.6); display: flex; align-items: center; justify-content: center; z-index: 800; }
.modal-card { width: 400px; padding: 24px; background: rgba(20,27,36,0.95); border: 1px solid rgba(0,229,201,0.2); border-radius: 12px; }
.modal-card h3 { margin: 0 0 16px; font-size: 16px; color: #D8E1EC; }
.field-label { display: block; font-size: 12px; color: #8899AA; margin: 12px 0 4px; }
.modal-card input, .modal-card select { width: 100%; margin: 4px 0 8px; padding: 10px; background: #0B0F17; border: 1px solid #1E2731; border-radius: 6px; color: #D8E1EC; }
.modal-card input:focus, .modal-card select:focus { outline: none; border-color: #00E5C9; }
.add-error { padding: 8px 10px; background: rgba(239,68,68,0.1); color: #EF4444; border-radius: 6px; font-size: 13px; margin: 8px 0; }
.modal-actions { display: flex; gap: 10px; margin-top: 16px; }
.modal-actions button { flex: 1; padding: 10px; background: #00E5C9; color: #0B0F17; border: none; border-radius: 6px; cursor: pointer; font-weight: 600; }
.modal-actions button.secondary { background: transparent; border: 1px solid #1E2731; color: #8899AA; }
</style>
