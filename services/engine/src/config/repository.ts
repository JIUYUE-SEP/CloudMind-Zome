import fs from "node:fs/promises";
import path from "node:path";
import { decrypt, encrypt } from "./crypto.js";
import { getDataDir } from "./paths.js";

export interface ModelInfo {
  id: string;
  displayName: string;
  modelType: "llm" | "embedding" | "image" | "stt";
  contextWindow?: number;
  maxOutputTokens?: number;
  supportsReasoning?: boolean;
  supportsToolCalling?: boolean;
  supportsMultimodal?: boolean;
}

export interface ProviderConfig {
  id: string;
  displayName: string;
  providerType: "openai";
  baseUrl: string;
  apiKey?: string;
  models: ModelInfo[];
  requestTimeout?: number;
  maxRetries?: number;
}

export interface MemorySettings {
  compactThreshold: number;
  keepRecent: number;
  hotMemoryLimit: number;
  warmMemoryLimit: number;
}

export interface AppSettings {
  tavilyApiKey?: string;
  memory: MemorySettings;
}

export interface GlobalConfig {
  providers: ProviderConfig[];
  settings: AppSettings;
}

const DEFAULT_CONFIG: GlobalConfig = {
  providers: [],
  settings: {
    memory: {
      compactThreshold: 0.8,
      keepRecent: 3,
      hotMemoryLimit: 10,
      warmMemoryLimit: 20,
    },
  },
};

async function decryptValue(value: string | undefined): Promise<string | undefined> {
  if (!value) return undefined;
  if (!value.startsWith("enc:")) return value;
  try {
    return await decrypt(value.slice(4));
  } catch {
    return undefined;
  }
}

export class ConfigRepository {
  private filePath: string;

  constructor() {
    this.filePath = path.join(getDataDir(), "config.json");
  }

  async load(): Promise<GlobalConfig> {
    try {
      const text = await fs.readFile(this.filePath, "utf-8");
      const parsed = JSON.parse(text) as Partial<GlobalConfig>;
      const config: GlobalConfig = {
        ...DEFAULT_CONFIG,
        ...parsed,
        settings: { ...DEFAULT_CONFIG.settings, ...parsed.settings },
      };

      for (const provider of config.providers) {
        provider.apiKey = await decryptValue(provider.apiKey);
      }
      if (config.settings) {
        config.settings.tavilyApiKey = await decryptValue(config.settings.tavilyApiKey);
      }

      return config;
    } catch {
      return DEFAULT_CONFIG;
    }
  }

  async save(config: GlobalConfig): Promise<void> {
    const toSave: GlobalConfig = {
      ...config,
      providers: await Promise.all(
        config.providers.map(async (p) => ({
          ...p,
          apiKey: p.apiKey ? `enc:${await encrypt(p.apiKey)}` : undefined,
        })),
      ),
      settings: {
        ...config.settings,
        tavilyApiKey: config.settings.tavilyApiKey
          ? `enc:${await encrypt(config.settings.tavilyApiKey)}`
          : undefined,
      },
    };
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    await fs.writeFile(this.filePath, JSON.stringify(toSave, null, 2), "utf-8");
  }
}
