<template>
  <div class="self-image-page">
    <header class="si-header">
      <div class="si-header-left">
        <BackButton to="/" />
        <h1>我的心智侧写</h1>
      </div>
      <div class="save-status">
        <span class="status-saved">{{ saveStatus }}</span>
      </div>
    </header>

    <main class="si-body">
      <p class="si-hint">
        这里是你的自我侧写。后续版本会自动接入对话分析；当前可手动编辑并保存在本地浏览器中。
      </p>

      <div class="card-grid">
        <section class="si-card">
          <h3>🧩 心智摘要</h3>
          <textarea
            v-model="store.selfImage.summary"
            rows="4"
            placeholder="用一段话概括你对自己的理解..."
          />
        </section>

        <section class="si-card">
          <h3>💬 对话风格分析</h3>
          <textarea
            v-model="store.selfImage.style"
            rows="4"
            placeholder="描述你的沟通方式、表达习惯……"
          />
          <p class="card-placeholder">自动分析占位：后续可接入真实数据</p>
        </section>

        <section class="si-card">
          <h3>🛠 常用工具</h3>
          <p class="card-placeholder">暂无足够数据</p>
        </section>

        <section class="si-card">
          <h3>⏰ 活跃时段</h3>
          <p class="card-placeholder">暂无足够数据</p>
        </section>

        <section class="si-card wide">
          <h3>🧠 记忆摘要</h3>
          <p class="card-placeholder">暂无足够数据</p>
        </section>

        <section class="si-card wide">
          <h3>⚙ 偏好设置</h3>
          <textarea
            v-model="store.selfImage.preferences"
            rows="4"
            placeholder="记录你的使用偏好、目标或禁忌……"
          />
        </section>
      </div>
    </main>
  </div>
</template>

<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { useSelfImageStore } from "@/stores/self-image";
import BackButton from "@/components/BackButton.vue";

const store = useSelfImageStore();
const saveStatus = ref("已保存");
// load() 回填会触发 deep watch，加载完成前不自动保存
let loaded = false;

let timeout: ReturnType<typeof setTimeout> | null = null;
watch(
  () => store.selfImage,
  () => {
    if (!loaded) return;
    saveStatus.value = "保存中…";
    if (timeout) clearTimeout(timeout);
    timeout = setTimeout(() => {
      store.save();
      saveStatus.value = "已保存";
    }, 300);
  },
  { deep: true }
);

onMounted(async () => {
  store.load();
  // load 触发的 watch 先于 nextTick 执行，此后才允许自动保存
  await nextTick();
  loaded = true;
});

onBeforeUnmount(() => {
  if (timeout) clearTimeout(timeout);
  store.save();
});
</script>

<style scoped>
.self-image-page {
  position: absolute;
  inset: 0;
  background: var(--mc-bg);
  color: var(--mc-text);
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.si-header {
  height: 56px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 20px;
  border-bottom: 1px solid var(--mc-border);
  flex-shrink: 0;
}

.si-header-left {
  display: flex;
  align-items: center;
  gap: 12px;
}

.si-header h1 {
  margin: 0;
  font-size: 16px;
  font-weight: 600;
}

.save-status {
  font-size: 12px;
  color: var(--mc-success);
}

.si-body {
  flex: 1;
  overflow-y: auto;
  /* 底部预留 56px 底栏高度，滚动到底时末段内容不被遮挡 */
  padding: 20px 20px 80px;
}

.si-hint {
  margin: 0 0 16px;
  font-size: 12px;
  color: var(--mc-text-secondary);
  line-height: 1.6;
}

.card-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
  gap: 16px;
}

.si-card {
  background: rgba(255, 255, 255, 0.04);
  border: 1px solid var(--mc-border);
  border-radius: 12px;
  padding: 16px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.si-card.wide {
  grid-column: 1 / -1;
}

.si-card h3 {
  margin: 0;
  font-size: 13px;
  font-weight: 600;
  color: var(--mc-text);
}

.si-card textarea {
  width: 100%;
  padding: 10px 12px;
  border-radius: 8px;
  border: 1px solid var(--mc-border);
  background: rgba(255, 255, 255, 0.05);
  color: var(--mc-text);
  font-size: 13px;
  line-height: 1.6;
  resize: vertical;
  outline: none;
}

.si-card textarea::placeholder {
  color: var(--mc-text-tertiary);
}

.si-card textarea:focus {
  border-color: rgba(0, 229, 201, 0.3);
}

.card-placeholder {
  margin: 0;
  font-size: 12px;
  color: var(--mc-text-tertiary);
  line-height: 1.5;
}
</style>
