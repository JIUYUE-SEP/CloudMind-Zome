<template>
  <div class="ae-panel-section">
    <ComputeTab
      v-model:provider-id="local.provider_id"
      v-model:model-id="local.model_id"
      v-model:temperature="local.temperature"
      v-model:top-p="local.top_p"
      v-model:use-independent-marker="local.useIndependentMarker"
      v-model:marker-provider-id="local.marker_provider_id"
      v-model:marker-model-id="local.marker_model_id"
      v-model:embedder-provider-id="local.embedder_provider_id"
      v-model:embedder-model-id="local.embedder_model_id"
      v-model:use-independent-compressor="local.useIndependentCompressor"
      v-model:compressor-provider-id="local.compressor_provider_id"
      v-model:compressor-model-id="local.compressor_model_id"
      v-model:imagegen-provider-id="local.imagegen_provider_id"
      v-model:imagegen-model-id="local.imagegen_model_id"
      v-model:fallback-chain="local.fallbackChain"
    />
  </div>
</template>

<script setup lang="ts">
import { reactive, watch } from 'vue'
import ComputeTab from '@/components/ComputeTab.vue'

interface AgentModelData {
  provider_id: string | null
  model_id: string | null
  temperature: number | null
  top_p: number | null
  useIndependentMarker: boolean
  marker_provider_id: string | null
  marker_model_id: string | null
  embedder_provider_id: string | null
  embedder_model_id: string | null
  useIndependentCompressor: boolean
  compressor_provider_id: string | null
  compressor_model_id: string | null
  imagegen_provider_id: string | null
  imagegen_model_id: string | null
  fallbackChain: { provider_id: string; model_id: string; display_name?: string }[]
}

const props = defineProps<{
  agent: AgentModelData
  loading?: boolean
}>()

const emit = defineEmits<{
  'update:agent': [data: Partial<AgentModelData>]
  save: [field: string]
  reset: [field: string]
}>()

const local = reactive<AgentModelData>({
  provider_id: props.agent.provider_id ?? null,
  model_id: props.agent.model_id ?? null,
  temperature: props.agent.temperature ?? null,
  top_p: props.agent.top_p ?? null,
  useIndependentMarker: props.agent.useIndependentMarker ?? false,
  marker_provider_id: props.agent.marker_provider_id ?? null,
  marker_model_id: props.agent.marker_model_id ?? null,
  embedder_provider_id: props.agent.embedder_provider_id ?? null,
  embedder_model_id: props.agent.embedder_model_id ?? null,
  useIndependentCompressor: props.agent.useIndependentCompressor ?? false,
  compressor_provider_id: props.agent.compressor_provider_id ?? null,
  compressor_model_id: props.agent.compressor_model_id ?? null,
  imagegen_provider_id: props.agent.imagegen_provider_id ?? null,
  imagegen_model_id: props.agent.imagegen_model_id ?? null,
  fallbackChain: props.agent.fallbackChain ? [...props.agent.fallbackChain] : [],
})

watch(local, (v) => {
  emit('update:agent', {
    provider_id: v.provider_id,
    model_id: v.model_id,
    temperature: v.temperature,
    top_p: v.top_p,
    useIndependentMarker: v.useIndependentMarker,
    marker_provider_id: v.marker_provider_id,
    marker_model_id: v.marker_model_id,
    embedder_provider_id: v.embedder_provider_id,
    embedder_model_id: v.embedder_model_id,
    useIndependentCompressor: v.useIndependentCompressor,
    compressor_provider_id: v.compressor_provider_id,
    compressor_model_id: v.compressor_model_id,
    imagegen_provider_id: v.imagegen_provider_id,
    imagegen_model_id: v.imagegen_model_id,
    fallbackChain: v.fallbackChain,
  })
}, { deep: true })

watch(() => props.agent, (a) => {
  local.provider_id = a.provider_id ?? null
  local.model_id = a.model_id ?? null
  local.temperature = a.temperature ?? null
  local.top_p = a.top_p ?? null
  local.useIndependentMarker = a.useIndependentMarker ?? false
  local.marker_provider_id = a.marker_provider_id ?? null
  local.marker_model_id = a.marker_model_id ?? null
  local.embedder_provider_id = a.embedder_provider_id ?? null
  local.embedder_model_id = a.embedder_model_id ?? null
  local.useIndependentCompressor = a.useIndependentCompressor ?? false
  local.compressor_provider_id = a.compressor_provider_id ?? null
  local.compressor_model_id = a.compressor_model_id ?? null
  local.imagegen_provider_id = a.imagegen_provider_id ?? null
  local.imagegen_model_id = a.imagegen_model_id ?? null
  local.fallbackChain = a.fallbackChain ? [...a.fallbackChain] : []
}, { deep: true })
</script>

<style scoped>
@import '@/styles/agent-edit.css';
</style>
