import { defineStore } from "pinia";
import { ref } from "vue";
import { useEngineClient } from "@/composables/useEngineClient";
import type { ModelInfo, Provider } from "@/composables/useEngineClient";

export const useComputeStore = defineStore("compute", () => {
  const client = useEngineClient();
  const providers = ref<Provider[]>([]);
  const isLoading = ref(false);
  // 是否已完成至少一次 load（成功或失败）：区分「加载中」与「确认不存在」
  const hasLoaded = ref(false);
  const error = ref("");

  async function load() {
    isLoading.value = true;
    error.value = "";
    try {
      providers.value = await client.listProviders();
    } catch (err) {
      error.value = err instanceof Error ? err.message : "加载失败";
    } finally {
      isLoading.value = false;
      hasLoaded.value = true;
    }
  }

  async function addProvider(body: Omit<Provider, "id">) {
    const created = await client.createProvider(body);
    await load();
    return created;
  }

  async function updateProvider(id: string, body: Partial<Provider>) {
    const updated = await client.updateProvider(id, body);
    await load();
    return updated;
  }

  async function deleteProvider(id: string) {
    await client.deleteProvider(id);
    await load();
  }

  async function testConnection(id: string) {
    return client.testProvider(id);
  }

  function getProvider(id: string) {
    return providers.value.find((p) => p.id === id);
  }

  async function addModel(providerId: string, body: ModelInfo) {
    const created = await client.addModel(providerId, body);
    await load();
    return created;
  }

  async function updateModel(providerId: string, modelId: string, body: Partial<ModelInfo>) {
    const updated = await client.updateModel(providerId, modelId, body);
    await load();
    return updated;
  }

  async function deleteModel(providerId: string, modelId: string) {
    await client.deleteModel(providerId, modelId);
    await load();
  }

  return {
    providers,
    isLoading,
    hasLoaded,
    error,
    load,
    addProvider,
    updateProvider,
    deleteProvider,
    testConnection,
    getProvider,
    addModel,
    updateModel,
    deleteModel,
  };
});
