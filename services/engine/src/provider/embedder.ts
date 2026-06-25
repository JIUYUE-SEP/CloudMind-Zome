import OpenAI from "openai";
import type { EmbedderProvider } from "./types.js";
import { ProviderError } from "./errors.js";

export class OpenAIEmbedderProvider implements EmbedderProvider {
  name = "openai";
  private client: OpenAI;

  constructor(apiKey?: string, baseURL?: string) {
    this.client = new OpenAI({ apiKey, baseURL });
  }

  supportsModel(model: string) {
    return model.startsWith("text-embedding-");
  }

  async embed(texts: string[]): Promise<number[][]> {
    try {
      const response = await this.client.embeddings.create({
        model: "text-embedding-3-small",
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
