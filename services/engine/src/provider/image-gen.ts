import OpenAI from "openai";
import type { ImageGenProvider } from "./types.js";
import { ProviderError } from "./errors.js";

/**
 * 生图请求硬上限（P1-6）。
 *
 * OpenAI SDK 缺省 `timeout=600000`（10 分钟）+ `maxRetries=2`，最坏 30 分钟
 * 才返回——用户点停止后引擎仍挂着等，期间还在写盘。这里显式封顶。
 *
 * 不传 `signal`：`ToolContext` 没有 signal（已登记的已知限制，见
 * docs/design/watchdog.md §六），工具层感知不到取消，能封的只有时间上限。
 * `maxRetries` 归零：生图按次计费，响应丢失后的静默重试可能双倍计费；
 * 失败信息会原样返回给用户，由他决定要不要重试。
 */
export const IMAGE_GENERATE_TIMEOUT_MS = 120_000;

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
      const response = await this.client.images.generate(
        {
          model: options?.model ?? this.defaultModel,
          prompt,
          size: options?.size as OpenAI.Images.ImageGenerateParams["size"] | undefined,
        },
        // P1-6：per-request 覆盖 SDK 缺省，把最坏耗时从 30 分钟压到 2 分钟
        { timeout: IMAGE_GENERATE_TIMEOUT_MS, maxRetries: 0 },
      );
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
