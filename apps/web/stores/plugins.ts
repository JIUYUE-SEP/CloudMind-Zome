import { defineStore } from "pinia";
import { computed, ref } from "vue";
import { useEngineClient } from "@/composables/useEngineClient";
import type {
  AgentPluginManifestEntry,
  PluginLoadResult,
  PluginManifestUpdateResult,
  PluginSkipReason,
  PluginsManifest,
} from "@/composables/useEngineClient";
import { createListLoader } from "@/utils/list-loader";

// 跳过原因 → 中文可读文案（reason 取值是 engine 契约，镜像见 composables/useEngineClient.ts）
const SKIP_REASON_TEXT: Record<PluginSkipReason, string> = {
  disabled: "已在配置中禁用",
  "invalid-entry": "入口配置非法",
  "missing-entry": "缺少入口文件",
  "import-failed": "导入失败",
  "no-apply": "未实现 apply 入口",
  "invalid-name": "插件名非法",
  "name-mismatch": "插件名与清单不一致",
  "mount-failed": "挂载失败",
  "apply-failed": "apply 执行失败",
  pending: "待加载",
};

/** 跳过原因展示文案；契约外新增值兜底原样透出（不空白） */
export function skipReasonText(reason: PluginSkipReason): string {
  return SKIP_REASON_TEXT[reason] ?? reason;
}

/** perAgent 行状态文案："loaded" 是挂载成功，其余按跳过原因走 */
export function pluginStatusText(status: "loaded" | PluginSkipReason): string {
  return status === "loaded" ? "已加载" : skipReasonText(status);
}

export const usePluginsStore = defineStore("plugins", () => {
  const client = useEngineClient();
  // /plugins 响应是 {loaded, skipped, perAgent} 三段而非数组：
  // list-loader 以单元素数组承载整包（加载态/错误态/代际防脏写仍走共享模板），三段由 computed 派生
  const { list, isLoading, error, load: loadList } = createListLoader<PluginLoadResult>();

  const loaded = computed(() => list.value[0]?.loaded ?? []);
  const skipped = computed(() => list.value[0]?.skipped ?? []);
  const perAgent = computed(() => list.value[0]?.perAgent ?? []);

  async function load() {
    await loadList(async () => [await client.listPlugins()]);
  }

  // ---- M2 管理面：全局清单读写 + per-agent 清单读写（engine 契约见 useEngineClient.ts 镜像注释） ----

  // /plugins/manifest 响应 {plugins, unregistered} 同样非数组：沿用单元素承载模式
  const {
    list: manifestPack,
    isLoading: manifestLoading,
    error: manifestError,
    load: loadManifestList,
  } = createListLoader<PluginsManifest>();

  const manifestEntries = computed(() => manifestPack.value[0]?.plugins ?? []);
  const unregistered = computed(() => manifestPack.value[0]?.unregistered ?? []);

  async function loadManifest() {
    await loadManifestList(async () => [await client.getPluginsManifest()]);
  }

  // per-agent 清单响应的 plugins 字段本身是数组，可直接进 list-loader；
  // 切换 agent 的并发防脏写（迟到的旧 agent 响应不落地）由代际守卫兜住
  const {
    list: agentEntries,
    isLoading: agentLoading,
    error: agentError,
    load: loadAgentList,
  } = createListLoader<AgentPluginManifestEntry>();

  const selectedAgentId = ref("");

  async function selectAgent(agentId: string) {
    selectedAgentId.value = agentId;
    if (!agentId) {
      agentEntries.value = [];
      return;
    }
    await loadAgentList(async () => (await client.getAgentPluginsManifest(agentId)).plugins);
  }

  // 最近一次写操作错误（节内透出 err.message：engine 的 400/404/409 error 正文经 ensureOk 带上）
  const writeError = ref("");
  // 任何写成功后常驻提示（engine 无热重载：写只改清单文件，requiresRestart 恒 true）
  const restartHint = ref(false);

  // 写操作统一收口：错误透出 + 成功置重启提示；返回 null 表示失败，
  // UI 据此执行开关回弹 / 保持配置编辑器打开
  async function runWrite(op: () => Promise<PluginManifestUpdateResult>): Promise<PluginManifestUpdateResult | null> {
    writeError.value = "";
    try {
      const res = await op();
      restartHint.value = true;
      return res;
    } catch (err) {
      writeError.value = err instanceof Error ? err.message : "保存失败";
      return null;
    }
  }

  async function setPluginEnabled(name: string, enabled: boolean): Promise<boolean> {
    const res = await runWrite(() => client.updatePluginManifest(name, { enabled }));
    if (!res) return false;
    const entry = manifestEntries.value.find((e) => e.name === name);
    if (entry) entry.enabled = res.enabled;
    return true;
  }

  async function savePluginConfig(name: string, config: Record<string, unknown>): Promise<boolean> {
    const res = await runWrite(() => client.updatePluginManifest(name, { config }));
    if (!res) return false;
    const entry = manifestEntries.value.find((e) => e.name === name);
    if (entry) entry.config = res.config;
    return true;
  }

  // 登记：PUT enabled:true 创建条目；成功后从未登记区移入清单区
  // （engine 返回完整条目视图，本地搬运即可，无需整单重载）
  async function register(name: string): Promise<boolean> {
    const res = await runWrite(() => client.updatePluginManifest(name, { enabled: true }));
    if (!res) return false;
    const pack = manifestPack.value[0];
    if (pack) {
      pack.unregistered = pack.unregistered.filter((n) => n !== name);
      pack.plugins.push({ name: res.name, enabled: res.enabled, config: res.config, hasEntry: true });
    }
    return true;
  }

  async function setAgentPluginEnabled(name: string, enabled: boolean): Promise<boolean> {
    const agentId = selectedAgentId.value;
    if (!agentId) return false;
    const res = await runWrite(() => client.updateAgentPluginManifest(agentId, name, { enabled }));
    if (!res) return false;
    const entry = agentEntries.value.find((e) => e.name === name);
    if (entry) entry.enabled = res.enabled;
    return true;
  }

  return {
    loaded,
    skipped,
    perAgent,
    isLoading,
    error,
    load,
    manifestEntries,
    unregistered,
    manifestLoading,
    manifestError,
    loadManifest,
    selectedAgentId,
    agentEntries,
    agentLoading,
    agentError,
    selectAgent,
    writeError,
    restartHint,
    setPluginEnabled,
    savePluginConfig,
    register,
    setAgentPluginEnabled,
  };
});
