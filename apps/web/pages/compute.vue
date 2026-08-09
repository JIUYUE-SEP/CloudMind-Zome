<template>
  <div class="compute-page">
    <header>
      <BackButton to="/" />
      <h1>算力中枢</h1>
      <button @click="openProviderModal()">添加 Provider</button>
    </header>

    <div v-if="compute.error" class="load-error">加载失败：{{ compute.error }}</div>
    <div v-else-if="compute.isLoading && !compute.providers.length" class="load-empty">加载中...</div>
    <div v-else-if="!compute.providers.length" class="load-empty">暂无 Provider，点击右上角添加</div>
    <div class="providers">
      <div v-for="provider in compute.providers" :key="provider.id" class="provider-card" @click="editProvider(provider)">
        <h3>{{ provider.displayName }}</h3>
        <p>{{ provider.baseUrl }}</p>
        <p>模型数: {{ provider.models.length }}</p>
        <div class="actions">
          <button :disabled="testingId !== null" @click.stop="testProvider(provider.id)">
            {{ testingId === provider.id ? "测试中..." : "测试连接" }}
          </button>
          <button @click.stop="removeProvider(provider.id)">删除</button>
        </div>
        <p
          v-if="testResult && testResult.providerId === provider.id"
          class="test-result"
          :class="{ fail: !testResult.ok }"
        >
          {{
            testResult.ok
              ? testResult.discovered?.length
                ? `连接成功（发现 ${testResult.discovered.length} 个模型）`
                : "连接成功"
              : `连接失败: ${testResult.error}`
          }}
        </p>
        <div
          v-if="testResult && testResult.ok && testResult.providerId === provider.id && testResult.discovered?.length"
          class="discovered-import"
        >
          <span class="discovered-models">{{ testResult.discovered.map((m) => m.id).join("、") }}</span>
          <button :disabled="importing" @click.stop="importDiscovered">
            {{ importing ? "导入中..." : "全部导入" }}
          </button>
          <p v-if="importFeedback" class="import-feedback">{{ importFeedback }}</p>
        </div>
      </div>
    </div>

    <div v-if="showProviderModal" class="modal" @click.self="showProviderModal = false">
      <div class="modal-content">
        <h2>{{ editingProvider ? "编辑 Provider" : "添加 Provider" }}</h2>
        <label>
          名称
          <input v-model="providerForm.displayName" />
        </label>
        <label>
          Base URL
          <input v-model="providerForm.baseUrl" />
        </label>
        <label>
          协议
          <select v-model="providerForm.apiMode">
            <option value="chat_completions">OpenAI 兼容 · 缺省</option>
            <option value="responses">OpenAI Responses</option>
            <option value="anthropic">Anthropic Messages</option>
          </select>
        </label>
        <label>
          API Key
          <input
            v-model="providerForm.apiKey"
            type="password"
            :placeholder="editingProvider ? '留空则保持不变' : '请输入 API Key'"
          />
        </label>
        <div class="modal-actions">
          <button :disabled="saving" @click="saveProvider">{{ saving ? "保存中..." : "保存" }}</button>
          <button @click="showProviderModal = false">取消</button>
        </div>
        <div v-if="modalError" class="op-error">{{ modalError }}</div>
      </div>
    </div>

    <div v-if="editingProvider" class="models-section">
      <h2>模型管理 - {{ editingProvider.displayName }}</h2>
      <ul>
        <li v-for="model in editingProvider.models" :key="model.id">
          <span class="model-info">
            {{ model.displayName || model.id }} ({{ model.modelType }})
            <small v-if="capabilityLabel(model)" class="model-capabilities">
              {{ capabilityLabel(model) }}
            </small>
          </span>
          <button @click="deleteModel(model.id)">删除</button>
        </li>
      </ul>
      <div class="add-model">
        <input v-model="newModel.id" placeholder="模型 ID" />
        <input v-model="newModel.displayName" placeholder="显示名称" />
        <select v-model="newModel.modelType">
          <option value="llm">LLM</option>
          <option value="embedding">Embedding</option>
          <option value="image">Image</option>
          <option value="stt">STT</option>
        </select>
        <input
          v-model.number="newModel.contextWindow"
          type="number"
          min="1"
          placeholder="上下文窗口（留空未知）"
        />
        <input
          v-model.number="newModel.maxOutputTokens"
          type="number"
          min="1"
          placeholder="最大输出 tokens（留空未知）"
        />
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
        <button @click="addModel">添加模型</button>
      </div>
      <div v-if="modelError" class="op-error">{{ modelError }}</div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, reactive, watch, onMounted } from "vue";
import { useComputeStore } from "@/stores/compute";
import type { Provider, ModelInfo } from "@/composables/useEngineClient";

const compute = useComputeStore();
const showProviderModal = ref(false);
const editingProvider = ref<Provider | null>(null);
// 测试连接最长 30s：进行中禁用所有测试按钮防连点，结果与 providerId 绑定防串台
const testingId = ref<string | null>(null);
const testResult = ref<{ providerId: string; ok: boolean; error?: string; discovered?: ModelInfo[] } | null>(null);
const importing = ref(false);
const importFeedback = ref("");
const saving = ref(false);
const modalError = ref("");
const modelError = ref("");

type ApiMode = NonNullable<Provider["apiMode"]>;

const providerForm = reactive({
  displayName: "",
  baseUrl: "https://api.openai.com/v1",
  apiKey: "",
  apiMode: "chat_completions" as ApiMode,
});

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

onMounted(() => {
  compute.load();
});

// store 每次操作后全量重载 providers，editingProvider 会指向被替换掉的旧对象；
// 按 id 跟随最新快照，Provider 被删除时自动清空（隐藏模型管理区）
watch(
  () => compute.providers,
  (list) => {
    if (editingProvider.value) {
      editingProvider.value = list.find((p) => p.id === editingProvider.value!.id) ?? null;
    }
  },
);

function openProviderModal() {
  editingProvider.value = null;
  providerForm.displayName = "";
  providerForm.baseUrl = "https://api.openai.com/v1";
  providerForm.apiKey = "";
  providerForm.apiMode = "chat_completions";
  modalError.value = "";
  showProviderModal.value = true;
}

function editProvider(provider: Provider) {
  editingProvider.value = provider;
  providerForm.displayName = provider.displayName;
  providerForm.baseUrl = provider.baseUrl;
  providerForm.apiKey = "";
  providerForm.apiMode = provider.apiMode ?? "chat_completions";
  modalError.value = "";
  showProviderModal.value = true;
}

async function saveProvider() {
  saving.value = true;
  modalError.value = "";
  try {
    if (editingProvider.value) {
      await compute.updateProvider(editingProvider.value.id, {
        displayName: providerForm.displayName,
        baseUrl: providerForm.baseUrl,
        apiMode: providerForm.apiMode,
        apiKey: providerForm.apiKey,
      });
    } else {
      await compute.addProvider({
        displayName: providerForm.displayName,
        providerType: "openai",
        baseUrl: providerForm.baseUrl,
        apiMode: providerForm.apiMode,
        // 添加时未填 API Key 则不落字段（区别于编辑时"留空保持"语义）
        ...(providerForm.apiKey ? { apiKey: providerForm.apiKey } : {}),
        models: [],
      });
    }
    showProviderModal.value = false;
  } catch (err) {
    modalError.value = err instanceof Error ? err.message : "保存失败";
  } finally {
    saving.value = false;
  }
}

async function removeProvider(id: string) {
  if (!confirm("确定删除这个 Provider 吗？")) return;
  try {
    await compute.deleteProvider(id);
  } catch (err) {
    alert(err instanceof Error ? err.message : "删除失败");
  }
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
  if (!result?.ok || !result.discovered?.length) return;
  const provider = compute.providers.find((p) => p.id === result.providerId);
  if (!provider) return;
  importing.value = true;
  importFeedback.value = "";
  try {
    const existing = new Set(provider.models.map((m) => m.id));
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
        await compute.addModel(provider.id, model);
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

async function addModel() {
  if (!editingProvider.value || !newModel.id) return;
  modelError.value = "";
  const modelId = newModel.id.trim();
  // engine 侧不查重，重复 id 会让 :key 撞车且语义含糊
  if (editingProvider.value.models.some((m) => m.id === modelId)) {
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
    await compute.addModel(editingProvider.value.id, payload);
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
  if (!editingProvider.value) return;
  modelError.value = "";
  try {
    await compute.deleteModel(editingProvider.value.id, modelId);
  } catch (err) {
    modelError.value = err instanceof Error ? err.message : "删除模型失败";
  }
}
</script>

<style scoped>
.compute-page {
  position: absolute;
  inset: 0;
  padding: 24px 24px 80px;
  color: var(--mc-text);
  background: var(--mc-bg);
  overflow-y: auto;
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

header {
  display: flex;
  align-items: center;
  gap: 16px;
  margin-bottom: 24px;
}

header h1 {
  flex: 1;
  margin: 0;
  font-size: 24px;
}

.providers {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
  gap: 16px;
}

.provider-card {
  padding: 16px;
  border-radius: 8px;
  background: rgba(255, 255, 255, 0.05);
  cursor: pointer;
}

.provider-card:hover {
  background: var(--mc-border);
}

.actions {
  display: flex;
  gap: 8px;
  margin-top: 12px;
}

.modal {
  position: fixed;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(0, 0, 0, 0.6);
  z-index: 200;
}

.modal-content {
  width: 400px;
  padding: 24px;
  border-radius: 8px;
  background: var(--mc-bg);
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.modal-content label {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.modal-content input,
.modal-content select {
  padding: 8px 12px;
  border-radius: 6px;
  border: 1px solid rgba(255, 255, 255, 0.1);
  background: rgba(255, 255, 255, 0.05);
  color: var(--mc-text);
}

.modal-actions {
  display: flex;
  gap: 8px;
  justify-content: flex-end;
}

.models-section {
  margin-top: 32px;
}

.models-section ul {
  list-style: none;
  padding: 0;
}

.models-section li {
  display: flex;
  justify-content: space-between;
  padding: 8px 0;
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
  gap: 8px;
  flex-wrap: wrap;
  align-items: center;
  margin-top: 16px;
}

.add-model input,
.add-model select {
  padding: 8px 12px;
  border-radius: 6px;
  border: 1px solid rgba(255, 255, 255, 0.1);
  background: rgba(255, 255, 255, 0.05);
  color: var(--mc-text);
}

.capability-check {
  display: flex;
  align-items: center;
  gap: 4px;
  color: var(--mc-text);
  font-size: 13px;
}

.test-result {
  margin: 10px 0 0;
  padding: 12px;
  border-radius: 6px;
  background: rgba(255, 255, 255, 0.05);
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
  gap: 8px;
  margin-top: 10px;
  font-size: 13px;
}

.discovered-models {
  color: var(--mc-text-secondary);
  word-break: break-all;
}

.import-feedback {
  margin: 0;
  color: var(--mc-success);
  font-size: 13px;
}

button {
  padding: 8px 16px;
  border-radius: 6px;
  border: none;
  background: var(--mc-accent);
  color: var(--mc-bg);
  cursor: pointer;
  font-size: 14px;
}

button:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}
</style>
