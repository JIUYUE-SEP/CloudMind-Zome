<template>
  <div class="tag-input">
    <span
      v-for="(t, i) in modelValue"
      :key="i"
      class="ae-tag"
      :class="{ warning }"
    >
      {{ t }}
      <button @click="remove(i)">×</button>
    </span>
    <input
      v-model="input"
      @keydown.enter.prevent="add"
      :placeholder="placeholder"
    />
  </div>
</template>

<script setup lang="ts">
import { ref } from 'vue'

const props = withDefaults(defineProps<{
  modelValue: string[]
  placeholder?: string
  warning?: boolean
}>(), {
  placeholder: '+ 添加标签',
  warning: false,
})

const emit = defineEmits<{
  'update:modelValue': [v: string[]]
}>()

const input = ref('')

function add() {
  const t = input.value.trim()
  if (t && !props.modelValue.includes(t)) {
    emit('update:modelValue', [...props.modelValue, t])
  }
  input.value = ''
}

function remove(i: number) {
  const next = [...props.modelValue]
  next.splice(i, 1)
  emit('update:modelValue', next)
}
</script>

<style scoped>
@import '@/styles/agent-edit.css';

.tag-input {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  align-items: center;
  padding: 8px;
  background: var(--ae-input-bg);
  border: 1px solid var(--ae-input-border);
  border-radius: 8px;
}

.tag-input input {
  flex: 1;
  min-width: 80px;
  background: transparent;
  border: none;
  color: var(--ae-text);
  font-size: 13px;
  padding: 4px;
}

.tag-input input:focus {
  outline: none;
}

.ae-tag.warning {
  background: rgba(255, 184, 0, 0.1);
  color: var(--ae-warning);
}

.ae-tag.warning button {
  color: var(--ae-warning);
}
</style>
