<template>
  <div class="compute-tab">
    <!-- 无模型或仅内置空 Key 模板时的引导 -->
    <div v-if="!hasAnyModel" class="no-model-banner">
      <div class="no-model-title">⚠️ 当前没有可用模型</div>
      <div class="no-model-desc">
        请先前往算力中心配置 Provider，添加可用的对话模型与嵌入模型后，Agent 才能正常工作。
      </div>
      <button class="no-model-action" @click="goToComputeCenter">前往算力中心</button>
    </div>
    <div v-else-if="onlyBuiltInEmptyKey" class="no-model-banner warning">
      <div class="no-model-title">⚠️ 内置 Provider 尚未配置 API Key</div>
      <div class="no-model-desc">
        当前只有内置的 OpenAI Compatible 模板且未填写 API Key。请前往算力中心配置真实的 API Key。
      </div>
      <button class="no-model-action" @click="goToComputeCenter">前往算力中心配置</button>
    </div>

    <!-- 主推理模型 -->
    <div class="section">
      <label>推理模型（主模型）</label>
      <ModelSelector
        :provider-id="providerId"
        :model-id="modelId"
        model-type="llm"
        @update:provider-id="$emit('update:providerId', $event)"
        @update:model-id="$emit('update:modelId', $event)"
      />
    </div>

    <!-- temperature -->
    <div class="field-row">
      <div class="slider-header">
        <label>temperature</label>
        <span class="slider-value">{{ temperature !== null ? temperature.toFixed(2) : '默认' }}</span>
      </div>
      <input
        type="range"
        min="0"
        max="2"
        step="0.1"
        :value="temperature ?? 1"
        @input="$emit('update:temperature', parseFloat(($event.target as HTMLInputElement).value))"
      />
      <p class="hint">控制输出随机性，0 更确定，2 更有创意</p>
    </div>

    <!-- top_p -->
    <div class="field-row">
      <div class="slider-header">
        <label>top_p</label>
        <span class="slider-value">{{ topP !== null ? topP.toFixed(2) : '默认' }}</span>
      </div>
      <input
        type="range"
        min="0"
        max="1"
        step="0.05"
        :value="topP ?? 1"
        @input="$emit('update:topP', parseFloat(($event.target as HTMLInputElement).value))"
      />
      <p class="hint">核采样阈值，通常保持 1，与 temperature 二选一即可</p>
    </div>

    <div class="sep" />

    <!-- 独立 Marker -->
    <label class="checkbox-label">
      <input type="checkbox" :checked="useIndependentMarker" @change="$emit('update:useIndependentMarker', ($event.target as HTMLInputElement).checked)" />
      使用独立标注模型
    </label>
    <div v-if="useIndependentMarker" class="sub-config">
      <ModelSelector
        :provider-id="markerProviderId"
        :model-id="markerModelId"
        model-type="llm"
        @update:provider-id="$emit('update:markerProviderId', $event)"
        @update:model-id="$emit('update:markerModelId', $event)"
      />
      <p class="hint">话题边界标注专用模型，默认与主模型相同</p>
    </div>

    <div class="sep" />

    <!-- Embedder（必填） -->
    <div class="section">
      <label>嵌入模型（语义搜索）<span class="required">*</span></label>
      <ModelSelector
        :provider-id="embedderProviderId"
        :model-id="embedderModelId"
        model-type="embedding"
        @update:provider-id="$emit('update:embedderProviderId', $event)"
        @update:model-id="$emit('update:embedderModelId', $event)"
      />
      <p class="hint">语义记忆搜索使用的向量模型。不同 Agent 可独立配置，要求 OpenAI 兼容 /v1/embeddings 格式。</p>
    </div>

    <div class="sep" />

    <!-- 独立 Compressor -->
    <label class="checkbox-label">
      <input type="checkbox" :checked="useIndependentCompressor" @change="$emit('update:useIndependentCompressor', ($event.target as HTMLInputElement).checked)" />
      使用独立压缩模型
    </label>
    <div v-if="useIndependentCompressor" class="sub-config">
      <ModelSelector
        :provider-id="compressorProviderId"
        :model-id="compressorModelId"
        model-type="llm"
        @update:provider-id="$emit('update:compressorProviderId', $event)"
        @update:model-id="$emit('update:compressorModelId', $event)"
      />
      <p class="hint">历史记忆压缩专用模型，默认与主模型相同</p>
    </div>

    <div class="sep" />

    <!-- ImageGen（可选） -->
    <div class="section">
      <label>图像生成模型</label>
      <ModelSelector
        :provider-id="imagegenProviderId"
        :model-id="imagegenModelId"
        model-type="image"
        allow-empty
        empty-label="未配置"
        @update:provider-id="$emit('update:imagegenProviderId', $event)"
        @update:model-id="$emit('update:imagegenModelId', $event)"
      />
      <p class="hint">AI 生图工具调用的模型，支持 OpenAI DALL-E 格式或 DashScope 格式。不配置则生图工具返回"未配置"。</p>
    </div>

    <div class="sep" />

    <!-- Fallback Chain -->
    <div class="section">
      <label>降级链（Fallback Chain）</label>
      <p class="hint">当主模型不可用时，按以下顺序尝试其他模型</p>
      <div class="fallback-list">
        <div
          v-for="(item, idx) in fallbackChain"
          :key="idx"
          class="fallback-item"
          draggable="true"
          @dragstart="onDragStart($event, idx)"
          @dragover.prevent="onDragOver($event, idx)"
          @drop="onDrop($event, idx)"
        >
          <span class="fallback-index">{{ idx + 1 }}</span>
          <span class="fallback-text">
            {{ getModelDisplay(item.provider_id, item.model_id) }}
            @ {{ getProviderDisplay(item.provider_id) }}
          </span>
          <button class="fallback-up" :disabled="idx === 0" @click="moveFallback(idx, -1)">↑</button>
          <button class="fallback-down" :disabled="idx === fallbackChain.length - 1" @click="moveFallback(idx, 1)">↓</button>
          <button class="fallback-remove" @click="removeFallback(idx)">×</button>
        </div>
        <button class="fallback-add" @click="showFallbackModal = true">+ 添加降级模型</button>
      </div>
    </div>

    <!-- Fallback Add Modal -->
    <div v-if="showFallbackModal" class="modal-overlay" @click.self="showFallbackModal = false">
      <div class="modal-card" @click.stop>
        <h3>选择降级模型</h3>
        <ModelSelector
          :provider-id="fallbackTemp.provider_id"
          :model-id="fallbackTemp.model_id"
          model-type="llm"
          @update:provider-id="fallbackTemp.provider_id = $event ?? ''"
          @update:model-id="fallbackTemp.model_id = $event ?? ''"
        />
        <div class="modal-actions">
          <button :disabled="!fallbackTemp.provider_id || !fallbackTemp.model_id" @click="confirmAddFallback">添加</button>
          <button class="secondary" @click="showFallbackModal = false">取消</button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed } from 'vue'
import { useRouter } from 'vue-router'
import ModelSelector from './ModelSelector.vue'
import { useComputeStore } from '@/stores/compute'

export interface FallbackNode {
  provider_id: string
  model_id: string
  display_name?: string
}

const props = defineProps<{
  providerId: string | null
  modelId: string | null
  temperature: number | null
  topP: number | null
  useIndependentMarker: boolean
  markerProviderId: string | null
  markerModelId: string | null
  embedderProviderId: string | null
  embedderModelId: string | null
  useIndependentCompressor: boolean
  compressorProviderId: string | null
  compressorModelId: string | null
  imagegenProviderId: string | null
  imagegenModelId: string | null
  fallbackChain: FallbackNode[]
}>()

const emit = defineEmits<{
  'update:providerId': [v: string | null]
  'update:modelId': [v: string | null]
  'update:temperature': [v: number | null]
  'update:topP': [v: number | null]
  'update:useIndependentMarker': [v: boolean]
  'update:markerProviderId': [v: string | null]
  'update:markerModelId': [v: string | null]
  'update:embedderProviderId': [v: string | null]
  'update:embedderModelId': [v: string | null]
  'update:useIndependentCompressor': [v: boolean]
  'update:compressorProviderId': [v: string | null]
  'update:compressorModelId': [v: string | null]
  'update:imagegenProviderId': [v: string | null]
  'update:imagegenModelId': [v: string | null]
  'update:fallbackChain': [v: FallbackNode[]]
}>()

const store = useComputeStore()
const router = useRouter()
const showFallbackModal = ref(false)

const hasAnyModel = computed(() =>
  store.providers.some((p) => (p.models || []).length > 0)
)

const onlyBuiltInEmptyKey = computed(() => {
  if (!store.providers.length) return false
  return store.providers.every(
    (p) => p.is_builtin && !p.has_api_key
  )
})

function goToComputeCenter() {
  router.push('/compute')
}
const fallbackTemp = ref({ provider_id: '', model_id: '' })

const providers = computed(() => store.providers)

function getProviderDisplay(providerId: string): string {
  const p = store.getProviderById(providerId)
  return p?.display_name || providerId || '未知'
}

function getModelDisplay(providerId: string, modelId: string): string {
  const m = store.getModelInfo(providerId, modelId)
  return m?.display_name || modelId || '未知'
}

function moveFallback(idx: number, dir: number) {
  const arr = [...props.fallbackChain]
  const target = idx + dir
  if (target < 0 || target >= arr.length) return
  const tmp = arr[idx]
  arr[idx] = arr[target]
  arr[target] = tmp
  emit('update:fallbackChain', arr)
}

function removeFallback(idx: number) {
  const arr = [...props.fallbackChain]
  arr.splice(idx, 1)
  emit('update:fallbackChain', arr)
}

function confirmAddFallback() {
  if (!fallbackTemp.value.provider_id || !fallbackTemp.value.model_id) return
  const arr = [...props.fallbackChain]
  arr.push({
    provider_id: fallbackTemp.value.provider_id,
    model_id: fallbackTemp.value.model_id,
    display_name: getModelDisplay(fallbackTemp.value.provider_id, fallbackTemp.value.model_id),
  })
  emit('update:fallbackChain', arr)
  fallbackTemp.value = { provider_id: '', model_id: '' }
  showFallbackModal.value = false
}

// Drag and drop
const dragIndex = ref<number | null>(null)

function onDragStart(e: DragEvent, idx: number) {
  dragIndex.value = idx
  if (e.dataTransfer) {
    e.dataTransfer.effectAllowed = 'move'
    e.dataTransfer.setData('text/plain', String(idx))
  }
}

function onDragOver(e: DragEvent, _idx: number) {
  if (e.dataTransfer) e.dataTransfer.dropEffect = 'move'
}

function onDrop(e: DragEvent, toIndex: number) {
  const fromIndex = Number(e.dataTransfer?.getData('text/plain'))
  if (isNaN(fromIndex) || fromIndex === toIndex) return
  const arr = [...props.fallbackChain]
  const item = arr.splice(fromIndex, 1)[0]
  arr.splice(toIndex, 0, item)
  emit('update:fallbackChain', arr)
  dragIndex.value = null
}
</script>

<style scoped>
.compute-tab {
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.no-model-banner {
  padding: 12px;
  background: rgba(239, 68, 68, 0.08);
  border: 1px solid rgba(239, 68, 68, 0.25);
  border-radius: 8px;
}
.no-model-banner.warning {
  background: rgba(255, 184, 0, 0.08);
  border-color: rgba(255, 184, 0, 0.25);
}
.no-model-title {
  font-size: 13px;
  font-weight: 600;
  color: #ef4444;
  margin-bottom: 4px;
}
.no-model-banner.warning .no-model-title {
  color: #ffb800;
}
.no-model-desc {
  font-size: 11px;
  color: #8899aa;
  line-height: 1.5;
  margin-bottom: 8px;
}
.no-model-action {
  padding: 6px 12px;
  background: rgba(0, 229, 201, 0.1);
  border: 1px solid rgba(0, 229, 201, 0.25);
  border-radius: 6px;
  color: #00e5c9;
  font-size: 12px;
  cursor: pointer;
}
.no-model-action:hover {
  background: rgba(0, 229, 201, 0.18);
}
.section {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.section > label {
  font-size: 12px;
  color: #8899aa;
}
.required {
  color: #ef4444;
  margin-left: 4px;
}
.field-row {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.field-row label {
  font-size: 12px;
  color: #8899aa;
}
.slider-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
}
.slider-value {
  font-size: 12px;
  color: #00e5c9;
  font-family: monospace;
}
input[type='range'] {
  width: 100%;
  margin: 4px 0;
}
.hint {
  font-size: 11px;
  color: #5a6a7a;
  margin: 0;
}
.checkbox-label {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
  color: #d8e1ec;
  cursor: pointer;
}
.checkbox-label input[type='checkbox'] {
  width: auto;
}
.sub-config {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding-left: 16px;
  border-left: 2px solid rgba(0, 229, 201, 0.15);
}
.sep {
  height: 1px;
  background: rgba(255, 255, 255, 0.06);
  margin: 4px 0;
}

/* Fallback list */
.fallback-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.fallback-item {
  display: flex;
  align-items: center;
  gap: 6px;
  background: #0b0f17;
  border: 1px solid #1e2731;
  border-radius: 8px;
  padding: 8px;
}
.fallback-index {
  width: 20px;
  text-align: center;
  font-size: 11px;
  color: #00e5c9;
  font-weight: 600;
}
.fallback-text {
  flex: 1;
  font-size: 12px;
  color: #d8e1ec;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.fallback-up,
.fallback-down,
.fallback-remove {
  width: 24px;
  height: 24px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: transparent;
  border: 1px solid #1e2731;
  border-radius: 4px;
  color: #8899aa;
  font-size: 11px;
  cursor: pointer;
}
.fallback-up:hover,
.fallback-down:hover {
  border-color: rgba(0, 229, 201, 0.3);
  color: #00e5c9;
}
.fallback-remove:hover {
  border-color: rgba(239, 68, 68, 0.3);
  color: #ef4444;
}
.fallback-up:disabled,
.fallback-down:disabled {
  opacity: 0.3;
  cursor: not-allowed;
}
.fallback-add {
  padding: 8px;
  background: rgba(0, 229, 201, 0.08);
  border: 1px dashed rgba(0, 229, 201, 0.25);
  border-radius: 6px;
  color: #00e5c9;
  font-size: 12px;
  cursor: pointer;
}
.fallback-add:hover {
  background: rgba(0, 229, 201, 0.12);
}

/* Modal */
.modal-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.7);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1000;
}
.modal-card {
  width: 420px;
  padding: 24px;
  background: rgba(20, 27, 36, 0.98);
  border: 1px solid rgba(0, 229, 201, 0.2);
  border-radius: 12px;
}
.modal-card h3 {
  margin: 0 0 16px;
  font-size: 16px;
  color: #d8e1ec;
}
.modal-actions {
  display: flex;
  gap: 10px;
  margin-top: 16px;
}
.modal-actions button {
  flex: 1;
  padding: 10px;
  background: #00e5c9;
  color: #0b0f17;
  border: none;
  border-radius: 6px;
  font-weight: 600;
  font-size: 12px;
  cursor: pointer;
}
.modal-actions button.secondary {
  background: transparent;
  border: 1px solid #1e2731;
  color: #8899aa;
}
.modal-actions button:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}
</style>
