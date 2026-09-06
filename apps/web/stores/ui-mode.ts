import { defineStore } from "pinia";
import { getCurrentInstance, onMounted, ref } from "vue";

const MODE_KEY = "cloudmind.agentMode";
const AGENT_KEY = "cloudmind.singleAgentId";

export type AgentMode = "single" | "multi";

/**
 * 单/多模式（web 纯呈现层，决策 1-3）：状态只进 localStorage 不写 engine
 * （同用户档案纯前端先例）。缺省 multi = 现状逐字节恒等。
 * - 单模式：hub 直达 singleAgentId 私聊，藏群聊入口/广播站/群聊会话；
 *   **保留 agents 管理页**（模式切使用面不切管理面）。
 * - singleAgentId 失效（agent 被删）→ reconcile 自动回退 multi + 页面内提示。
 */
export const useUiModeStore = defineStore("uiMode", () => {
  const agentMode = ref<AgentMode>("multi");
  const singleAgentId = ref("");
  /** 页面内提示（回退等），展示方读后 clearNotice */
  const notice = ref("");

  // 纯前端状态：仅客户端读 localStorage（SSR/无 storage 环境保持缺省 multi 恒等）。
  // 创建期读一次不够——Nuxt SSR 会把服务端状态（multi）随水合 payload 覆盖进
  // store（刷新时 single 被打回 multi 的实证现场）：客户端挂载后再读一次以对盘为准
  const hydrateFromStorage = (): void => {
    const mode = localStorage.getItem(MODE_KEY);
    if (mode === "single" || mode === "multi") agentMode.value = mode;
    singleAgentId.value = localStorage.getItem(AGENT_KEY) ?? "";
  };
  if (import.meta.client) {
    hydrateFromStorage();
    if (getCurrentInstance()) onMounted(hydrateFromStorage);
  }

  function persist(): void {
    if (!import.meta.client) return;
    localStorage.setItem(MODE_KEY, agentMode.value);
    localStorage.setItem(AGENT_KEY, singleAgentId.value);
  }

  function setMode(mode: AgentMode): void {
    agentMode.value = mode;
    persist();
  }

  /** 单模式下选择 agent（选择即保持/进入单模式） */
  function selectAgent(id: string): void {
    singleAgentId.value = id;
    agentMode.value = "single";
    persist();
  }

  /**
   * 名录对账（决策 3）：单模式选中的 agent 已不存在（被删）→ 自动回退
   * 多模式 + 页面内提示。未选 agent（空 id）不算失效——保持单模式等用户选择。
   */
  function reconcile(agents: Array<{ id: string }>): void {
    if (agentMode.value !== "single" || !singleAgentId.value) return;
    if (agents.some((a) => a.id === singleAgentId.value)) return;
    agentMode.value = "multi";
    singleAgentId.value = "";
    persist();
    notice.value = "单模式中的心智已被删除，已回退多模式";
  }

  function clearNotice(): void {
    notice.value = "";
  }

  return { agentMode, singleAgentId, notice, setMode, selectAgent, reconcile, clearNotice };
});
