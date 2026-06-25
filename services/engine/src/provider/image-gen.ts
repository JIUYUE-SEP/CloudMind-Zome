import OpenAI from "openai";
import type { ImageGenProvider } from "./types.js";
import { ProviderError } from "./errors.js";

export class OpenAIImageGenProvider implements ImageGenProvider {
  name = "openai";
  private client: OpenAI;

  constructor(apiKey?: string, baseURL?: string) {
    this.client = new OpenAI({ apiKey, baseURL });
  }

  supportsModel(model: string) {
    return model.startsWith("dall-e");
  }

  async generate(prompt: string, options?: { size?: string }) {
    try {
      const response = await this.client.images.generate({
        model: "dall-e-3",
        prompt,
        size: options?.size as OpenAI.Images.ImageGenerateParams["size"] | undefined,
      });
      return { url: response.data?.[0]?.url };
    } catch (err) {
      throw new ProviderError("openai", err);
    }
  }
}

export class MockImageGenProvider implements ImageGenProvider {
  name = "mock";
  supportsModel() {
    return true;
  }
  async generate() {
    return { url: "data:image/png;base64,mock" };
  }
}
