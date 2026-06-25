import { OpenAIProvider, MockLLMProvider } from "./llm.js";
import { OpenAIEmbedderProvider, MockEmbedderProvider } from "./embedder.js";
import { OpenAIImageGenProvider, MockImageGenProvider } from "./image-gen.js";
import type { LLMProvider, EmbedderProvider, ImageGenProvider } from "./types.js";

export interface ProviderConfig {
  type: "openai" | "mock";
  apiKey?: string;
  baseURL?: string;
}

export function createLLMProvider(config: ProviderConfig): LLMProvider {
  if (config.type === "mock") return new MockLLMProvider();
  return new OpenAIProvider(config.apiKey, config.baseURL);
}

export function createEmbedderProvider(config: ProviderConfig): EmbedderProvider {
  if (config.type === "mock") return new MockEmbedderProvider();
  return new OpenAIEmbedderProvider(config.apiKey, config.baseURL);
}

export function createImageGenProvider(config: ProviderConfig): ImageGenProvider {
  if (config.type === "mock") return new MockImageGenProvider();
  return new OpenAIImageGenProvider(config.apiKey, config.baseURL);
}
