import { defineStore } from "pinia";
import { ref } from "vue";
import { useEngineClient } from "@/composables/useEngineClient";
import type { AppSettings, SystemInfo, ToolInfo } from "@/composables/useEngineClient";

export const useSettingsStore = defineStore("settings", () => {
  const client = useEngineClient();
  const settings = ref<AppSettings | null>(null);
  const tools = ref<ToolInfo[]>([]);
  const systemInfo = ref<SystemInfo | null>(null);
  const systemInfoError = ref("");
  const loadError = ref("");
  const saveState = ref<"" | "saving" | "saved" | "error">("");
  const saveError = ref("");

  async function load() {
    loadError.value = "";
    saveState.value = "";
    try {
      const data = await client.getConfig();
      settings.value = {
        memory: data.memory,
        tavilyApiKey: data.tavilyApiKey || "",
        sidecarAutoStart: data.sidecarAutoStart ?? false,
      };
    } catch (err) {
      loadError.value = err instanceof Error ? err.message : "加载失败";
    }
  }

  async function save() {
    if (!settings.value) return;
    saveState.value = "saving";
    saveError.value = "";
    try {
      // v-model.number 清空输入会得到 ""：非有限数的字段不下发，
      // 避免空字符串写进 engine 的 memory 配置（缺省字段由 engine 保留旧值）
      const memory = Object.fromEntries(
        Object.entries(settings.value.memory).filter(([, v]) => Number.isFinite(v)),
      ) as unknown as AppSettings["memory"];
      // "***" 是 GET 掩码：不提交（engine 侧也防御）；空字符串语义是"清除 key"，必须原样提交
      const tavilyApiKey = settings.value.tavilyApiKey;
      await client.updateConfig({
        memory,
        ...(tavilyApiKey !== undefined && tavilyApiKey !== "***" ? { tavilyApiKey } : {}),
        // 布尔开关恒下发（undefined 语义是"不修改"，会吃掉用户在面板上的显式关闭）
        sidecarAutoStart: settings.value.sidecarAutoStart === true,
      });
      saveState.value = "saved";
    } catch (err) {
      saveState.value = "error";
      saveError.value = err instanceof Error ? err.message : "保存失败";
    }
  }

  async function loadTools() {
    try {
      tools.value = await client.getTools();
    } catch {
      // 工具列表加载失败不阻塞设置表单
    }
  }

  async function loadSystemInfo() {
    systemInfoError.value = "";
    try {
      systemInfo.value = await client.getSystemInfo();
    } catch (err) {
      // 系统信息是只读展示，失败只在本节内透出，不阻塞设置表单（口径同 loadTools）
      systemInfoError.value = err instanceof Error ? err.message : "加载失败";
    }
  }

  return {
    settings,
    tools,
    systemInfo,
    systemInfoError,
    loadError,
    saveState,
    saveError,
    load,
    save,
    loadTools,
    loadSystemInfo,
  };
});
