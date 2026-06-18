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

    <div class="cc-groups">
      <div v-for="group in groupedProviders" :key="group.type" class="cc-group">
        <div class="cc-group-header">
          <span class="cc-group-icon">{{ group.icon }}</span>
          <span class="cc-group-label">{{ group.label }}</span>
        </div>
        <div class="cc-grid">
          <div
            v-for="p in group.providers"
            :key="p.id"
            class="cc-provider-card"
            @click="openEdit(p)"
          >
            <div class="cc-provider-header">
              <div class="cc-dot" :class="p.status === 'active' ? 'green' : 'red'"></div>
              <div class="cc-provider-name">{{ p.display_name }}</div>
              <div v-if="!p.has_api_key" class="cc-key-warning" @click.stop="openEdit(p, true)">未配置 API Key</div>
              <div class="cc-provider-type">{{ p.provider_type }}</div>
            </div>
            <div class="cc-provider-url">{{ p.base_url || '默认地址' }}</div>
            <div class="cc-model-list">
              <span v-for="m in (p.models || []).slice(0, 3)" :key="m.id" class="cc-model-tag">{{ m.display_name || m.id }}</span>
              <span v-if="(p.models || []).length > 3" class="cc-model-more">+{{ (p.models || []).length - 3 }}</span>
              <span v-if="!(p.models || []).length" class="cc-model-empty">未配置模型</span>
            </div>
          </div>
          <div v-if="!group.providers.length" class="cc-empty">
            <p>暂无 {{ group.label }}</p>
          </div>
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
        <input ref="apiKeyInput" v-model="editForm.api_key" placeholder="输入新 API Key（留空则不修改）" type="password" />

        <!-- 模型管理区域 -->
        <div class="edit-section">
          <div class="edit-section-title">模型列表</div>

          <div v-if="!editProvider.models?.length" class="hint-text">暂无模型，请通过下方按钮添加或点击「测试连接并发现模型」自动拉取。</div>

          <div v-else class="model-table">
            <div class="model-table-header">
              <span class="col-name">模型名称</span>
              <span class="col-type">类型</span>
              <span class="col-ctx">上下文窗口</span>
              <span class="col-out">最大输出</span>
              <span class="col-caps">能力</span>
              <span class="col-ops">操作</span>
            </div>
            <div
              v-for="m in editProvider.models"
              :key="m.id"
              class="model-table-row"
              :class="{ expanded: editingModelId === m.id }"
            >
              <div class="model-table-cells">
                <span class="col-name">{{ m.display_name || m.id }}</span>
                <span class="col-type">{{ typeLabel(m.model_type) }}</span>
                <span class="col-ctx">{{ m.context_window?.toLocaleString() ?? '-' }}</span>
                <span class="col-out">{{ m.max_output_tokens?.toLocaleString() ?? '-' }}</span>
                <span class="col-caps">
                  <span v-if="m.supports_reasoning" class="cap-tag" title="支持深度思考">思</span>
                  <span v-if="m.supports_tool_calling" class="cap-tag" title="支持工具调用">工</span>
                  <span v-if="m.supports_multimodal" class="cap-tag" title="支持多模态">图</span>
                </span>
                <span class="col-ops">
                  <button class="table-action" @click="startEditModel(m)">编辑</button>
                  <button class="table-action danger" @click="removeModel(m)">删除</button>
                </span>
              </div>

              <!-- Inline edit form -->
              <div v-if="editingModelId === m.id" class="model-edit-form">
                <label class="field-label">显示名称</label>
                <input v-model="editModelForm.display_name" />

                <label class="field-label">模型类型</label>
                <select v-model="editModelForm.model_type">
                  <option value="llm">对话模型</option>
                  <option value="embedding">Embedding</option>
                  <option value="image">图片生成</option>
                  <option value="stt">语音识别</option>
                </select>

                <div class="model-edit-row-2" v-if="editModelForm.model_type === 'llm'">
                  <div>
                    <label class="field-label">上下文窗口</label>
                    <input v-model.number="editModelForm.context_window" type="number" min="1" />
                    <p class="field-hint">该模型一次能处理的最大上下文长度（token 数）</p>
                  </div>
                  <div>
                    <label class="field-label">最大输出 tokens</label>
                    <input v-model.number="editModelForm.max_output_tokens" type="number" min="1" />
                    <p class="field-hint">该模型一次最多输出多少 token</p>
                  </div>
                </div>

                <div class="model-edit-switches">
                  <label class="switch-label">
                    <input type="checkbox" v-model="editModelForm.supports_reasoning" />
                    <span>支持深度思考</span>
                  </label>
                  <p class="field-hint">是否输出深度思考过程</p>

                  <label class="switch-label">
                    <input type="checkbox" v-model="editModelForm.supports_tool_calling" />
                    <span>支持工具调用</span>
                  </label>
                  <p class="field-hint">是否支持调用工具（如搜索、画图）</p>

                  <label class="switch-label">
                    <input type="checkbox" v-model="editModelForm.supports_multimodal" />
                    <span>支持多模态</span>
                  </label>
                  <p class="field-hint">是否支持发送图片给模型</p>
                </div>

                <div v-if="modelEditError" class="add-error">{{ modelEditError }}</div>
                <div class="model-edit-actions">
                  <button class="mini-btn" @click="saveModelEdit">保存</button>
                  <button class="mini-btn secondary" @click="cancelModelEdit">取消</button>
                </div>
              </div>
            </div>
          </div>

          <!-- Add model form -->
          <div v-if="showAddManualModel" class="model-edit-form add-model-form">
            <div class="edit-section-title">添加模型</div>
            <label class="field-label">模型 ID *</label>
            <input v-model="newManualModel.id" placeholder="如 deepseek-v4-pro" />

            <label class="field-label">显示名称</label>
            <input v-model="newManualModel.display_name" placeholder="如 DeepSeek V4 Pro" />

            <label class="field-label">模型类型</label>
            <select v-model="newManualModel.model_type">
              <option value="llm">对话模型</option>
              <option value="embedding">Embedding</option>
              <option value="image">图片生成</option>
              <option value="stt">语音识别</option>
            </select>

            <div class="model-edit-row-2" v-if="newManualModel.model_type === 'llm'">
              <div>
                <label class="field-label">上下文窗口</label>
                <input v-model.number="newManualModel.context_window" type="number" min="1" />
                <p class="field-hint">该模型一次能处理的最大上下文长度（token 数）</p>
              </div>
              <div>
                <label class="field-label">最大输出 tokens</label>
                <input v-model.number="newManualModel.max_output_tokens" type="number" min="1" />
                <p class="field-hint">该模型一次最多输出多少 token</p>
              </div>
            </div>

            <div class="model-edit-switches">
              <label class="switch-label">
                <input type="checkbox" v-model="newManualModel.supports_reasoning" />
                <span>支持深度思考</span>
              </label>
              <p class="field-hint">是否输出深度思考过程</p>

              <label class="switch-label">
                <input type="checkbox" v-model="newManualModel.supports_tool_calling" />
                <span>支持工具调用</span>
              </label>
              <p class="field-hint">是否支持调用工具（如搜索、画图）</p>

              <label class="switch-label">
                <input type="checkbox" v-model="newManualModel.supports_multimodal" />
                <span>支持多模态</span>
              </label>
              <p class="field-hint">是否支持发送图片给模型</p>
            </div>

            <div v-if="manualAddError" class="add-error">{{ manualAddError }}</div>
            <div class="model-edit-actions">
              <button class="mini-btn" @click="submitManualAddModel">保存</button>
              <button class="mini-btn secondary" @click="cancelManualAddModel">取消</button>
            </div>
          </div>

          <button v-else class="model-add-inline" @click="showAddManualModel = true">+ 添加模型</button>
        </div>

        <div v-if="editError" class="add-error">{{ editError }}</div>

        <div class="modal-actions">
          <button @click="submitEdit">保存</button>
          <button class="secondary" @click="testAndDiscover">测试连接并发现模型</button>
          <button
            class="danger"
            :disabled="editProvider?.is_builtin"
            :title="editProvider?.is_builtin ? '内置 Provider 不可删除' : ''"
            @click="deleteCurrent"
          >断开</button>
          <button class="secondary" @click="closeEdit">取消</button>
        </div>
      </div>
    </div>

    <!-- Discover Models Modal -->
    <div v-if="discoverModal.open" class="modal-overlay" @click.self="discoverModal.open = false">
      <div class="modal-card edit-card discover-card" @click.stop>
        <h3>发现新模型</h3>
        <p class="hint-text" v-if="discoverModal.models.length">请确认各模型的类型与参数</p>
        <p class="hint-text" v-else-if="discoverModal.loading">正在拉取模型列表...</p>
        <p class="hint-text" v-else>未从该平台发现模型，请手动输入添加。</p>
        <div class="discover-list" v-if="discoverModal.models.length">
          <div v-for="m in discoverModal.models" :key="m.id" class="discover-item">
            <label class="discover-check">
              <input type="checkbox" v-model="m.selected" />
              <span class="discover-name">{{ m.display_name || m.id }}</span>
            </label>
            <div class="discover-fields">
              <div>
                <label>模型类型</label>
                <select v-model="m.model_type">
                  <option value="llm">对话模型</option>
                  <option value="embedding">Embedding</option>
                  <option value="image">图片生成</option>
                  <option value="stt">语音识别</option>
                </select>
              </div>
              <div>
                <label>上下文窗口</label>
                <input v-model.number="m.context_window" type="number" min="1" />
              </div>
              <div>
                <label>最大输出</label>
                <input v-model.number="m.max_output_tokens" type="number" min="1" />
              </div>
            </div>
          </div>
        </div>
        <div class="modal-actions">
          <button :disabled="!discoverModal.models.some((m: any) => m.selected) || discoverModal.importing" @click="importDiscovered">
            {{ discoverModal.importing ? '导入中...' : '一键导入' }}
          </button>
          <button class="secondary" @click="discoverModal.open = false">关闭</button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted, onBeforeUnmount, nextTick, computed } from 'vue'
import { useComputeStore } from '@/stores/compute'
import { api } from '@/api/client'
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
})
const editError = ref('')
const apiKeyInput = ref<HTMLInputElement>()

// Model management state inside edit modal
const editingModelId = ref<string | null>(null)
const editModelForm = ref({
  display_name: '',
  model_type: 'llm',
  context_window: 64000,
  max_output_tokens: 4096,
  supports_reasoning: false,
  supports_tool_calling: false,
  supports_multimodal: false,
})
const modelEditError = ref('')

const showAddManualModel = ref(false)
const newManualModel = ref({
  id: '',
  display_name: '',
  model_type: 'llm',
  context_window: 64000,
  max_output_tokens: 4096,
  supports_reasoning: false,
  supports_tool_calling: false,
  supports_multimodal: false,
})
const manualAddError = ref('')

const discoverModal = ref({
  open: false,
  loading: false,
  models: [] as any[],
  importing: false,
  providerId: '',
})

const todayTokens = ref(0)
const totalRemaining = ref(0)
const estDays = ref('--')

const groupedProviders = computed(() => store.groupByModelType(store.providers))

function typeLabel(t: string) {
  const map: Record<string, string> = {
    llm: '对话',
    embedding: 'Embedding',
    image: '图片',
    stt: '语音',
  }
  return map[t] || t
}

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

function openEdit(p: any, focusKey = false) {
  editProvider.value = p
  editForm.value = {
    display_name: p.display_name || '',
    base_url: p.base_url || '',
    api_key: '',
  }
  editError.value = ''
  cancelModelEdit()
  cancelManualAddModel()
  if (focusKey) {
    nextTick(() => {
      apiKeyInput.value?.focus()
    })
  }
}

function closeEdit() {
  editProvider.value = null
  editError.value = ''
  cancelModelEdit()
  cancelManualAddModel()
}

function startEditModel(m: any) {
  editingModelId.value = m.id
  editModelForm.value = {
    display_name: m.display_name || m.id || '',
    model_type: m.model_type || 'llm',
    context_window: m.context_window ?? 64000,
    max_output_tokens: m.max_output_tokens ?? 4096,
    supports_reasoning: !!m.supports_reasoning,
    supports_tool_calling: !!m.supports_tool_calling,
    supports_multimodal: !!m.supports_multimodal,
  }
  modelEditError.value = ''
}

function cancelModelEdit() {
  editingModelId.value = null
  modelEditError.value = ''
  editModelForm.value = {
    display_name: '',
    model_type: 'llm',
    context_window: 64000,
    max_output_tokens: 4096,
    supports_reasoning: false,
    supports_tool_calling: false,
    supports_multimodal: false,
  }
}

async function saveModelEdit() {
  modelEditError.value = ''
  if (!editProvider.value || !editingModelId.value) return

  if (!editModelForm.value.display_name.trim()) {
    modelEditError.value = '显示名称不能为空'
    return
  }
  if (editModelForm.value.model_type === 'llm') {
    if (!editModelForm.value.context_window || editModelForm.value.context_window < 1) {
      modelEditError.value = '上下文窗口必须大于 0'
      return
    }
    if (!editModelForm.value.max_output_tokens || editModelForm.value.max_output_tokens < 1) {
      modelEditError.value = '最大输出 tokens 必须大于 0'
      return
    }
  }

  try {
    const body: any = {
      display_name: editModelForm.value.display_name,
      model_type: editModelForm.value.model_type,
      supports_reasoning: editModelForm.value.supports_reasoning,
      supports_tool_calling: editModelForm.value.supports_tool_calling,
      supports_multimodal: editModelForm.value.supports_multimodal,
    }
    if (editModelForm.value.model_type === 'llm') {
      body.context_window = editModelForm.value.context_window
      body.max_output_tokens = editModelForm.value.max_output_tokens
    } else {
      body.context_window = null
      body.max_output_tokens = null
    }
    const res = await store.updateModel(editProvider.value.id, editingModelId.value, body)
    if (res.code !== 0 && res.code !== undefined) {
      modelEditError.value = res.message || '保存失败'
      return
    }
    cancelModelEdit()
  } catch (e: any) {
    modelEditError.value = e?.message || '保存失败'
  }
}

async function removeModel(m: any) {
  if (!editProvider.value) return
  if (!confirm(`确定要删除模型「${m.display_name || m.id}」吗？`)) return
  try {
    await store.deleteModel(editProvider.value.id, m.id)
    if (editingModelId.value === m.id) {
      cancelModelEdit()
    }
  } catch (e) {
    console.error('Delete model failed', e)
    alert('删除失败')
  }
}

function cancelManualAddModel() {
  showAddManualModel.value = false
  manualAddError.value = ''
  newManualModel.value = {
    id: '',
    display_name: '',
    model_type: 'llm',
    context_window: 64000,
    max_output_tokens: 4096,
    supports_reasoning: false,
    supports_tool_calling: false,
    supports_multimodal: false,
  }
}

async function submitManualAddModel() {
  manualAddError.value = ''
  if (!editProvider.value) return

  const id = newManualModel.value.id.trim()
  if (!id) {
    manualAddError.value = '模型 ID 不能为空'
    return
  }

  const exists = editProvider.value.models?.some((m: any) => m.id === id)
  if (exists) {
    manualAddError.value = '模型 ID 已存在'
    return
  }

  if (newManualModel.value.model_type === 'llm') {
    if (!newManualModel.value.context_window || newManualModel.value.context_window < 1) {
      manualAddError.value = '上下文窗口必须大于 0'
      return
    }
    if (!newManualModel.value.max_output_tokens || newManualModel.value.max_output_tokens < 1) {
      manualAddError.value = '最大输出 tokens 必须大于 0'
      return
    }
  }

  try {
    const body: any = {
      provider_id: editProvider.value.id,
      id,
      display_name: newManualModel.value.display_name.trim() || id,
      model_type: newManualModel.value.model_type,
      supports_reasoning: newManualModel.value.supports_reasoning,
      supports_tool_calling: newManualModel.value.supports_tool_calling,
      supports_multimodal: newManualModel.value.supports_multimodal,
    }
    if (newManualModel.value.model_type === 'llm') {
      body.context_window = newManualModel.value.context_window
      body.max_output_tokens = newManualModel.value.max_output_tokens
    }
    const res = await store.addModel(body)
    if (res.code !== 0 && res.code !== undefined) {
      manualAddError.value = res.message || '添加失败'
      return
    }
    cancelManualAddModel()
  } catch (e: any) {
    manualAddError.value = e?.message || '添加失败'
  }
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

async function testAndDiscover() {
  if (!editProvider.value) return
  discoverModal.value = {
    open: true,
    loading: true,
    models: [],
    importing: false,
    providerId: editProvider.value.id,
  }
  try {
    const res = await store.testConnection(editProvider.value.id)
    const discovered = res.data?.discovered_models || []
    discoverModal.value.models = discovered.map((item: any) => ({
      id: item.id || item,
      display_name: item.id || item,
      model_type: item.type_hint || 'llm',
      selected: true,
      context_window: 64000,
      max_output_tokens: 4096,
    }))
  } catch (e) {
    console.error('Discover failed', e)
  } finally {
    discoverModal.value.loading = false
  }
}

async function importDiscovered() {
  const selected = discoverModal.value.models.filter((m: any) => m.selected)
  if (!selected.length) return
  discoverModal.value.importing = true
  try {
    for (const m of selected) {
      const body: any = {
        provider_id: discoverModal.value.providerId,
        id: m.id,
        display_name: m.display_name || m.id,
        model_type: m.model_type,
        supports_reasoning: false,
        supports_tool_calling: false,
        supports_multimodal: false,
      }
      if (m.model_type === 'llm') {
        body.context_window = m.context_window
        body.max_output_tokens = m.max_output_tokens
      }
      await store.addModel(body)
    }
    discoverModal.value.open = false
    await store.fetchProviders(true)
  } catch (e) {
    console.error('Import failed', e)
    alert('导入失败')
  } finally {
    discoverModal.value.importing = false
  }
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
    provider_type: 'openai',
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

.cc-groups { flex: 1; overflow-y: auto; padding: 0 20px; display: flex; flex-direction: column; gap: 20px; }
.cc-group-header { display: flex; align-items: center; gap: 8px; margin-bottom: 10px; }
.cc-group-icon { font-size: 16px; }
.cc-group-label { font-size: 14px; color: #D8E1EC; font-weight: 500; }

.cc-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(260px, 1fr)); gap: 12px; align-content: start; }
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
.modal-card.edit-card { width: 520px; max-height: 80vh; display: flex; flex-direction: column; }
.modal-card h3 { margin: 0 0 16px; font-size: 16px; color: #D8E1EC; }
.field-label { display: block; font-size: 12px; color: #8899AA; margin: 12px 0 4px; }
.field-hint { font-size: 11px; color: #5A6A7A; margin: 4px 0 8px; }
.modal-card input, .modal-card select { width: 100%; margin: 4px 0 8px; padding: 10px; background: #0B0F17; border: 1px solid #1E2731; border-radius: 6px; color: #D8E1EC; box-sizing: border-box; }
.modal-card input:focus, .modal-card select:focus { outline: none; border-color: #00E5C9; }
.add-error { padding: 8px 10px; background: rgba(239,68,68,0.1); color: #EF4444; border-radius: 6px; font-size: 13px; margin: 8px 0; }
.modal-actions { display: flex; gap: 10px; margin-top: 16px; flex-wrap: wrap; }
.modal-actions button { flex: 1; padding: 10px; background: #00E5C9; color: #0B0F17; border: none; border-radius: 6px; cursor: pointer; font-weight: 600; min-width: 80px; }
.modal-actions button.secondary { background: transparent; border: 1px solid #1E2731; color: #8899AA; }
.modal-actions button.danger { background: rgba(239,68,68,0.15); border: 1px solid rgba(239,68,68,0.4); color: #EF4444; }
.modal-actions button.danger:disabled { opacity: 0.4; cursor: not-allowed; }

.cc-key-warning { padding: 2px 8px; background: rgba(255,184,0,0.12); border: 1px solid rgba(255,184,0,0.3); border-radius: 4px; font-size: 11px; color: #FFB800; cursor: pointer; }
.cc-key-warning:hover { background: rgba(255,184,0,0.2); }

.edit-section { margin-top: 16px; padding-top: 12px; border-top: 1px solid rgba(255,255,255,0.06); overflow-y: auto; max-height: 360px; }
.edit-section-title { font-size: 13px; color: #8899AA; margin-bottom: 10px; }
.hint-text { font-size: 12px; color: #5A6A7A; margin: 8px 0; }

/* Model table */
.model-table { display: flex; flex-direction: column; gap: 6px; margin-bottom: 10px; }
.model-table-header,
.model-table-cells { display: grid; grid-template-columns: 1.4fr 0.7fr 0.9fr 0.9fr 80px 100px; gap: 8px; align-items: center; padding: 6px 8px; }
.model-table-header { font-size: 11px; color: #8899AA; background: rgba(255,255,255,0.03); border-radius: 6px; }
.model-table-row { background: #0B0F17; border: 1px solid #1E2731; border-radius: 6px; display: flex; flex-direction: column; }
.model-table-cells { font-size: 12px; color: #D8E1EC; }
.col-name { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.col-type { color: #8899AA; font-size: 11px; }
.col-ctx, .col-out { color: #8899AA; }
.col-caps { display: flex; gap: 4px; }
.col-ops { display: flex; gap: 6px; }
.table-action { padding: 3px 8px; background: rgba(0,229,201,0.08); border: 1px solid rgba(0,229,201,0.2); border-radius: 4px; color: #00E5C9; font-size: 11px; cursor: pointer; }
.table-action:hover { background: rgba(0,229,201,0.15); }
.table-action.danger { background: rgba(239,68,68,0.1); border-color: rgba(239,68,68,0.3); color: #EF4444; }
.table-action.danger:hover { background: rgba(239,68,68,0.18); }

/* Inline model edit form */
.model-edit-form { padding: 12px; background: rgba(255,255,255,0.02); border-top: 1px solid rgba(255,255,255,0.04); }
.model-edit-row-2 { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
.model-edit-switches { display: flex; flex-direction: column; gap: 8px; margin: 8px 0; }
.switch-label { display: flex; align-items: center; gap: 8px; font-size: 12px; color: #D8E1EC; cursor: pointer; }
.switch-label input { width: auto; margin: 0; }
.model-edit-actions { display: flex; gap: 8px; margin-top: 10px; }
.model-edit-actions .mini-btn { flex: none; }

.mini-btn { padding: 8px 14px; background: rgba(0,229,201,0.12); border: 1px solid rgba(0,229,201,0.25); border-radius: 6px; color: #00E5C9; font-size: 12px; cursor: pointer; font-weight: 500; }
.mini-btn:hover { background: rgba(0,229,201,0.18); }
.mini-btn.secondary { background: transparent; border: 1px solid #1E2731; color: #8899AA; }
.mini-btn.secondary:hover { border-color: rgba(255,255,255,0.2); color: #D8E1EC; }
.mini-btn:disabled { opacity: 0.4; cursor: not-allowed; }

.model-add-inline { width: 100%; padding: 8px; background: rgba(0,229,201,0.05); border: 1px dashed rgba(0,229,201,0.25); border-radius: 6px; color: #00E5C9; font-size: 12px; cursor: pointer; }
.model-add-inline:hover { background: rgba(0,229,201,0.1); }
.add-model-form { background: rgba(0,229,201,0.03); border: 1px dashed rgba(0,229,201,0.2); border-radius: 8px; margin-top: 8px; }

/* Discover modal */
.discover-card { overflow-y: auto; }
.discover-list { display: flex; flex-direction: column; gap: 10px; max-height: 380px; overflow-y: auto; margin: 12px 0; }
.discover-item { display: flex; flex-direction: column; gap: 8px; padding: 10px; background: #0B0F17; border-radius: 6px; }
.discover-check { display: flex; align-items: center; gap: 8px; cursor: pointer; }
.discover-check input { width: auto; margin: 0; }
.discover-name { font-size: 13px; color: #D8E1EC; }
.discover-fields { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 12px; padding-left: 24px; }
.discover-fields label { font-size: 11px; color: #8899AA; display: block; margin-bottom: 2px; }
.discover-fields input, .discover-fields select { width: 100%; padding: 6px 8px; background: #141B24; border: 1px solid #1E2731; border-radius: 4px; color: #D8E1EC; font-size: 12px; box-sizing: border-box; }
.discover-fields input:focus, .discover-fields select:focus { outline: none; border-color: #00E5C9; }

.cc-provider-actions { margin-top: 8px; }
.cc-action-link { padding: 4px 10px; background: transparent; border: 1px solid rgba(0,229,201,0.2); border-radius: 4px; color: #00E5C9; font-size: 11px; cursor: pointer; }
.cc-action-link:hover { background: rgba(0,229,201,0.08); }

.cap-tag {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 18px;
  height: 18px;
  border-radius: 4px;
  font-size: 10px;
  color: #00E5C9;
  background: rgba(0, 229, 201, 0.1);
  border: 1px solid rgba(0, 229, 201, 0.25);
  cursor: help;
}
</style>
