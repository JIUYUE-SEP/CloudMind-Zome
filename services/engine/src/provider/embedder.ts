import OpenAI from "openai";
import type { EmbedderProvider } from "./types.js";
import { ProviderError } from "./errors.js";

/** 缺省嵌入型号（未配置 AgentConfig.embedderModelId 时） */
export const DEFAULT_EMBEDDING_MODEL = "text-embedding-3-small";

export class OpenAIEmbedderProvider implements EmbedderProvider {
  name = "openai";
  private client: OpenAI;

  /**
   * @param model 嵌入型号（来自 AgentConfig.embedderModelId，经装配层传入）；
   * 缺省回落 DEFAULT_EMBEDDING_MODEL。此前型号硬编码，编辑器里的「嵌入型号」
   * 字段对实际请求零影响（配置了也不生效）。
   */
  constructor(
    apiKey?: string,
    baseURL?: string,
    private model: string = DEFAULT_EMBEDDING_MODEL,
  ) {
    this.client = new OpenAI({ apiKey, baseURL });
  }

  supportsModel(model: string) {
    return model.startsWith("text-embedding-");
  }

  async embed(texts: string[]): Promise<number[][]> {
    try {
      const response = await this.client.embeddings.create({
        model: this.model,
        input: texts,
      });
      return response.data.map((d) => d.embedding);
    } catch (err) {
      throw new ProviderError("openai", err);
    }
  }
}

export class MockEmbedderProvider implements EmbedderProvider {
  name = "mock";
  supportsModel() {
    return true;
  }
  async embed(texts: string[]): Promise<number[][]> {
    return texts.map(() => new Array(384).fill(0).map(() => Math.random() * 2 - 1));
  }
}
