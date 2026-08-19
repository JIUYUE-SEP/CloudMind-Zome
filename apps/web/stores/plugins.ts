import { defineStore } from "pinia";
import { computed } from "vue";
import { useEngineClient } from "@/composables/useEngineClient";
import type { PluginLoadResult, PluginSkipReason } from "@/composables/useEngineClient";
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

  return { loaded, skipped, perAgent, isLoading, error, load };
});
