import { describe, it, expect, vi, afterEach } from "vitest";
import { OpenAIImageGenProvider, MockImageGenProvider } from "../../src/provider/image-gen.js";

/** 替换 OpenAI 客户端的 images.generate，断言请求体并返回固定结果 */
function stubImagesGenerate(provider: OpenAIImageGenProvider) {
  const generateMock = vi.fn(async () => ({ data: [{ url: "https://img.example.com/r.png" }] }));
  (provider as unknown as { client: { images: { generate: unknown } } }).client = {
    images: { generate: generateMock },
  } as never;
  return generateMock;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("OpenAIImageGenProvider（决策 1：型号从配置来）", () => {
  it("构造传入 defaultModel：generate 未传 model 时用 defaultModel", async () => {
    const provider = new OpenAIImageGenProvider("sk-test", undefined, "gpt-image-1");
    const generateMock = stubImagesGenerate(provider);
    const result = await provider.generate("a cat");
    expect(generateMock).toHaveBeenCalledWith(
      expect.objectContaining({ model: "gpt-image-1", prompt: "a cat", size: undefined }),
    );
    expect(result.url).toBe("https://img.example.com/r.png");
  });

  it("options.model 临时覆盖 defaultModel，size 透传", async () => {
    const provider = new OpenAIImageGenProvider("sk-test", undefined, "gpt-image-1");
    const generateMock = stubImagesGenerate(provider);
    await provider.generate("a cat", { model: "dall-e-2", size: "1024x1024" });
    expect(generateMock).toHaveBeenCalledWith(
      expect.objectContaining({ model: "dall-e-2", size: "1024x1024" }),
    );
  });

  it("未传 defaultModel：回落 dall-e-3（删硬编码后的缺省兜底）", async () => {
    const provider = new OpenAIImageGenProvider("sk-test");
    const generateMock = stubImagesGenerate(provider);
    await provider.generate("a cat");
    expect(generateMock).toHaveBeenCalledWith(expect.objectContaining({ model: "dall-e-3" }));
  });

  it("supportsModel 放宽为恒 true（配置即信任，不做名字白名单）", () => {
    const provider = new OpenAIImageGenProvider("sk-test");
    expect(provider.supportsModel("dall-e-3")).toBe(true);
    expect(provider.supportsModel("gpt-image-1")).toBe(true);
    expect(provider.supportsModel("anything-configured")).toBe(true);
  });
});

describe("MockImageGenProvider（决策 6：行为不变）", () => {
  it("generate 签名接受 prompt/options，返回合法 1x1 PNG data-url（e2e <img> 可解码）", async () => {
    const provider = new MockImageGenProvider();
    expect(provider.supportsModel("any")).toBe(true);
    const withoutArgs = await provider.generate();
    const withArgs = await provider.generate("a cat", { size: "1024x1024", model: "m" });
    expect(withoutArgs).toEqual(withArgs);
    expect(withoutArgs.url?.startsWith("data:image/png;base64,")).toBe(true);
    // 字节必须是合法 PNG（magic header 0x89 0x50 0x4E 0x47）——原 "mock" 字节非
    // 合法图片，e2e 工具卡 <img> 必触发 error 兜底（假绿修复，2026-09-06）
    const bytes = Buffer.from(withoutArgs.url!.slice("data:image/png;base64,".length), "base64");
    expect(bytes.subarray(0, 4)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  });
});
