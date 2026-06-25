import { defineStore } from "pinia";
import { ref } from "vue";
import { useEngineClient } from "@/composables/useEngineClient";
import type { AppSettings, ToolInfo } from "@/composables/useEngineClient";

export const useSettingsStore = defineStore("settings", () => {
  const client = useEngineClient();
  const settings = ref<AppSettings | null>(null);
  const tools = ref<ToolInfo[]>([]);

  async function load() {
    const data = await client.getConfig();
    settings.value = {
      memory: data.memory,
      tavilyApiKey: data.tavilyApiKey || "",
    };
  }

  async function save() {
    if (!settings.value) return;
    await client.updateConfig({
      memory: settings.value.memory,
      tavilyApiKey: settings.value.tavilyApiKey,
    });
  }

  async function loadTools() {
    tools.value = await client.getTools();
  }

  return { settings, tools, load, save, loadTools };
});
