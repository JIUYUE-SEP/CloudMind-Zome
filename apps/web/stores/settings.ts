import { defineStore } from "pinia";
import { ref } from "vue";
import { useEngineClient } from "@/composables/useEngineClient";
import type { AppSettings, ToolInfo } from "@/composables/useEngineClient";

export const useSettingsStore = defineStore("settings", () => {
  const client = useEngineClient();
  const settings = ref<AppSettings | null>(null);
  const tools = ref<ToolInfo[]>([]);
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
      // "***" 是 GET 掩码：原样回传会覆盖真实密钥（engine 侧已同样防御），这里直接不提交
      const tavilyApiKey =
        settings.value.tavilyApiKey && settings.value.tavilyApiKey !== "***"
          ? settings.value.tavilyApiKey
          : undefined;
      await client.updateConfig({
        memory: settings.value.memory,
        ...(tavilyApiKey ? { tavilyApiKey } : {}),
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

  return { settings, tools, loadError, saveState, saveError, load, save, loadTools };
});
