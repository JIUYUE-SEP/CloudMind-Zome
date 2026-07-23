import fs from "node:fs/promises";
import path from "node:path";
import { renameWithRetry } from "../memory/document-store.js";
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

// DEFAULT_CONFIG 是共享对象，必须返回深拷贝，避免调用方 push/mutate 污染全局默认值
function createDefaultConfig(): GlobalConfig {
  return structuredClone(DEFAULT_CONFIG);
}

async function decryptValue(value: string | undefined): Promise<string | undefined> {
  if (!value) return undefined;
  if (!value.startsWith("enc:")) return value;
  try {
    return await decrypt(value.slice(4));
  } catch (err) {
    // master key 变更/丢失时解密必然失败：字段按未配置处理，但必须留痕，
    // 否则用户看到的只是"apiKey 凭空消失"
    console.warn("[config] 解密失败，该字段按未配置处理（master key 可能已变更）:", err);
    return undefined;
  }
}

export class ConfigRepository {
  private filePath: string;

  constructor() {
    this.filePath = path.join(getDataDir(), "config.json");
  }

  async load(): Promise<GlobalConfig> {
    let text: string;
    try {
      text = await fs.readFile(this.filePath, "utf-8");
    } catch (err) {
      // 只有"文件不存在"才回默认配置；其余读取错误必须显式抛出
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        return createDefaultConfig();
      }
      throw err;
    }

    let parsed: Partial<GlobalConfig>;
    try {
      parsed = JSON.parse(text) as Partial<GlobalConfig>;
    } catch (err) {
      // 文件存在但已损坏：隔离原文件再抛错。绝不静默回默认——
      // 否则后续 save 会把损坏文件（含全部加密 apiKey）覆盖成空配置，数据永久丢失
      const quarantinePath = `${this.filePath}.corrupt-${Date.now()}`;
      await renameWithRetry(this.filePath, quarantinePath).catch(() => {});
      throw new Error(
        `配置文件损坏，已隔离到 ${quarantinePath}，请人工恢复：${err instanceof Error ? err.message : String(err)}`,
      );
    }

    const defaults = createDefaultConfig();
    const config: GlobalConfig = {
      ...defaults,
      ...parsed,
      settings: { ...defaults.settings, ...parsed.settings },
    };

    for (const provider of config.providers) {
      provider.apiKey = await decryptValue(provider.apiKey);
    }
    if (config.settings) {
      config.settings.tavilyApiKey = await decryptValue(config.settings.tavilyApiKey);
    }

    return config;
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
    // 原子写：先写 tmp 再 rename，避免写一半崩溃留下半截 config.json
    const tmpPath = `${this.filePath}.tmp`;
    await fs.writeFile(tmpPath, JSON.stringify(toSave, null, 2), "utf-8");
    await renameWithRetry(tmpPath, this.filePath);
  }
}
