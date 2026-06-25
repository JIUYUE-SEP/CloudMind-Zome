<template>
  <div class="compute-page">
    <header>
      <h1>算力中枢</h1>
      <button @click="openProviderModal()">添加 Provider</button>
    </header>

    <div class="providers">
      <div v-for="provider in compute.providers" :key="provider.id" class="provider-card" @click="editProvider(provider)">
        <h3>{{ provider.displayName }}</h3>
        <p>{{ provider.baseUrl }}</p>
        <p>模型数: {{ provider.models.length }}</p>
        <div class="actions">
          <button @click.stop="testProvider(provider.id)">测试连接</button>
          <button @click.stop="compute.deleteProvider(provider.id)">删除</button>
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
          API Key
          <input v-model="providerForm.apiKey" type="password" placeholder="留空则保持不变" />
        </label>
        <div class="modal-actions">
          <button @click="saveProvider">保存</button>
          <button @click="showProviderModal = false">取消</button>
        </div>
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
    </div>

    <div v-if="testResult" class="test-result">
      <p>{{ testResult.ok ? "连接成功" : `连接失败: ${testResult.error}` }}</p>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, reactive, onMounted } from "vue";
import { useComputeStore } from "@/stores/compute";
import type { Provider, ModelInfo } from "@/composables/useEngineClient";

const compute = useComputeStore();
const showProviderModal = ref(false);
const editingProvider = ref<Provider | null>(null);
const testResult = ref<{ ok: boolean; error?: string } | null>(null);

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

function openProviderModal() {
  editingProvider.value = null;
  providerForm.displayName = "";
  providerForm.baseUrl = "https://api.openai.com/v1";
  providerForm.apiKey = "";
  showProviderModal.value = true;
}

function editProvider(provider: Provider) {
  editingProvider.value = provider;
  providerForm.displayName = provider.displayName;
  providerForm.baseUrl = provider.baseUrl;
  providerForm.apiKey = "";
  showProviderModal.value = true;
}

async function saveProvider() {
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
}

async function testProvider(id: string) {
  testResult.value = await compute.testConnection(id);
}

async function addModel() {
  if (!editingProvider.value || !newModel.id) return;
  await compute.addModel(editingProvider.value.id, { ...newModel });
  newModel.id = "";
  newModel.displayName = "";
  newModel.modelType = "llm";
}

async function deleteModel(modelId: string) {
  if (!editingProvider.value) return;
  await compute.deleteModel(editingProvider.value.id, modelId);
}
</script>

<style scoped>
.compute-page {
  padding: 24px;
  color: #d8e1ec;
  background: #0b0f17;
  min-height: 100vh;
}
header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 24px;
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
  background: rgba(255, 255, 255, 0.08);
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
}
.modal-content {
  width: 400px;
  padding: 24px;
  border-radius: 8px;
  background: #0b0f17;
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
  color: #d8e1ec;
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
  border-bottom: 1px solid rgba(255, 255, 255, 0.08);
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
  color: #d8e1ec;
}
.test-result {
  margin-top: 16px;
  padding: 12px;
  border-radius: 6px;
  background: rgba(255, 255, 255, 0.05);
}
</style>
