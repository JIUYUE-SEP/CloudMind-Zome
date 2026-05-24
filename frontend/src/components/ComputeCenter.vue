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

    <div class="cc-grid">
      <div
        v-for="p in store.providers"
        :key="p.id"
        class="cc-provider-card"
        @click="openEdit(p)"
      >
        <div class="cc-provider-header">
          <div class="cc-dot" :class="p.status === 'active' ? 'green' : 'red'"></div>
          <div class="cc-provider-name">{{ p.display_name }}</div>
          <div class="cc-provider-type">{{ p.provider_type }}</div>
        </div>
        <div class="cc-provider-url">{{ p.base_url || '默认地址' }}</div>
        <div class="cc-model-list">
          <span v-for="m in (p.models || []).slice(0, 3)" :key="m" class="cc-model-tag">{{ m }}</span>
          <span v-if="(p.models || []).length > 3" class="cc-model-more">+{{ (p.models || []).length - 3 }}</span>
          <span v-if="!(p.models || []).length" class="cc-model-empty">未配置模型</span>
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
        <label class="field-label">平台名称 *</label>
        <input v-model="form.display_name" placeholder="如：我的 DeepSeek" />
        <label class="field-label">API Key *</label>
        <input v-model="form.api_key" placeholder="从服务商获取的 API Key" type="password" />
        <label class="field-label">Base URL（OpenAI 格式）*</label>
        <input v-model="form.base_url" placeholder="如：https://api.deepseek.com/v1" />
        <div v-if="addError" class="add-error">{{ addError }}</div>
        <div class="modal-actions">
          <button @click="submitAdd">保存</button>
          <button class="secondary" @click="showAdd = false">取消</button>
        </div>
      </div>
    </div>

    <!-- Edit Provider Modal -->
    <div v-if="editProvider" class="modal-overlay" @click="closeEdit">
      <div class="modal-card edit-card" @click.stop>
        <h3>{{ editProvider.display_name }}</h3>

        <label class="field-label">平台名称</label>
        <input v-model="editForm.display_name" />

        <label class="field-label">Base URL</label>
        <input v-model="editForm.base_url" />

        <label class="field-label">API Key（留空则不修改）</label>
        <input v-model="editForm.api_key" placeholder="输入新 API Key（留空则不修改）" type="password" />

        <div class="edit-section">
          <div class="edit-section-title">模型列表</div>
          <div class="model-tags">
            <span v-for="(m, idx) in editForm.models" :key="m + idx" class="model-tag">
              {{ m }}
              <button class="model-remove" @click="removeModel(idx)">x</button>
            </span>
          </div>
          <div class="model-add-row">
            <input
              v-model="newModel"
              placeholder="输入模型名称，如 deepseek-v4"
              @keydown.enter.prevent="addModel"
            />
            <button class="model-add-btn" @click="addModel">添加</button>
          </div>
        </div>

        <div v-if="editError" class="add-error">{{ editError }}</div>

        <div class="modal-actions">
          <button @click="submitEdit">保存</button>
          <button class="secondary" @click="testCurrent">测试连接</button>
          <button class="danger" @click="deleteCurrent">断开</button>
          <button class="secondary" @click="closeEdit">取消</button>
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
})

const editProvider = ref<any>(null)
const editForm = ref({
  display_name: '',
  base_url: '',
  api_key: '',
  models: [] as string[],
})
const editError = ref('')
const newModel = ref('')

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

function openEdit(p: any) {
  editProvider.value = p
  editForm.value = {
    display_name: p.display_name || '',
    base_url: p.base_url || '',
    api_key: '',
    models: [...(p.models || [])],
  }
  editError.value = ''
  newModel.value = ''
}

function closeEdit() {
  editProvider.value = null
  editError.value = ''
  newModel.value = ''
}

function addModel() {
  const name = newModel.value.trim()
  if (!name) return
  if (editForm.value.models.includes(name)) {
    editError.value = '模型已存在'
    return
  }
  editForm.value.models.push(name)
  newModel.value = ''
  editError.value = ''
}

function removeModel(idx: number) {
  editForm.value.models.splice(idx, 1)
}

async function submitEdit() {
  editError.value = ''
  if (!editForm.value.display_name.trim()) {
    editError.value = '平台名称不能为空'
    return
  }
  const body: any = {
    display_name: editForm.value.display_name,
    base_url: editForm.value.base_url,
    models: editForm.value.models,
  }
  if (editForm.value.api_key.trim()) {
    body.api_key = editForm.value.api_key
  }
  const res = await store.updateProvider(editProvider.value.id, body)
  if (res.code !== 0 && res.code !== undefined) {
    editError.value = res.message || '保存失败'
    return
  }
  closeEdit()
}

async function testCurrent() {
  if (!editProvider.value) return
  const res = await store.testConnection(editProvider.value.id)
  alert(res.data?.message || '测试完成')
}

async function deleteCurrent() {
  if (!editProvider.value) return
  if (!confirm('确定要断开这个平台吗？')) return
  await store.deleteProvider(editProvider.value.id)
  closeEdit()
}

async function submitAdd() {
  addError.value = ''
  if (!form.value.display_name.trim()) {
    addError.value = '请填写平台名称'
    return
  }
  if (!form.value.api_key.trim()) {
    addError.value = '请填写 API Key'
    return
  }
  if (!form.value.base_url.trim()) {
    addError.value = '请填写 Base URL'
    return
  }
  const body = {
    display_name: form.value.display_name,
    api_key: form.value.api_key,
    base_url: form.value.base_url,
  }
  const res = await store.addProvider(body)
  if (res.code !== 0 && res.code !== undefined) {
    addError.value = res.message || '保存失败'
    return
  }
  showAdd.value = false
  form.value = { display_name: '', api_key: '', base_url: '' }
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

.cc-grid { flex: 1; overflow-y: auto; padding: 0 20px; display: grid; grid-template-columns: repeat(auto-fill, minmax(260px, 1fr)); gap: 12px; align-content: start; }
.cc-provider-card { background: rgba(20,27,36,0.5); border: 1px solid rgba(255,255,255,0.06); border-radius: 12px; padding: 16px; cursor: pointer; transition: border-color 0.15s, background 0.15s; }
.cc-provider-card:hover { border-color: rgba(0,229,201,0.3); background: rgba(20,27,36,0.7); }
.cc-provider-header { display: flex; align-items: center; gap: 10px; margin-bottom: 8px; }
.cc-dot { width: 10px; height: 10px; border-radius: 50%; flex-shrink: 0; }
.cc-dot.green { background: #10B981; }
.cc-dot.red { background: #EF4444; }
.cc-provider-name { font-size: 15px; color: #D8E1EC; font-weight: 500; flex: 1; }
.cc-provider-type { font-size: 11px; color: #5A6A7A; text-transform: uppercase; }
.cc-provider-url { font-size: 11px; color: #5A6A7A; margin-bottom: 10px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.cc-model-list { display: flex; flex-wrap: wrap; gap: 6px; }
.cc-model-tag { padding: 3px 8px; background: rgba(0,229,201,0.08); border: 1px solid rgba(0,229,201,0.2); border-radius: 4px; font-size: 11px; color: #00E5C9; }
.cc-model-more { padding: 3px 8px; font-size: 11px; color: #5A6A7A; }
.cc-model-empty { font-size: 11px; color: #5A6A7A; font-style: italic; }
.cc-empty { grid-column: 1 / -1; text-align: center; padding: 40px; color: #8899AA; }

.cc-chart { padding: 0 20px 20px; }
.cc-chart canvas { width: 100%; height: 200px; }

.modal-overlay { position: fixed; inset: 0; background: rgba(0,0,0,0.6); display: flex; align-items: center; justify-content: center; z-index: 800; }
.modal-card { width: 400px; padding: 24px; background: rgba(20,27,36,0.95); border: 1px solid rgba(0,229,201,0.2); border-radius: 12px; }
.modal-card.edit-card { width: 460px; }
.modal-card h3 { margin: 0 0 16px; font-size: 16px; color: #D8E1EC; }
.field-label { display: block; font-size: 12px; color: #8899AA; margin: 12px 0 4px; }
.modal-card input, .modal-card select { width: 100%; margin: 4px 0 8px; padding: 10px; background: #0B0F17; border: 1px solid #1E2731; border-radius: 6px; color: #D8E1EC; box-sizing: border-box; }
.modal-card input:focus, .modal-card select:focus { outline: none; border-color: #00E5C9; }
.add-error { padding: 8px 10px; background: rgba(239,68,68,0.1); color: #EF4444; border-radius: 6px; font-size: 13px; margin: 8px 0; }
.modal-actions { display: flex; gap: 10px; margin-top: 16px; flex-wrap: wrap; }
.modal-actions button { flex: 1; padding: 10px; background: #00E5C9; color: #0B0F17; border: none; border-radius: 6px; cursor: pointer; font-weight: 600; min-width: 80px; }
.modal-actions button.secondary { background: transparent; border: 1px solid #1E2731; color: #8899AA; }
.modal-actions button.danger { background: rgba(239,68,68,0.15); border: 1px solid rgba(239,68,68,0.4); color: #EF4444; }

.edit-section { margin-top: 16px; padding-top: 12px; border-top: 1px solid rgba(255,255,255,0.06); }
.edit-section-title { font-size: 13px; color: #8899AA; margin-bottom: 10px; }
.model-tags { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 10px; }
.model-tag { display: inline-flex; align-items: center; gap: 4px; padding: 4px 10px; background: rgba(0,229,201,0.08); border: 1px solid rgba(0,229,201,0.2); border-radius: 4px; font-size: 12px; color: #00E5C9; }
.model-remove { width: 16px; height: 16px; display: flex; align-items: center; justify-content: center; background: transparent; border: none; color: #8899AA; font-size: 11px; cursor: pointer; padding: 0; }
.model-remove:hover { color: #EF4444; }
.model-add-row { display: flex; gap: 8px; }
.model-add-row input { flex: 1; margin: 0; }
.model-add-btn { padding: 8px 14px; background: rgba(0,229,201,0.12); border: 1px solid rgba(0,229,201,0.25); border-radius: 6px; color: #00E5C9; font-size: 12px; cursor: pointer; font-weight: 500; }
</style>
