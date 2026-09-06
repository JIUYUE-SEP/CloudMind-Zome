import OpenAI from "openai";
import type { ImageGenProvider } from "./types.js";
import { ProviderError } from "./errors.js";

export class OpenAIImageGenProvider implements ImageGenProvider {
  name = "openai";
  private client: OpenAI;
  private readonly defaultModel: string;

  constructor(apiKey?: string, baseURL?: string, defaultModel?: string) {
    this.client = new OpenAI({ apiKey, baseURL });
    // 决策 1：型号从配置来（AgentConfig.imageModelId 经装配层传入），缺省回落 dall-e-3
    this.defaultModel = defaultModel ?? "dall-e-3";
  }

  // 决策 1：配置即信任，supportsModel 不做名字白名单（恒 true）；
  // 接口保留，未来第二协议族照 LLM 侧 apiMode 三族先例扩支持面时再收窄
  supportsModel(model: string) {
    void model;
    return true;
  }

  async generate(prompt: string, options?: { size?: string; model?: string }) {
    try {
      const response = await this.client.images.generate({
        model: options?.model ?? this.defaultModel,
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
  supportsModel(model: string) {
    void model;
    return true;
  }
  // 签名同步接受 prompt/options（决策 6：测试断言型号透传用），返回行为不变。
  // data-url 内容 = 真实 1x1 透明 PNG（e2e 生图工具卡的 <img> 要能真解码——
  // 原 "mock" 字节不是合法图片，浏览器 error 事件必触发兜底，假绿风险）
  async generate(_prompt?: string, _options?: { size?: string; model?: string }) {
    void _prompt;
    void _options;
    return {
      url: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
    };
  }
}
