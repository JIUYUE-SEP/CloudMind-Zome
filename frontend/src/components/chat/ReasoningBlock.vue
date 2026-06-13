<template>
  <div class="reasoning-block">
    <div class="reasoning-bar" @click="toggle">
      <span>{{ expanded ? '▼' : '▶' }} 已思考 {{ content.length }} 字</span>
    </div>
    <div v-if="expanded" class="reasoning-body">{{ content }}</div>
  </div>
</template>

<script setup lang="ts">
import { ref } from 'vue'

const props = defineProps<{
  content: string
}>()

const expanded = ref(false)

function toggle() {
  expanded.value = !expanded.value
}
</script>

<style scoped>
.reasoning-bar {
  padding: 3px 8px;
  background: rgba(0, 0, 0, 0.15);
  border-radius: 4px;
  font-size: 11px;
  color: #5a6a7a;
  cursor: pointer;
  margin-bottom: 6px;
  display: inline-block;
}
.reasoning-bar:hover {
  background: rgba(0, 0, 0, 0.25);
}
.reasoning-body {
  padding: 8px 10px;
  background: #141b24;
  border: 1px solid #1e2731;
  border-radius: 6px;
  font-size: 11px;
  color: #8899aa;
  white-space: pre-wrap;
  word-break: break-word;
  font-family: 'Fira Code', 'Courier New', Courier, monospace;
  line-height: 1.5;
  margin-bottom: 8px;
}
</style>
