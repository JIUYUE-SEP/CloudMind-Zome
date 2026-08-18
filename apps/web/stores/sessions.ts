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

  return { sessions, isLoading, error, load, create };
});
