<template>
  <div class="tools-page">
    <header class="header">
      <BackButton to="/settings" />
      <h1>工具与技能简介</h1>
    </header>

    <section>
      <p class="hint">
        动态工具（MCP / 外部插件）与 Skill 的目录简介（blurb）管理：状态可见、失败可重生成、可编辑——编辑内容永不被自动覆盖。
      </p>

      <!-- agent 选择（照 per-agent 管理面先例：切换即重载） -->
      <p v-if="agents.error" class="hint error">Agent 列表加载失败：{{ agents.error }}</p>
      <p v-else-if="!agents.list.length" class="hint">暂无 Agent</p>
      <select v-else v-model="selectedAgent" class="agent-select">
        <option v-for="a in agents.list" :key="a.id" :value="a.id">{{ a.name }}（{{ a.id }}）</option>
      </select>

      <p v-if="catalog.error" class="hint error">加载失败：{{ catalog.error }}</p>
      <p v-else-if="catalog.loading && !catalog.catalog" class="hint">加载中...</p>
      <template v-else-if="catalog.catalog">
        <p v-if="catalog.notice" class="notice">{{ catalog.notice }}</p>
        <p v-if="catalog.writeError" class="hint error">{{ catalog.writeError }}</p>

        <!-- MCP 工具（dynamic：name/blurb/source/status） -->
        <h3 class="sub">MCP 工具（{{ catalog.catalog.dynamic.length }}）</h3>
        <p v-if="!catalog.catalog.dynamic.length" class="hint">该 Agent 暂无动态工具</p>
        <ul v-else class="rows">
          <li v-for="item in catalog.catalog.dynamic" :key="item.name">
            <template v-if="editing === item.name">
              <input v-model="draft" class="blurb-input" maxlength="200" placeholder="1-200 字符" />
              <button class="mini-btn save-btn" @click="onSave(item.name)">保存</button>
              <button class="mini-btn" @click="onCancelEdit">取消</button>
            </template>
            <template v-else>
              <strong class="tool-name">{{ item.name }}</strong>
              <span class="blurb-text">{{ item.blurb }}</span>
              <span class="badge" :class="badgeClass(item.status)">{{ badgeText(item.status) }}</span>
              <button class="mini-btn edit-btn" title="编辑" @click="onEdit(item.name, item.blurb)">✎</button>
              <button
                class="mini-btn regen-btn"
                :disabled="catalog.loading"
                @click="onRegenerate([item.name])"
              >
                重生成
              </button>
            </template>
          </li>
        </ul>

        <!-- Skills（作者行 + 覆盖行；编辑经 skill:<name> 键） -->
        <h3 class="sub">Skills（{{ catalog.catalog.skills.length }}）</h3>
        <p v-if="!catalog.catalog.skills.length" class="hint">该 Agent 暂无 Skill</p>
        <ul v-else class="rows">
          <li v-for="item in catalog.catalog.skills" :key="item.name">
            <template v-if="editing === `skill:${item.name}`">
              <input v-model="draft" class="blurb-input" maxlength="200" placeholder="1-200 字符" />
              <button class="mini-btn save-btn" @click="onSave(`skill:${item.name}`)">保存</button>
              <button class="mini-btn" @click="onCancelEdit">取消</button>
            </template>
            <template v-else>
              <strong class="tool-name">{{ item.name }}</strong>
              <span class="blurb-text">
                {{ item.overrideBlurb ?? item.authorLine }}
                <span v-if="item.overrideBlurb" class="meta">（作者行：{{ item.authorLine }}）</span>
              </span>
              <span class="badge" :class="badgeClass(item.status)">{{ badgeText(item.status) }}</span>
              <button
                class="mini-btn edit-btn"
                title="编辑"
                @click="onEdit(`skill:${item.name}`, item.overrideBlurb ?? item.authorLine)"
              >
                ✎
              </button>
              <button
                class="mini-btn regen-btn"
                :disabled="catalog.loading"
                @click="onRegenerate([`skill:${item.name}`])"
              >
                重生成
              </button>
            </template>
          </li>
        </ul>

        <!-- 内置工具（只读，无管理面） -->
        <h3 class="sub">内置工具（{{ catalog.catalog.builtin.length }}，只读）</h3>
        <ul class="rows">
          <li v-for="item in catalog.catalog.builtin" :key="item.name">
            <strong class="tool-name">{{ item.name }}</strong>
            <span class="blurb-text">{{ item.blurb }}</span>
            <span class="badge badge-core">常驻</span>
          </li>
        </ul>

        <div class="actions">
          <button class="save" :disabled="catalog.loading" @click="onRegenerate()">
            {{ catalog.loading ? "处理中..." : "全部重新生成" }}
          </button>
          <span class="hint">缺省只重新生成「待生成 / 已过期」件；已编辑（user）条目自动跳过</span>
        </div>
      </template>
    </section>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { useAgentsStore } from "@/stores/agents";
import { useToolCatalogStore } from "@/stores/toolCatalog";
import type { ToolBlurbStatus } from "@/composables/useEngineClient";

// 路由纠偏（e2e 实证）：文件名 settings.tools.vue 在 Nuxt 3 里映射到字面路径
// /settings.tools（点不是路径分隔符），契约 URL 是 /settings/tools——
// 用 definePageMeta 显式钉死，不改文件布局不引入嵌套
definePageMeta({ path: "/settings/tools" });

const agents = useAgentsStore();
const catalog = useToolCatalogStore();

// per-agent 选择器：v-model 直达 store，切换即重新加载该 agent 的目录
const selectedAgent = computed({
  get: () => catalog.agentId,
  set: (id: string) => {
    void catalog.load(id);
  },
});

onMounted(async () => {
  await agents.load();
  // 默认选中第一个 Agent（选中即触发目录加载）；无 Agent 时选择器不渲染
  if (agents.list.length && !catalog.agentId) {
    await catalog.load(agents.list[0].id);
  }
});

// ---- 徽标四态（missing 灰 / llm 蓝 / user 绿 / stale 黄） ----
function badgeText(status: ToolBlurbStatus): string {
  switch (status) {
    case "missing":
      return "待生成";
    case "llm":
      return "LLM";
    case "user":
      return "已编辑";
    case "stale":
      return "已过期";
  }
}

function badgeClass(status: ToolBlurbStatus): string {
  return `badge-${status}`;
}

// ---- 行内编辑（单开：同时刻只编辑一行；1-200 前端预校验与 engine zod 同口径） ----
const editing = ref("");
const draft = ref("");

function onEdit(name: string, current: string) {
  editing.value = name;
  draft.value = current;
}

function onCancelEdit() {
  editing.value = "";
  draft.value = "";
}

async function onSave(name: string) {
  const blurb = draft.value.trim();
  if (!blurb || blurb.length > 200) {
    catalog.writeError = "简介须为 1-200 字符";
    return;
  }
  const ok = await catalog.save(name, blurb);
  if (ok) onCancelEdit();
}

async function onRegenerate(names?: string[]) {
  await catalog.regenerate(names);
}
</script>

<style scoped>
.tools-page {
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
  max-width: 720px;
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

.notice {
  margin: 0;
  padding: 8px 12px;
  border-radius: 6px;
  font-size: 13px;
  background: rgba(0, 229, 201, 0.12);
  color: var(--mc-accent);
}

.agent-select {
  align-self: flex-start;
  padding: 8px 12px;
  border-radius: 6px;
  border: 1px solid rgba(255, 255, 255, 0.1);
  background: rgba(255, 255, 255, 0.05);
  color: var(--mc-text);
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

.tool-name {
  flex-shrink: 0;
  font-family: monospace;
  font-size: 13px;
}

.blurb-text {
  flex: 1;
  font-size: 13px;
  color: var(--mc-text-secondary);
  word-break: break-all;
}

.meta {
  font-size: 12px;
  color: var(--mc-text-tertiary);
}

.badge {
  flex-shrink: 0;
  font-size: 12px;
  padding: 2px 8px;
  border-radius: 4px;
}

.badge-missing {
  background: rgba(136, 153, 170, 0.15);
  color: var(--mc-text-tertiary);
}

.badge-llm {
  background: rgba(0, 229, 201, 0.15);
  color: var(--mc-accent);
}

.badge-user {
  background: rgba(16, 185, 129, 0.15);
  color: var(--mc-success);
}

.badge-stale {
  background: rgba(245, 158, 11, 0.15);
  color: var(--mc-warning);
}

.badge-core {
  background: rgba(136, 153, 170, 0.15);
  color: var(--mc-text-tertiary);
}

.mini-btn {
  flex-shrink: 0;
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

.mini-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.blurb-input {
  flex: 1;
  padding: 6px 10px;
  border-radius: 6px;
  border: 1px solid rgba(255, 255, 255, 0.1);
  background: rgba(255, 255, 255, 0.05);
  color: var(--mc-text);
  font-size: 13px;
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
</style>
