<template>
  <div class="settings-page">
    <header class="header">
      <BackButton />
      <h1>系统设置</h1>
    </header>

    <section v-if="store.settings">
      <h2>工具列表</h2>
      <ul class="tools">
        <li v-for="tool in store.tools" :key="tool.name">
          <strong>{{ tool.name }}</strong>
          <span class="tag">{{ tool.toolset }}</span>
        </li>
      </ul>

      <h2>记忆参数</h2>
      <label>
        Compact Threshold
        <input v-model.number="store.settings.memory.compactThreshold" type="number" step="0.1" />
      </label>
      <label>
        Keep Recent
        <input v-model.number="store.settings.memory.keepRecent" type="number" />
      </label>
      <label>
        Hot Memory Limit
        <input v-model.number="store.settings.memory.hotMemoryLimit" type="number" />
      </label>
      <label>
        Warm Memory Limit
        <input v-model.number="store.settings.memory.warmMemoryLimit" type="number" />
      </label>

      <h2>外部服务</h2>
      <label>
        Tavily API Key
        <input v-model="store.settings.tavilyApiKey" type="password" />
      </label>

      <div class="actions">
        <button class="save" :disabled="store.saveState === 'saving'" @click="store.save">
          {{ store.saveState === 'saving' ? '保存中...' : '保存' }}
        </button>
        <span v-if="store.saveState === 'saved'" class="save-ok">已保存</span>
        <span v-if="store.saveState === 'error'" class="save-err">{{ store.saveError }}</span>
      </div>
    </section>
    <section v-else class="load-error">
      <p>{{ store.loadError ? `加载失败：${store.loadError}` : '加载中...' }}</p>
      <button v-if="store.loadError" class="save" @click="store.load">重试</button>
    </section>
  </div>
</template>

<script setup lang="ts">
import { onMounted } from "vue";
import { useSettingsStore } from "@/stores/settings";

const store = useSettingsStore();

onMounted(() => {
  store.load();
  store.loadTools();
});
</script>

<style scoped>
.settings-page {
  position: absolute;
  inset: 0;
  padding: 24px 24px 80px;
  color: var(--mc-text);
  background: var(--mc-bg);
  overflow-y: auto;
}

.header {
  display: flex;
  align-items: center;
  gap: 16px;
  margin-bottom: 24px;
}

.header h1 {
  margin: 0;
  font-size: 24px;
}

section {
  display: flex;
  flex-direction: column;
  gap: 16px;
  max-width: 600px;
}

label {
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: 13px;
}

input {
  padding: 8px 12px;
  border-radius: 6px;
  border: 1px solid rgba(255, 255, 255, 0.1);
  background: rgba(255, 255, 255, 0.05);
  color: var(--mc-text);
}

.tools {
  list-style: none;
  padding: 0;
}

.tools li {
  display: flex;
  justify-content: space-between;
  padding: 8px 0;
  border-bottom: 1px solid rgba(255, 255, 255, 0.08);
}

.tag {
  font-size: 12px;
  padding: 2px 8px;
  border-radius: 4px;
  background: rgba(0, 229, 201, 0.15);
  color: var(--mc-accent);
}

.save {
  align-self: flex-start;
  padding: 8px 16px;
  border-radius: 6px;
  border: none;
  background: var(--mc-accent);
  color: var(--mc-bg);
  cursor: pointer;
}

.save:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.actions {
  display: flex;
  align-items: center;
  gap: 12px;
}

.save-ok {
  color: var(--mc-success);
  font-size: 13px;
}

.save-err {
  color: var(--mc-danger);
  font-size: 13px;
}

.load-error {
  color: var(--mc-text-secondary);
  font-size: 14px;
}
</style>
