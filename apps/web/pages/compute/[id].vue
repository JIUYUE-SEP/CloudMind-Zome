<template>
  <div class="compute-detail-page">
    <header>
      <BackButton to="/compute" />
      <div class="head-title">
        <h1>{{ provider?.displayName ?? "型号管理" }}</h1>
        <span v-if="provider" class="api-pill">{{ apiModeLabel(provider.apiMode) }}</span>
      </div>
      <p v-if="provider" class="base-url-summary">{{ provider.baseUrl }}</p>
    </header>

    <div v-if="compute.error" class="load-error">加载失败：{{ compute.error }}</div>
    <div
      v-else-if="(compute.isLoading || !compute.hasLoaded) && !provider"
      class="load-empty"
    >
      加载中...
    </div>
    <template v-else-if="provider">
      <section class="section">
        <h2>型号列表</h2>
        <p v-if="!provider.models.length" class="empty">暂无型号，可添加或一键导入</p>
        <ul v-else class="model-list">
          <li v-for="model in provider.models" :key="model.id">
            <span class="model-info">
              {{ model.displayName || model.id }} ({{ model.modelType }})
              <small v-if="capabilityLabel(model)" class="model-capabilities">
                {{ capabilityLabel(model) }}
              </small>
            </span>
            <button class="btn-danger" @click="deleteModel(model.id)">删除</button>
          </li>
        </ul>
      </section>

      <section class="section">
        <h2>添加型号</h2>
        <div class="add-model">
          <div class="form-row">
            <div class="field">
              <label for="model-id">模型 ID</label>
              <input id="model-id" v-model="newModel.id" placeholder="如 gpt-4o" />
            </div>
            <div class="field">
              <label for="model-name">显示名称</label>
              <input id="model-name" v-model="newModel.displayName" placeholder="如 GPT-4o（可留空）" />
            </div>
            <div class="field">
              <label for="model-type">类型</label>
              <select id="model-type" v-model="newModel.modelType">
                <option value="llm">LLM</option>
                <option value="embedding">Embedding</option>
                <option value="image">Image</option>
                <option value="stt">STT</option>
              </select>
            </div>
          </div>
          <div class="form-row">
            <div class="field">
              <label for="model-context">上下文窗口</label>
              <input
                id="model-context"
                v-model.number="newModel.contextWindow"
                type="number"
                min="1"
                placeholder="如 128000（留空未知）"
              />
            </div>
            <div class="field">
              <label for="model-max-output">最大输出 tokens</label>
              <input
                id="model-max-output"
                v-model.number="newModel.maxOutputTokens"
                type="number"
                min="1"
                placeholder="如 8192（留空未知）"
              />
            </div>
            <div class="field capability-field">
              <span class="capability-label">能力</span>
              <div class="capability-checks">
                <label class="capability-check">
                  <input v-model="newModel.supportsReasoning" type="checkbox" />
                  推理
                </label>
                <label class="capability-check">
                  <input v-model="newModel.supportsToolCalling" type="checkbox" />
                  工具
                </label>
                <label class="capability-check">
                  <input v-model="newModel.supportsMultimodal" type="checkbox" />
                  多模态
                </label>
              </div>
            </div>
            <button class="btn-primary" @click="addModel">添加型号</button>
          </div>
          <div v-if="modelError" class="op-error">{{ modelError }}</div>
        </div>
      </section>

      <section class="section">
        <h2>测试连接与导入</h2>
        <div class="connection-actions">
          <button class="btn-ghost" :disabled="testingId !== null" @click="testProvider(provider.id)">
            {{ testingId === provider.id ? "测试中..." : "测试连接" }}
          </button>
        </div>
        <p
          v-if="testResult && testResult.providerId === provider.id"
          class="test-result"
          :class="{ fail: !testResult.ok }"
        >
          {{ testResult.ok ? "连接成功" : `连接失败: ${testResult.error}` }}
        </p>
        <div
          v-if="
            testResult &&
            testResult.ok &&
            testResult.providerId === provider.id &&
            testResult.discovered?.length
          "
          class="discovered-import"
        >
          <div class="discovered-models">
            <span
              v-for="(model, index) in testResult.discovered"
              :key="`${model.id}-${index}`"
              class="discovered-chip"
            >
              {{ model.id }}
            </span>
          </div>
          <button class="btn-primary" :disabled="importing" @click="importDiscovered">
            {{ importing ? "导入中..." : "全部导入" }}
          </button>
          <p v-if="importFeedback" class="import-feedback">{{ importFeedback }}</p>
        </div>
      </section>
    </template>
    <div v-else class="not-found">
      <p>Provider 不存在或已删除</p>
      <NuxtLink to="/compute" class="back-link">返回算力中枢列表</NuxtLink>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, reactive, computed, onMounted } from "vue";
import { useComputeStore } from "@/stores/compute";
import type { ModelInfo, Provider } from "@/composables/useEngineClient";

const route = useRoute();
const compute = useComputeStore();

// 从 store 按 id find provider；store 每次操作后全量重载，computed 跟随最新快照
const providerId = computed(() => String(route.params.id ?? ""));
const provider = computed<Provider | null>(() => compute.getProvider(providerId.value) ?? null);

const newModel = reactive({
  id: "",
  displayName: "",
  modelType: "llm" as ModelInfo["modelType"],
  contextWindow: "" as number | "",
  maxOutputTokens: "" as number | "",
  supportsReasoning: false,
  supportsToolCalling: false,
  supportsMultimodal: false,
});
const modelError = ref("");
// 测试连接最长 30s：进行中禁用按钮防连点，结果与 providerId 绑定防串台
const testingId = ref<string | null>(null);
const testResult = ref<{
  providerId: string;
  ok: boolean;
  error?: string;
  discovered?: ModelInfo[];
} | null>(null);
const importing = ref(false);
const importFeedback = ref("");

onMounted(() => {
  compute.load();
});

function apiModeLabel(apiMode?: string): string {
  switch (apiMode ?? "chat_completions") {
    case "responses":
      return "Responses";
    case "anthropic":
      return "Anthropic";
    default:
      return "OpenAI 兼容";
  }
}

function formatCount(value: number): string {
  if (value >= 1_000_000) {
    const m = value / 1_000_000;
    return `${Number.isInteger(m) ? m : m.toFixed(1)}M`;
  }
  if (value >= 1_000) {
    const k = value / 1_000;
    return `${Number.isInteger(k) ? k : k.toFixed(1)}K`;
  }
  return String(value);
}

function capabilityLabel(model: ModelInfo): string {
  const parts: string[] = [];
  if (model.contextWindow) parts.push(`ctx:${formatCount(model.contextWindow)}`);
  if (model.maxOutputTokens) parts.push(`max:${formatCount(model.maxOutputTokens)}`);
  if (model.supportsReasoning) parts.push("推理");
  if (model.supportsToolCalling) parts.push("工具");
  if (model.supportsMultimodal) parts.push("多模态");
  return parts.join(" · ");
}

async function testProvider(id: string) {
  if (testingId.value !== null) return;
  testingId.value = id;
  testResult.value = null;
  try {
    const res = await compute.testConnection(id);
    testResult.value = { providerId: id, ok: true, discovered: res.discovered };
  } catch (err) {
    testResult.value = {
      providerId: id,
      ok: false,
      error: err instanceof Error ? err.message : "测试失败",
    };
  } finally {
    testingId.value = null;
  }
}

async function importDiscovered() {
  const result = testResult.value;
  const current = provider.value;
  if (!result?.ok || !result.discovered?.length || !current) return;
  importing.value = true;
  importFeedback.value = "";
  try {
    const existing = new Set(current.models.map((m) => m.id));
    const toImport: ModelInfo[] = [];
    for (const model of result.discovered) {
      // 跳过 provider 已有 id 与 discovered 列表内重复 id
      if (existing.has(model.id) || toImport.some((m) => m.id === model.id)) continue;
      toImport.push({
        id: model.id,
        displayName: model.displayName || model.id,
        modelType: model.modelType ?? "llm",
      });
    }
    // R4（review）：单项失败（含并发 409）逐项容错，不整批中止；失败计入跳过数
    let imported = 0;
    let failed = 0;
    for (const model of toImport) {
      try {
        await compute.addModel(current.id, model);
        imported++;
      } catch {
        failed++;
      }
    }
    const skipped = result.discovered.length - imported;
    importFeedback.value =
      `导入 ${imported} 个，跳过 ${skipped} 个` +
      (failed > 0 ? `（含失败 ${failed} 个）` : "");
  } catch (err) {
    importFeedback.value = `导入失败: ${err instanceof Error ? err.message : "未知错误"}`;
  } finally {
    importing.value = false;
  }
}

async function addModel() {
  if (!provider.value || !newModel.id) return;
  modelError.value = "";
  const modelId = newModel.id.trim();
  // engine 侧不查重，重复 id 会让 :key 撞车且语义含糊
  if (provider.value.models.some((m) => m.id === modelId)) {
    modelError.value = `模型 ID 已存在：${modelId}`;
    return;
  }
  try {
    const payload: ModelInfo = {
      id: modelId,
      displayName: newModel.displayName.trim(),
      modelType: newModel.modelType,
      ...(newModel.contextWindow !== "" ? { contextWindow: newModel.contextWindow } : {}),
      ...(newModel.maxOutputTokens !== "" ? { maxOutputTokens: newModel.maxOutputTokens } : {}),
      // R5（review）：未勾选不落字段（与导入路径的「未知」语义对齐），
      // 避免把「未表态」记录成「明确不支持」
      ...(newModel.supportsReasoning ? { supportsReasoning: true } : {}),
      ...(newModel.supportsToolCalling ? { supportsToolCalling: true } : {}),
      ...(newModel.supportsMultimodal ? { supportsMultimodal: true } : {}),
    };
    await compute.addModel(provider.value.id, payload);
    newModel.id = "";
    newModel.displayName = "";
    newModel.modelType = "llm";
    newModel.contextWindow = "";
    newModel.maxOutputTokens = "";
    newModel.supportsReasoning = false;
    newModel.supportsToolCalling = false;
    newModel.supportsMultimodal = false;
  } catch (err) {
    modelError.value = err instanceof Error ? err.message : "添加模型失败";
  }
}

async function deleteModel(modelId: string) {
  if (!provider.value) return;
  modelError.value = "";
  try {
    await compute.deleteModel(provider.value.id, modelId);
  } catch (err) {
    modelError.value = err instanceof Error ? err.message : "删除模型失败";
  }
}
</script>

<style scoped>
.compute-detail-page {
  position: absolute;
  inset: 0;
  padding: 24px 24px 80px;
  color: var(--mc-text);
  background: var(--mc-bg);
  overflow-y: auto;
}

header {
  display: flex;
  align-items: center;
  gap: 16px;
  margin-bottom: 24px;
}

.head-title {
  flex: 1;
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
}

.head-title h1 {
  margin: 0;
  font-size: 24px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.base-url-summary {
  margin: 0;
  max-width: 45%;
  font-size: 13px;
  color: var(--mc-text-secondary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.api-pill {
  flex-shrink: 0;
  padding: 2px 10px;
  border-radius: 999px;
  border: 1px solid var(--mc-border);
  background: var(--mc-panel);
  color: var(--mc-text-secondary);
  font-size: 12px;
}

.load-error,
.op-error {
  color: var(--mc-danger);
  font-size: 13px;
}

.load-empty {
  color: var(--mc-text-tertiary);
  font-size: 13px;
  padding: 24px 0;
}

.section {
  margin-bottom: 28px;
}

.section h2 {
  margin: 0 0 12px;
  font-size: 17px;
}

.empty {
  color: var(--mc-text-tertiary);
  font-size: 13px;
}

.model-list {
  list-style: none;
  margin: 0;
  padding: 0;
}

.model-list li {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 10px 0;
  border-bottom: 1px solid var(--mc-border);
}

.model-info {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.model-capabilities {
  font-size: 12px;
  color: var(--mc-text-tertiary);
}

.add-model {
  display: flex;
  flex-direction: column;
  gap: 14px;
  padding: 16px;
  border-radius: 10px;
  border: 1px solid var(--mc-border);
  background: var(--mc-panel);
}

.form-row {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
  align-items: flex-end;
}

.field {
  display: flex;
  flex-direction: column;
  gap: 6px;
  flex: 1;
  min-width: 170px;
}

.field label,
.capability-label {
  font-size: 13px;
  color: var(--mc-text-secondary);
}

.field input:not([type="checkbox"]),
.field select {
  width: 100%;
  padding: 8px 12px;
  border-radius: 6px;
  border: 1px solid var(--mc-border);
  background: var(--mc-bg);
  color: var(--mc-text);
  font-size: 14px;
}

.field input:focus,
.field select:focus {
  outline: none;
  border-color: var(--mc-accent);
}

.capability-field {
  flex: 1.4;
  min-width: 300px;
}

.capability-checks {
  display: flex;
  gap: 16px;
  padding: 8px 0;
}

.capability-check {
  display: flex;
  align-items: center;
  gap: 4px;
  color: var(--mc-text);
  font-size: 13px;
  cursor: pointer;
}

.connection-actions {
  display: flex;
}

.test-result {
  margin: 12px 0 0;
  padding: 10px 12px;
  border-radius: 6px;
  background: var(--mc-panel);
  font-size: 13px;
  color: var(--mc-success);
}

.test-result.fail {
  color: var(--mc-danger);
}

.discovered-import {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 10px;
  margin-top: 12px;
}

.discovered-models {
  display: flex;
  flex-wrap: wrap;
  align-content: flex-start;
  gap: 6px;
  /* 50+ 型号时高度受控，区域内滚动，不无限撑高页面 */
  max-height: 200px;
  overflow-y: auto;
}

.discovered-chip {
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  padding: 4px 10px;
  border-radius: 999px;
  border: 1px solid var(--mc-border);
  background: var(--mc-bg);
  color: var(--mc-text-secondary);
  font-size: 12px;
}

.import-feedback {
  margin: 0;
  color: var(--mc-success);
  font-size: 13px;
}

.not-found {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 10px;
  padding: 48px 0;
  color: var(--mc-text-secondary);
}

.back-link {
  color: var(--mc-accent);
}

button {
  padding: 8px 16px;
  border-radius: 6px;
  cursor: pointer;
  font-size: 14px;
}

button:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

.btn-primary {
  border: none;
  background: var(--mc-accent);
  color: var(--mc-bg);
}

.btn-ghost {
  border: 1px solid var(--mc-border);
  background: transparent;
  color: var(--mc-text-secondary);
}

.btn-ghost:hover {
  border-color: var(--mc-text-secondary);
  color: var(--mc-text);
}

.btn-danger {
  border: 1px solid var(--mc-danger);
  background: transparent;
  color: var(--mc-danger);
}

.btn-danger:hover {
  background: var(--mc-danger);
  color: var(--mc-bg);
}
</style>
