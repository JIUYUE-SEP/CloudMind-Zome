import OpenAI from "openai";
import type { ImageGenProvider } from "./types.js";

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
    const response = await this.client.images.generate({
      model: "dall-e-3",
      prompt,
      size: options?.size as OpenAI.Images.ImageGenerateParams["size"] | undefined,
    });
    return { url: response.data?.[0]?.url };
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
