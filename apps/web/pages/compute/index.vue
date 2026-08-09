<template>
  <div class="compute-page">
    <header>
      <BackButton to="/" />
      <h1>算力中枢</h1>
      <button class="btn-primary" @click="openProviderModal()">添加 Provider</button>
    </header>

    <div v-if="compute.error" class="load-error">加载失败：{{ compute.error }}</div>
    <div v-else-if="compute.isLoading && !compute.providers.length" class="load-empty">加载中...</div>
    <div v-else-if="!compute.providers.length" class="load-empty">暂无 Provider，点击右上角添加</div>
    <div v-else class="providers">
      <div
        v-for="provider in compute.providers"
        :key="provider.id"
        class="provider-card"
        @click="openProvider(provider.id)"
      >
        <div class="card-head">
          <h3>{{ provider.displayName }}</h3>
          <span class="api-pill">{{ apiModeLabel(provider.apiMode) }}</span>
          <span class="manage-arrow" aria-hidden="true">›</span>
        </div>
        <p class="card-url">{{ provider.baseUrl }}</p>
        <p class="card-meta">模型数：{{ provider.models.length }}</p>
        <div class="actions">
          <button class="btn-ghost" @click.stop="editProvider(provider)">编辑</button>
          <button
            class="btn-ghost"
            :disabled="testingId !== null"
            @click.stop="testProvider(provider.id)"
          >
            {{ testingId === provider.id ? "测试中..." : "测试连接" }}
          </button>
          <button class="btn-danger" @click.stop="removeProvider(provider.id)">删除</button>
        </div>
        <p class="manage-hint">管理型号 →</p>
        <p
          v-if="testResult && testResult.providerId === provider.id"
          class="test-result"
          :class="{ fail: !testResult.ok }"
        >
          <template v-if="testResult.ok">
            <span>连接成功</span
            ><span v-if="testResult.discoveredCount"
              >（发现 {{ testResult.discoveredCount }} 个型号）</span
            ><NuxtLink
              v-if="testResult.discoveredCount"
              class="import-link"
              :to="`/compute/${encodeURIComponent(provider.id)}`"
              @click.stop
              >进入管理页导入 →</NuxtLink
            >
          </template>
          <template v-else>连接失败: {{ testResult.error }}</template>
        </p>
      </div>
    </div>

    <div v-if="showProviderModal" class="modal" @click.self="showProviderModal = false">
      <div class="modal-content">
        <h2>{{ editingProvider ? "编辑 Provider" : "添加 Provider" }}</h2>
        <div class="field">
          <label for="provider-name">名称</label>
          <input id="provider-name" v-model="providerForm.displayName" />
        </div>
        <div class="field">
          <label for="provider-url">Base URL</label>
          <input id="provider-url" v-model="providerForm.baseUrl" />
        </div>
        <div class="field">
          <label for="provider-mode">协议</label>
          <select id="provider-mode" v-model="providerForm.apiMode">
            <option value="chat_completions">OpenAI 兼容 · 缺省</option>
            <option value="responses">OpenAI Responses</option>
            <option value="anthropic">Anthropic Messages</option>
          </select>
        </div>
        <div class="field">
          <label for="provider-key">API Key</label>
          <input
            id="provider-key"
            v-model="providerForm.apiKey"
            type="password"
            :placeholder="editingProvider ? '留空则保持不变' : '请输入 API Key'"
          />
        </div>
        <div class="modal-actions">
          <button class="btn-ghost" @click="showProviderModal = false">取消</button>
          <button class="btn-primary" :disabled="saving" @click="saveProvider">
            {{ saving ? "保存中..." : "保存" }}
          </button>
        </div>
        <div v-if="modalError" class="op-error">{{ modalError }}</div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, reactive, watch, onMounted } from "vue";
import { useComputeStore } from "@/stores/compute";
import type { Provider } from "@/composables/useEngineClient";

const compute = useComputeStore();
const showProviderModal = ref(false);
const editingProvider = ref<Provider | null>(null);
// 测试连接最长 30s：进行中禁用所有测试按钮防连点，结果与 providerId 绑定防串台
const testingId = ref<string | null>(null);
const testResult = ref<{
  providerId: string;
  ok: boolean;
  error?: string;
  discoveredCount?: number;
} | null>(null);
const saving = ref(false);
const modalError = ref("");

type ApiMode = NonNullable<Provider["apiMode"]>;

const providerForm = reactive({
  displayName: "",
  baseUrl: "https://api.openai.com/v1",
  apiKey: "",
  apiMode: "chat_completions" as ApiMode,
});

onMounted(() => {
  compute.load();
});

// store 每次操作后全量重载 providers，editingProvider 会指向被替换掉的旧对象；
// 按 id 跟随最新快照，Provider 被删除时自动清空（隐藏编辑弹窗）
watch(
  () => compute.providers,
  (list) => {
    if (editingProvider.value) {
      editingProvider.value = list.find((p) => p.id === editingProvider.value!.id) ?? null;
    }
  },
);

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

function openProvider(id: string) {
  navigateTo(`/compute/${encodeURIComponent(id)}`);
}

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
    // 数量带回用于列表页「发现 N 个型号」引导；完整列表在管理页测试后展示
    testResult.value = { providerId: id, ok: true, discoveredCount: res.discovered?.length ?? 0 };
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
  position: relative;
  padding: 16px;
  border-radius: 10px;
  background: var(--mc-panel);
  border: 1px solid var(--mc-border);
  cursor: pointer;
  transition: border-color 0.15s, background 0.15s;
}

.provider-card:hover {
  border-color: var(--mc-accent);
}

.card-head {
  display: flex;
  align-items: center;
  gap: 8px;
}

.card-head h3 {
  flex: 1;
  margin: 0;
  font-size: 16px;
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

.manage-arrow {
  flex-shrink: 0;
  color: var(--mc-text-tertiary);
  font-size: 20px;
  line-height: 1;
  transition: color 0.15s, transform 0.15s;
}

.provider-card:hover .manage-arrow {
  color: var(--mc-accent);
  transform: translateX(2px);
}

.card-url {
  margin: 10px 0 0;
  font-size: 13px;
  color: var(--mc-text-secondary);
  word-break: break-all;
}

.card-meta {
  margin: 4px 0 0;
  font-size: 13px;
  color: var(--mc-text-tertiary);
}

.actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 14px;
}

.actions button {
  padding: 6px 12px;
  font-size: 13px;
}

.manage-hint {
  margin: 10px 0 0;
  font-size: 12px;
  color: var(--mc-accent);
  opacity: 0;
  transition: opacity 0.15s;
}

.provider-card:hover .manage-hint {
  opacity: 1;
}

.test-result {
  margin: 10px 0 0;
  padding: 10px 12px;
  border-radius: 6px;
  background: var(--mc-panel);
  font-size: 13px;
  color: var(--mc-success);
}

.test-result.fail {
  color: var(--mc-danger);
}

.import-link {
  margin-left: 8px;
  color: var(--mc-accent);
  text-decoration: underline;
  cursor: pointer;
}

.import-link:hover {
  color: var(--mc-text);
}

.modal {
  position: fixed;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  background: color-mix(in srgb, var(--mc-bg) 72%, transparent);
  z-index: 200;
}

.modal-content {
  width: 440px;
  max-width: calc(100vw - 48px);
  padding: 24px;
  border-radius: 10px;
  border: 1px solid var(--mc-border);
  background: var(--mc-bg);
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.modal-content h2 {
  margin: 0;
  font-size: 18px;
}

.field {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.field label {
  font-size: 13px;
  color: var(--mc-text-secondary);
}

.field input,
.field select {
  padding: 8px 12px;
  border-radius: 6px;
  border: 1px solid var(--mc-border);
  background: var(--mc-panel);
  color: var(--mc-text);
  font-size: 14px;
}

.field input:focus,
.field select:focus {
  outline: none;
  border-color: var(--mc-accent);
}

.modal-actions {
  display: flex;
  gap: 8px;
  justify-content: flex-end;
  margin-top: 4px;
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
