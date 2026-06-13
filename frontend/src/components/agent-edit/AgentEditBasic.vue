<template>
  <div class="ae-panel-section">
    <label class="ae-label">名称</label>
    <input class="ae-input" :value="agent.name" placeholder="心智名称" @input="update('name', ($event.target as HTMLInputElement).value)" />

    <label class="ae-label">代号</label>
    <input class="ae-input" :value="agent.codename" placeholder="自动分配" @input="update('codename', ($event.target as HTMLInputElement).value)" />

    <label class="ae-label">代表色</label>
    <div class="color-row">
      <input type="color" :value="agent.represent_color" @input="update('represent_color', ($event.target as HTMLInputElement).value)" />
      <span class="color-value">{{ agent.represent_color }}</span>
    </div>

    <label class="ae-label">描述</label>
    <textarea
      class="ae-textarea"
      :value="agent.description || ''"
      placeholder="一句话描述这个心智"
      rows="3"
      @input="update('description', ($event.target as HTMLTextAreaElement).value)"
    />

    <label class="ae-label">立绘 / 头像</label>
    <ImageUploader :url="agent.portrait_url || ''" @update:url="update('portrait_url', $event)" />
  </div>
</template>

<script setup lang="ts">
import ImageUploader from '@/components/ui/ImageUploader.vue'

interface AgentBasic {
  name: string
  codename: string
  represent_color: string
  description?: string
  portrait_url?: string
}

const props = defineProps<{
  agent: AgentBasic
  loading?: boolean
}>()

const emit = defineEmits<{
  'update:agent': [data: Partial<AgentBasic>]
  save: [field: string]
  reset: [field: string]
}>()

function update(field: keyof AgentBasic, value: any) {
  emit('update:agent', { [field]: value })
}
</script>

<style scoped>
@import '@/styles/agent-edit.css';

.color-row {
  display: flex;
  align-items: center;
  gap: 10px;
}

input[type='color'] {
  width: 48px;
  height: 36px;
  padding: 2px;
  background: var(--ae-input-bg);
  border: 1px solid var(--ae-input-border);
  border-radius: 6px;
  cursor: pointer;
}

.color-value {
  font-size: 12px;
  color: var(--ae-text-dim);
  font-family: monospace;
}
</style>
