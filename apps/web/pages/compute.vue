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
              ? testResult.discovered
                ? `连接成功（发现 ${testResult.discovered} 个模型）`
                : "连接成功"
              : `连接失败: ${testResult.error}`
          }}
        </p>
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
          API Key
          <input v-model="providerForm.apiKey" type="password" placeholder="留空则保持不变" />
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
          {{ model.displayName || model.id }} ({{ model.modelType }})
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
const testResult = ref<{ providerId: string; ok: boolean; error?: string; discovered?: number } | null>(null);
const saving = ref(false);
const modalError = ref("");
const modelError = ref("");

const providerForm = reactive({
  displayName: "",
  baseUrl: "https://api.openai.com/v1",
  apiKey: "",
});

const newModel = reactive<ModelInfo>({
  id: "",
  displayName: "",
  modelType: "llm",
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
  modalError.value = "";
  showProviderModal.value = true;
}

function editProvider(provider: Provider) {
  editingProvider.value = provider;
  providerForm.displayName = provider.displayName;
  providerForm.baseUrl = provider.baseUrl;
  providerForm.apiKey = "";
  modalError.value = "";
  showProviderModal.value = true;
}

async function saveProvider() {
  saving.value = true;
  modalError.value = "";
  try {
    if (editingProvider.value) {
      await compute.updateProvider(editingProvider.value.id, { ...providerForm });
    } else {
      await compute.addProvider({
        displayName: providerForm.displayName,
        providerType: "openai",
        baseUrl: providerForm.baseUrl,
        apiKey: providerForm.apiKey,
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
    testResult.value = { providerId: id, ok: true, discovered: res.discovered?.length };
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

async function addModel() {
  if (!editingProvider.value || !newModel.id) return;
  modelError.value = "";
  // engine 侧不查重，重复 id 会让 :key 撞车且语义含糊
  if (editingProvider.value.models.some((m) => m.id === newModel.id)) {
    modelError.value = `模型 ID 已存在：${newModel.id}`;
    return;
  }
  try {
    await compute.addModel(editingProvider.value.id, { ...newModel });
    newModel.id = "";
    newModel.displayName = "";
    newModel.modelType = "llm";
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

.add-model {
  display: flex;
  gap: 8px;
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
