import { defineStore } from "pinia";
import { ref } from "vue";
import { useEngineClient } from "@/composables/useEngineClient";
import type { ModelInfo, Provider } from "@/composables/useEngineClient";
import { createListLoader } from "@/utils/list-loader";

export const useComputeStore = defineStore("compute", () => {
  const client = useEngineClient();
  // 加载态/错误态/代际防脏写走共享模板（D2 收敛）
  const { list: providers, isLoading, error, load: loadList } = createListLoader<Provider>();
  // 是否已完成至少一次 load（成功或失败）：区分「加载中」与「确认不存在」
  const hasLoaded = ref(false);

  async function load() {
    await loadList(() => client.listProviders());
    // loadList 落定即记（成功或失败都算），语义同原 finally
    hasLoaded.value = true;
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
    deleteModel,
  };
});
