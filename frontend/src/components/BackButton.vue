<template>
  <button class="back-btn" @click="onClick" title="返回">
    <span class="arrow">&#8592;</span>
  </button>
</template>

<script setup lang="ts">
import { useRouter } from 'vue-router'

const props = defineProps<{
  to?: string
}>()
const emit = defineEmits<{
  (e: 'click'): void
}>()

const router = useRouter()

function onClick() {
  emit('click')
  if (props.to) {
    router.push(props.to)
  } else {
    router.back()
  }
}
</script>

<style scoped>
.back-btn {
  width: 36px;
  height: 36px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: transparent;
  border: 1px solid transparent;
  border-radius: 8px;
  color: #8899aa;
  font-size: 18px;
  cursor: pointer;
  transition: all 0.15s;
  flex-shrink: 0;
}
.back-btn:hover {
  background: rgba(255, 255, 255, 0.06);
  border-color: rgba(255, 255, 255, 0.08);
  color: #00e5c9;
}
.arrow {
  line-height: 1;
}
</style>
