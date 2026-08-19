<template>
  <div class="settings-page">
    <header class="header">
      <BackButton to="/" />
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

    <section>
      <h2>外部插件</h2>
      <p v-if="plugins.error" class="hint error">加载失败：{{ plugins.error }}</p>
      <p
        v-else-if="plugins.isLoading && !plugins.loaded.length && !plugins.skipped.length && !plugins.perAgent.length"
        class="hint"
      >
        加载中...
      </p>
      <template v-else>
        <h3 class="sub">已加载（{{ plugins.loaded.length }}）</h3>
        <p v-if="!plugins.loaded.length" class="hint">暂无已加载的外部插件</p>
        <ul v-else class="rows">
          <li v-for="name in plugins.loaded" :key="name">{{ name }}</li>
        </ul>

        <h3 class="sub">已跳过（{{ plugins.skipped.length }}）</h3>
        <p v-if="!plugins.skipped.length" class="hint">暂无被跳过的插件</p>
        <ul v-else class="rows">
          <li v-for="p in plugins.skipped" :key="p.name">
            <strong>{{ p.name }}</strong>
            <span class="meta">{{ skipReasonText(p.reason) }}</span>
          </li>
        </ul>

        <h3 class="sub">按 Agent 挂载（{{ plugins.perAgent.length }}）</h3>
        <p v-if="!plugins.perAgent.length" class="hint">暂无按 Agent 的挂载记录</p>
        <ul v-else class="rows">
          <li v-for="p in plugins.perAgent" :key="`${p.agentId}:${p.name}`">
            <strong>{{ p.name }}</strong>
            <span class="meta">{{ p.agentId }}</span>
            <span class="status" :class="{ failed: p.status !== 'loaded' }">{{ pluginStatusText(p.status) }}</span>
          </li>
        </ul>
      </template>
    </section>

    <section>
      <h2>系统信息</h2>
      <p v-if="store.systemInfoError" class="hint error">加载失败：{{ store.systemInfoError }}</p>
      <p v-else-if="!store.systemInfo" class="hint">加载中...</p>
      <template v-else>
        <ul class="rows">
          <li>
            <span class="info-label">版本</span>
            <span>
              {{ store.systemInfo.version }}
              <template v-if="store.systemInfo.gitCommit">（{{ store.systemInfo.gitCommit.slice(0, 7) }}）</template>
            </span>
          </li>
          <li>
            <span class="info-label">数据目录</span>
            <span class="info-value">{{ store.systemInfo.dataDir }}</span>
          </li>
          <li>
            <span class="info-label">引擎端口</span>
            <span>{{ store.systemInfo.port }}</span>
          </li>
          <li>
            <span class="info-label">运行时长</span>
            <span>{{ formatUptime(store.systemInfo.uptimeSec) }}</span>
          </li>
          <li>
            <span class="info-label">Sidecar</span>
            <span>{{ store.systemInfo.sidecar.configured ? "已配置" : "未配置" }}</span>
          </li>
        </ul>
        <!-- sidecar.configured 口径：仅表示引擎装配了 sidecar 客户端配置，不代表进程在跑；
             「在跑」检测需 /health 之类探活，V1 如实展示 configured 并注明含义 -->
        <p class="hint">Sidecar「已配置」仅表示引擎装配了客户端配置，不代表 sidecar 进程正在运行</p>
      </template>
    </section>
  </div>
</template>

<script setup lang="ts">
import { onMounted } from "vue";
import { useSettingsStore } from "@/stores/settings";
import { usePluginsStore, skipReasonText, pluginStatusText } from "@/stores/plugins";
import { formatUptime } from "@/utils/system-info";

const store = useSettingsStore();
const plugins = usePluginsStore();

onMounted(() => {
  store.load();
  store.loadTools();
  store.loadSystemInfo();
  plugins.load();
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
  border-bottom: 1px solid var(--mc-border);
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

.sub {
  margin: 8px 0 0;
  font-size: 14px;
  color: var(--mc-text-secondary);
}

.hint {
  margin: 0;
  color: var(--mc-text-tertiary);
  font-size: 13px;
}

.hint.error {
  color: var(--mc-danger);
}

.rows {
  list-style: none;
  padding: 0;
  margin: 0;
}

.rows li {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 0;
  border-bottom: 1px solid var(--mc-border);
}

.meta {
  font-size: 12px;
  color: var(--mc-text-tertiary);
}

.status {
  margin-left: auto;
  font-size: 12px;
  padding: 2px 8px;
  border-radius: 4px;
  background: rgba(0, 229, 201, 0.15);
  color: var(--mc-accent);
}

.status.failed {
  background: rgba(245, 158, 11, 0.15);
  color: var(--mc-warning);
}

.info-label {
  width: 72px;
  flex-shrink: 0;
  color: var(--mc-text-tertiary);
  font-size: 13px;
}

.info-value {
  word-break: break-all;
}
</style>
