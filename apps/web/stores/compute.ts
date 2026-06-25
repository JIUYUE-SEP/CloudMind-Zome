import { defineStore } from "pinia";
import { ref, computed } from "vue";
import { useEngineClient } from "@/composables/useEngineClient";
import type { ModelInfo, Provider } from "@/composables/useEngineClient";

export const useComputeStore = defineStore("compute", () => {
  const client = useEngineClient();
  const providers = ref<Provider[]>([]);
  const isLoading = ref(false);

  async function load() {
    isLoading.value = true;
    try {
      providers.value = await client.listProviders();
    } finally {
      isLoading.value = false;
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

  function getModel(providerId: string, modelId: string) {
    return getProvider(providerId)?.models.find((m) => m.id === modelId);
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

  const llmModels = computed(() =>
    providers.value.flatMap((p) =>
      p.models.filter((m) => m.modelType === "llm").map((m) => ({ ...m, providerId: p.id })),
    ),
  );
  const embeddingModels = computed(() =>
    providers.value.flatMap((p) =>
      p.models.filter((m) => m.modelType === "embedding").map((m) => ({ ...m, providerId: p.id })),
    ),
  );
  const imageModels = computed(() =>
    providers.value.flatMap((p) =>
      p.models.filter((m) => m.modelType === "image").map((m) => ({ ...m, providerId: p.id })),
    ),
  );

  return {
    providers,
    isLoading,
    load,
    addProvider,
    updateProvider,
    deleteProvider,
    testConnection,
    getProvider,
    getModel,
    addModel,
    updateModel,
    deleteModel,
    llmModels,
    embeddingModels,
    imageModels,
  };
});
