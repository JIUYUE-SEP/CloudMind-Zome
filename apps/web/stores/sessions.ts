import { defineStore } from "pinia";
import { ref } from "vue";
import { useEngineClient } from "@/composables/useEngineClient";
import type { Session } from "@/composables/useEngineClient";

export const useSessionsStore = defineStore("sessions", () => {
  const client = useEngineClient();
  const sessions = ref<Session[]>([]);
  const isLoading = ref(false);
  const error = ref("");

  async function load() {
    isLoading.value = true;
    error.value = "";
    try {
      sessions.value = await client.listSessions();
    } catch (err) {
      error.value = err instanceof Error ? err.message : "加载失败";
    } finally {
      isLoading.value = false;
    }
  }

  async function create(session: Omit<Session, "id" | "createdAt" | "updatedAt">) {
    const created = await client.createSession(session);
    sessions.value.push(created);
    return created;
  }

  async function update(id: string, patch: Partial<Session>) {
    const updated = await client.updateSession(id, patch);
    const idx = sessions.value.findIndex((s) => s.id === id);
    if (idx >= 0) sessions.value[idx] = updated;
    return updated;
  }

  async function remove(id: string) {
    await client.deleteSession(id);
    sessions.value = sessions.value.filter((s) => s.id !== id);
  }

  return { sessions, isLoading, error, load, create, update, remove };
});
