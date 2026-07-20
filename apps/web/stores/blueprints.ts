import { defineStore } from "pinia";
import { ref } from "vue";
import { useEngineClient } from "@/composables/useEngineClient";
import type { Blueprint, BlueprintExecution } from "@/composables/useEngineClient";

export const useBlueprintsStore = defineStore("blueprints", () => {
  const client = useEngineClient();
  const blueprints = ref<Blueprint[]>([]);
  const isLoading = ref(false);
  const error = ref("");

  async function load() {
    isLoading.value = true;
    error.value = "";
    try {
      blueprints.value = await client.listBlueprints();
    } catch (err) {
      error.value = err instanceof Error ? err.message : "加载失败";
    } finally {
      isLoading.value = false;
    }
  }

  async function create(blueprint: Omit<Blueprint, "id" | "createdAt" | "updatedAt">) {
    const created = await client.createBlueprint(blueprint);
    blueprints.value.push(created);
    return created;
  }

  async function update(id: string, patch: Partial<Blueprint>) {
    const updated = await client.updateBlueprint(id, patch);
    const idx = blueprints.value.findIndex((b) => b.id === id);
    if (idx >= 0) blueprints.value[idx] = updated;
    return updated;
  }

  async function remove(id: string) {
    await client.deleteBlueprint(id);
    blueprints.value = blueprints.value.filter((b) => b.id !== id);
  }

  async function execute(id: string, initialInput?: string): Promise<BlueprintExecution> {
    return client.executeBlueprint(id, initialInput);
  }

  return { blueprints, isLoading, error, load, create, update, remove, execute };
});
