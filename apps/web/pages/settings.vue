<template>
  <div class="settings-page">
    <header class="header">
      <BackButton to="/" />
      <h1>系统设置</h1>
    </header>

    <!-- 子页面入口（独立路由 /settings/tools，不嵌套不动主导航） -->
    <section class="entry-section">
      <NuxtLink to="/settings/tools" class="entry-card">
        <strong>工具与技能简介</strong>
        <span class="hint">动态工具与 Skill 的目录简介（blurb）：状态 / 重生成 / 编辑</span>
      </NuxtLink>
    </section>

    <section v-if="store.settings">
      <h2>工具列表</h2>
      <ul class="tools">
        <li v-for="tool in store.tools" :key="tool.name">
          <strong>{{ tool.name }}</strong>
          <span class="tag">{{ tool.toolset }}</span>
        </li>
      </ul>

      <h2>记忆参数</h2>
      <!-- 旧「阈值压缩」管线参数，引擎侧已无消费方（话题压缩接管）：
           保留只读说明，不再给出能改却不生效的输入框 -->
      <p class="hint">
        已废弃：这四项属于早期阈值压缩管线，当前版本由话题压缩接管，不再生效。
        话题边界/压缩节奏在 Agent 编辑页配置（话题消息阈值、检测时间窗、压缩模型）。
      </p>

      <h2>外部服务</h2>
      <label>
        Tavily API Key
        <input v-model="store.settings.tavilyApiKey" type="password" />
      </label>
      <label class="toggle">
        <input v-model="store.settings.sidecarAutoStart" type="checkbox" class="sidecar-toggle" />
        自动启动向量侧车（sidecar）
      </label>
      <p class="hint">
        开启后 engine 启动时自动拉起本地 sidecar（已在跑的健康实例直接纳用不重复拉起）；需本地已有
        sidecar 二进制（crates 构建产物或 ZOME_SIDECAR_BIN 指定）或 cargo 环境；默认关闭
      </p>

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
      <!-- 常驻提示（任何写操作成功后出现）：engine 无热重载，清单写只改文件，重启才生效 -->
      <p v-if="plugins.restartHint" class="restart-hint">变更将在 engine 重启后生效</p>
      <!-- 写操作错误（开关/登记/config 共用）：engine 的 400/404/409 error 正文 -->
      <p v-if="plugins.writeError" class="hint error">{{ plugins.writeError }}</p>

      <!-- 管理清单区（M2）：全局 manifest 条目（enabled 开关 + config 编辑） -->
      <p v-if="plugins.manifestError" class="hint error">加载失败：{{ plugins.manifestError }}</p>
      <p
        v-else-if="plugins.manifestLoading && !plugins.manifestEntries.length && !plugins.unregistered.length"
        class="hint"
      >
        加载中...
      </p>
      <template v-else>
        <h3 class="sub">插件清单（{{ plugins.manifestEntries.length }}）</h3>
        <p v-if="!plugins.manifestEntries.length" class="hint">暂无已登记的外部插件</p>
        <ul v-else class="rows">
          <li v-for="entry in plugins.manifestEntries" :key="entry.name" class="manifest-row">
            <div class="row-line">
              <strong>{{ entry.name }}</strong>
              <label class="toggle">
                <input
                  type="checkbox"
                  class="enabled-toggle"
                  :checked="entry.enabled"
                  @change="onTogglePlugin(entry, $event)"
                />
                启用
              </label>
              <button class="mini-btn config-btn" @click="openConfigEditor(entry)">
                {{ configEditing === entry.name ? "收起配置" : "配置" }}
              </button>
            </div>
            <div v-if="configEditing === entry.name" class="config-editor">
              <textarea v-model="configDraft" class="config-textarea" rows="6" spellcheck="false"></textarea>
              <p v-if="configError" class="hint error">{{ configError }}</p>
              <div class="config-actions">
                <button class="save config-save" @click="saveConfig(entry)">保存</button>
                <button class="mini-btn" @click="closeConfigEditor">取消</button>
              </div>
            </div>
          </li>
        </ul>

        <!-- 未登记目录：plugins/ 下有 index.mjs 但未登记入全局清单（plugins.json） -->
        <h3 class="sub">未登记（{{ plugins.unregistered.length }}）</h3>
        <p v-if="!plugins.unregistered.length" class="hint">暂无未登记的插件目录</p>
        <ul v-else class="rows">
          <li v-for="name in plugins.unregistered" :key="name">
            <strong>{{ name }}</strong>
            <span class="badge">未登记</span>
            <button class="mini-btn register-btn" @click="onRegister(name)">登记</button>
          </li>
        </ul>
      </template>

      <!-- per-agent 管理：选中 agent 后管理其 plugins.yml 清单（切换即重载） -->
      <h3 class="sub">按 Agent 管理</h3>
      <p v-if="agents.error" class="hint error">Agent 列表加载失败：{{ agents.error }}</p>
      <p v-else-if="!agents.list.length" class="hint">暂无 Agent</p>
      <template v-else>
        <select v-model="selectedAgent" class="agent-select">
          <option v-for="a in agents.list" :key="a.id" :value="a.id">{{ a.name }}（{{ a.id }}）</option>
        </select>
        <p v-if="plugins.agentError" class="hint error">加载失败：{{ plugins.agentError }}</p>
        <p v-else-if="plugins.agentLoading && !plugins.agentEntries.length" class="hint">加载中...</p>
        <template v-else>
          <p v-if="!plugins.agentEntries.length" class="hint">该 Agent 暂无插件清单条目</p>
          <ul v-else class="rows">
            <li v-for="entry in plugins.agentEntries" :key="entry.name">
              <strong>{{ entry.name }}</strong>
              <label class="toggle">
                <input
                  type="checkbox"
                  class="agent-enabled-toggle"
                  :checked="entry.enabled"
                  @change="onToggleAgentPlugin(entry, $event)"
                />
                启用
              </label>
            </li>
          </ul>
        </template>
      </template>

      <!-- 加载结果（只读）：引擎当前运行态，清单变更重启后才反映到这里——诊断信息折叠在下；
           加载失败时自动展开（:open），不藏错误 -->
      <details class="load-results" :open="!!plugins.error">
        <summary class="sub">加载结果（当前运行态）</summary>
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
      </details>
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
import { computed, onMounted, ref } from "vue";
import { useSettingsStore } from "@/stores/settings";
import { usePluginsStore, skipReasonText, pluginStatusText } from "@/stores/plugins";
import { useAgentsStore } from "@/stores/agents";
import type { AgentPluginManifestEntry, PluginManifestEntry } from "@/composables/useEngineClient";
import { formatUptime } from "@/utils/system-info";

const store = useSettingsStore();
const plugins = usePluginsStore();
const agents = useAgentsStore();

// per-agent 选择器：v-model 直达 store，切换即重新加载该 agent 的清单
const selectedAgent = computed({
  get: () => plugins.selectedAgentId,
  set: (id: string) => {
    void plugins.selectAgent(id);
  },
});

onMounted(async () => {
  store.load();
  store.loadTools();
  store.loadSystemInfo();
  plugins.load();
  plugins.loadManifest();
  await agents.load();
  // 默认选中第一个 Agent（选中即触发其清单加载）；无 Agent 时选择器不渲染
  if (agents.list.length && !plugins.selectedAgentId) {
    await plugins.selectAgent(agents.list[0].id);
  }
});

// enabled 开关：点击即 PUT。原生 checkbox 点击瞬间已翻转 DOM 态，失败时 store 状态未变，
// 需手动把 DOM 拨回原值（:checked 绑定只在状态变化时 patch，不会自发回弹）
async function onTogglePlugin(entry: PluginManifestEntry, event: Event) {
  const checkbox = event.target as HTMLInputElement;
  const ok = await plugins.setPluginEnabled(entry.name, checkbox.checked);
  if (!ok) checkbox.checked = entry.enabled;
}

async function onToggleAgentPlugin(entry: AgentPluginManifestEntry, event: Event) {
  const checkbox = event.target as HTMLInputElement;
  const ok = await plugins.setAgentPluginEnabled(entry.name, checkbox.checked);
  if (!ok) checkbox.checked = entry.enabled;
}

// 登记：失败时 writeError 已在节内透出；成功后条目由 store 从未登记区移入清单区
async function onRegister(name: string) {
  await plugins.register(name);
}

// config 编辑器：单开（同时刻只展开一条），draft 是该条目 config 的格式化 JSON 文本
const configEditing = ref("");
const configDraft = ref("");
const configError = ref("");

function openConfigEditor(entry: PluginManifestEntry) {
  if (configEditing.value === entry.name) {
    closeConfigEditor();
    return;
  }
  configEditing.value = entry.name;
  configDraft.value = JSON.stringify(entry.config, null, 2);
  configError.value = "";
}

function closeConfigEditor() {
  configEditing.value = "";
  configDraft.value = "";
  configError.value = "";
}

// 保存前置校验与 engine parsePatch 同口径：合法 JSON 且为对象（非数组非标量）；
// 写失败时 writeError 透出，编辑器保持打开供修正重试
async function saveConfig(entry: PluginManifestEntry) {
  let parsed: unknown;
  try {
    parsed = JSON.parse(configDraft.value);
  } catch {
    configError.value = "JSON 格式非法，请检查";
    return;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    configError.value = "配置必须是 JSON 对象（非数组非标量）";
    return;
  }
  const ok = await plugins.savePluginConfig(entry.name, parsed as Record<string, unknown>);
  if (ok) closeConfigEditor();
}
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

/* 子页面入口卡片（工具与技能简介 → /settings/tools） */
.entry-section {
  margin-bottom: 24px;
}

.entry-card {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 12px 16px;
  border: 1px solid var(--mc-border);
  border-radius: 8px;
  background: var(--mc-panel);
  text-decoration: none;
  color: var(--mc-text);
  max-width: 600px;
}

.entry-card:hover {
  border-color: var(--mc-accent);
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

.restart-hint {
  margin: 0;
  padding: 8px 12px;
  border-radius: 6px;
  font-size: 13px;
  background: rgba(245, 158, 11, 0.12);
  color: var(--mc-warning);
}

/* 清单行：首行名称+开关+配置按钮，config 编辑器整行展开在下方 */
.rows li.manifest-row {
  flex-direction: column;
  align-items: stretch;
}

.row-line {
  display: flex;
  align-items: center;
  gap: 8px;
}

/* scoped 的 label 元素选择器是纵向表单排版，开关标签用类选择器压回横向内联 */
.toggle {
  flex-direction: row;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 12px;
  color: var(--mc-text-secondary);
  cursor: pointer;
}

.mini-btn {
  padding: 2px 10px;
  border-radius: 4px;
  border: 1px solid rgba(255, 255, 255, 0.15);
  background: rgba(255, 255, 255, 0.05);
  color: var(--mc-text);
  font-size: 12px;
  cursor: pointer;
}

.mini-btn:hover {
  background: rgba(255, 255, 255, 0.12);
}

.badge {
  font-size: 12px;
  padding: 2px 8px;
  border-radius: 4px;
  background: rgba(245, 158, 11, 0.15);
  color: var(--mc-warning);
}

.agent-select {
  align-self: flex-start;
  padding: 8px 12px;
  border-radius: 6px;
  border: 1px solid rgba(255, 255, 255, 0.1);
  background: rgba(255, 255, 255, 0.05);
  color: var(--mc-text);
}

.config-editor {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin-top: 8px;
}

.config-textarea {
  padding: 8px 12px;
  border-radius: 6px;
  border: 1px solid rgba(255, 255, 255, 0.1);
  background: rgba(255, 255, 255, 0.05);
  color: var(--mc-text);
  font-family: monospace;
  font-size: 12px;
  resize: vertical;
}

.config-actions {
  display: flex;
  align-items: center;
  gap: 8px;
}

.load-results summary {
  cursor: pointer;
  user-select: none;
}
</style>
