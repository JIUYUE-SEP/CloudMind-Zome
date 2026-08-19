import { defineStore } from "pinia";
import { useEngineClient } from "@/composables/useEngineClient";
import type { Session } from "@/composables/useEngineClient";
import { createListLoader } from "@/utils/list-loader";

export const useSessionsStore = defineStore("sessions", () => {
  const client = useEngineClient();
  // 加载态/错误态/代际防脏写走共享模板（D2 收敛）
  const { list: sessions, isLoading, error, load: loadList } = createListLoader<Session>();

  async function load() {
    await loadList(() => client.listSessions());
  }

  async function create(session: Omit<Session, "id" | "createdAt" | "updatedAt">) {
    const created = await client.createSession(session);
    sessions.value.push(created);
    return created;
  }

  async function rename(id: string, name: string) {
    // 重命名只下发 name（engine 只应用 name/agentIds，其余字段静默丢弃）
    const updated = await client.updateSession(id, { name });
    const idx = sessions.value.findIndex((s) => s.id === id);
    if (idx >= 0) sessions.value[idx] = updated;
    return updated;
  }

  async function remove(id: string) {
    await client.deleteSession(id);
    sessions.value = sessions.value.filter((s) => s.id !== id);
  }

  return { sessions, isLoading, error, load, create, rename, remove };
});
