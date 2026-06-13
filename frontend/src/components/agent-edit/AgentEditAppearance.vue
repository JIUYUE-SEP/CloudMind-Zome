<template>
  <div class="ae-panel-section">
    <label class="ae-label">立绘 / 封面图</label>
    <ImageUploader :url="agent.portrait_url || ''" @update:url="update('portrait_url', $event)" />

    <label class="ae-label">3D 模型 (VRM)</label>
    <ImageUploader :url="agent.model_url || ''" @update:url="update('model_url', $event)" />

    <label class="ae-label">Live2D 模型 URL</label>
    <input
      class="ae-input"
      :value="agent.live2d_model_url || ''"
      placeholder="https://..."
      @input="update('live2d_model_url', ($event.target as HTMLInputElement).value)"
    />
  </div>
</template>

<script setup lang="ts">
import ImageUploader from '@/components/ui/ImageUploader.vue'

interface AgentAppearance {
  portrait_url?: string
  model_url?: string
  live2d_model_url?: string
}

const props = defineProps<{
  agent: AgentAppearance
  loading?: boolean
}>()

const emit = defineEmits<{
  'update:agent': [data: Partial<AgentAppearance>]
  save: [field: string]
  reset: [field: string]
}>()

function update(field: keyof AgentAppearance, value: any) {
  emit('update:agent', { [field]: value })
}
</script>

<style scoped>
@import '@/styles/agent-edit.css';
</style>
