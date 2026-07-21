<template>
  <button class="back-btn" title="返回" @click="onClick">
    <span class="arrow">&#8592;</span>
  </button>
</template>

<script setup lang="ts">
const props = defineProps<{
  to: string;
}>();

const emit = defineEmits<{
  (e: "click"): void;
}>();

const router = useRouter();

function onClick() {
  emit("click");
  // 固定跳显式路径，不用 router.back()（历史栈上一页不一定是逻辑父页）
  router.push(props.to);
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
  color: var(--mc-text-secondary);
  font-size: 18px;
  cursor: pointer;
  transition: all 0.15s;
  flex-shrink: 0;
}

.back-btn:hover {
  background: var(--mc-panel);
  border-color: var(--mc-border);
  color: var(--mc-accent);
}

.arrow {
  line-height: 1;
}
</style>
