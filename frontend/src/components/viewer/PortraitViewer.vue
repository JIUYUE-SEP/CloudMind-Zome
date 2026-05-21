<template>
  <div class="portrait-viewer">
    <img v-if="url" :src="url" class="portrait-img" />
    <div v-else class="portrait-empty">
      <div class="empty-ring"></div>
      <div class="empty-hint">立绘展示区</div>
    </div>
  </div>
</template>

<script setup lang="ts">
defineProps<{ url: string }>()
</script>

<style scoped>
.portrait-viewer {
  position: relative;
  width: 100%;
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
}
.portrait-img {
  max-width: 100%;
  max-height: 100%;
  object-fit: contain;
  border-radius: 8px;
}
.portrait-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 12px;
}
.empty-ring {
  width: 160px;
  height: 160px;
  border: 1px dashed rgba(0, 229, 201, 0.2);
  border-radius: 50%;
  animation: pulse-ring 3s ease-in-out infinite;
}
.empty-hint {
  font-size: 13px;
  color: #5a6a7a;
}
@keyframes pulse-ring {
  0%, 100% { transform: scale(1); opacity: 0.6; }
  50% { transform: scale(1.02); opacity: 1; }
}
</style>
