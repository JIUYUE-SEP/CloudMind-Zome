<template>
  <div class="model-selector">
    <div class="field-row">
      <label>Provider</label>
      <select :value="providerId ?? ''" @change="onProviderChange">
        <option v-if="allowEmpty" value="">{{ emptyLabel }}</option>
        <option v-else value="">请选择 Provider</option>
        <option v-for="p in providers" :key="p.id" :value="p.id">
          {{ p.display_name }}
        </option>
      </select>
      <p class="hint">选择提供该模型的服务商，如 DeepSeek 官方、SiliconFlow 等</p>
    </div>

    <div class="field-row" v-if="providerId">
      <label>模型</label>
      <select :value="modelId ?? ''" @change="onModelChange">
        <option value="">请选择模型</option>
        <option v-for="m in currentModels" :key="m.id" :value="m.id">
          {{ m.display_name }}
          <span v-if="m.supports_reasoning" class="cap-tag" title="支持深度思考">思</span>
          <span v-if="m.supports_tool_calling" class="cap-tag" title="支持工具调用">工</span>
          <span v-if="m.supports_multimodal" class="cap-tag" title="支持多模态">图</span>
        </option>
      </select>
      <p class="hint" v-if="currentModel">
        <template v-if="currentModel.model_type === 'llm'">
          上下文窗口：{{ currentModel.context_window?.toLocaleString() ?? '-' }} tokens，
          最大输出：{{ currentModel.max_output_tokens?.toLocaleString() ?? '-' }} tokens
          <span v-if="currentModel.supports_reasoning" class="cap-tag" title="支持深度思考">思</span>
          <span v-if="currentModel.supports_tool_calling" class="cap-tag" title="支持工具调用">工</span>
          <span v-if="currentModel.supports_multimodal" class="cap-tag" title="支持多模态">图</span>
        </template>
        <template v-else-if="currentModel.model_type === 'embedding'">
          向量嵌入模型 · 用于语义搜索
        </template>
        <template v-else-if="currentModel.model_type === 'image'">
          图片生成模型 · 用于 AI 生图
        </template>
        <template v-else-if="currentModel.model_type === 'stt'">
          语音识别模型 · 用于音频转文字
        </template>
      </p>
      <p class="hint" v-else-if="props.modelType && !providers.length">
        暂无可用模型，请前往算力中枢添加对应类型模型
      </p>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { useComputeStore } from '@/stores/compute'

const props = withDefaults(defineProps<{
  providerId: string | null
  modelId: string | null
  modelType?: 'llm' | 'embedding' | 'image' | 'stt' | null
  allowEmpty?: boolean
  emptyLabel?: string
}>(), {
  allowEmpty: false,
  emptyLabel: '未配置',
  modelType: null,
})

const emit = defineEmits<{
  'update:providerId': [v: string | null]
  'update:modelId': [v: string | null]
}>()

const store = useComputeStore()

const providers = computed(() => {
  if (!props.modelType) return store.providers
  return store.providers
    .map(p => ({
      ...p,
      models: (p.models || []).filter(m => m.model_type === props.modelType)
    }))
    .filter(p => p.models.length > 0)
})

const currentModels = computed(() => {
  if (!props.providerId) return []
  const prov = providers.value.find(p => p.id === props.providerId)
  return prov?.models || []
})

const currentModel = computed(() => {
  if (!props.providerId || !props.modelId) return undefined
  return store.getModelInfo(props.providerId, props.modelId)
})

function onProviderChange(e: Event) {
  const val = (e.target as HTMLSelectElement).value
  emit('update:providerId', val || null)
  if (!val) {
    emit('update:modelId', null)
    return
  }
  // Auto-select first model from filtered list
  const prov = providers.value.find(p => p.id === val)
  emit('update:modelId', prov?.models?.[0]?.id || null)
}

function onModelChange(e: Event) {
  const val = (e.target as HTMLSelectElement).value
  emit('update:modelId', val || null)
}
</script>

<style scoped>
.model-selector {
  display: flex;
  flex-direction: column;
  gap: 10px;
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
.field-row select {
  width: 100%;
  padding: 10px;
  background: #141b24;
  border: 1px solid #1e2731;
  border-radius: 8px;
  color: #d8e1ec;
  font-size: 13px;
  box-sizing: border-box;
}
.field-row select:focus {
  outline: none;
  border-color: rgba(0, 229, 201, 0.4);
}
.hint {
  font-size: 11px;
  color: #5a6a7a;
  margin: 0;
}

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
