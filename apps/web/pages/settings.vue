<template>
  <div class="settings-page">
    <h1>系统设置</h1>

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

      <button class="save" @click="store.save">保存</button>
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
  padding: 24px;
  color: #d8e1ec;
  background: #0b0f17;
  min-height: 100vh;
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
  color: #d8e1ec;
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
  color: #00e5c9;
}
.save {
  align-self: flex-start;
  padding: 8px 16px;
  border-radius: 6px;
  border: none;
  background: #00e5c9;
  color: #0b0f17;
  cursor: pointer;
}
</style>
