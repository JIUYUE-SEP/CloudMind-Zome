import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { generateImageTool } from "../../src/tools/builtin/generate_image.js";
import { getBuiltinTools } from "../../src/tools/builtin/index.js";
import type { ImageGenProvider } from "../../src/provider/types.js";
import type { ToolContext } from "../../src/tools/types.js";

const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

let tmpDir: string;

function makeCtx(imageProvider?: ImageGenProvider): ToolContext {
  return {
    agentId: "a1",
    workspaceDir: tmpDir,
    approve: async () => true,
    services: imageProvider ? { imageProvider } : {},
  };
}

function makeProvider(result: { url?: string; data?: string }): ImageGenProvider {
  return {
    name: "stub",
    supportsModel: () => true,
    generate: vi.fn(async () => result),
  };
}

function imageResponse(body: Buffer, contentType: string, status = 200): Response {
  return new Response(new Uint8Array(body), {
    status,
    headers: { "content-type": contentType, "content-length": String(body.byteLength) },
  });
}

async function listImages(): Promise<string[]> {
  return fs.readdir(path.join(tmpDir, "files", "images"));
}

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "generate-image-test-"));
});

afterEach(async () => {
  vi.unstubAllGlobals();
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("generate_image 工具", () => {
  it("requiresApproval=true、network/read + file/write(files/images/) 声明，已注册进内置工具表", () => {
    expect(generateImageTool.requiresApproval).toBe(true);
    expect(generateImageTool.accesses).toContainEqual({ resource: "network", action: "read" });
    expect(generateImageTool.accesses).toContainEqual({
      resource: "file",
      action: "write",
      path: "files/images/",
    });
    const registered = getBuiltinTools().find((t) => t.name === "generate_image");
    expect(registered?.requiresApproval).toBe(true);
    expect(getBuiltinTools()).toHaveLength(15); // 14 + load_tool（2026-08-26 按需工具目录）
  });

  it("参数校验：空 prompt / 超长 prompt / 非法 size / 非法参数类型", async () => {
    const provider = makeProvider({ data: PNG_BYTES.toString("base64") });
    const ctx = makeCtx(provider);

    const emptyPrompt = await generateImageTool.execute(ctx, { prompt: "" });
    expect(emptyPrompt.success).toBe(false);
    expect(String(emptyPrompt.error)).toContain("prompt");

    const longPrompt = await generateImageTool.execute(ctx, { prompt: "x".repeat(4001) });
    expect(longPrompt.success).toBe(false);

    const badSize = await generateImageTool.execute(ctx, { prompt: "p", size: "512x512" });
    expect(badSize.success).toBe(false);
    expect(String(badSize.error)).toContain("size");

    const badType = await generateImageTool.execute(ctx, { prompt: 42 });
    expect(badType.success).toBe(false);

    expect(provider.generate).not.toHaveBeenCalled();
  });

  it("未注入 imageProvider：返回配置指引错误（决策 5），不崩不静默", async () => {
    const ctx = makeCtx();
    const result = await generateImageTool.execute(ctx, { prompt: "p" });
    expect(result.success).toBe(false);
    expect(String(result.error)).toContain("imageProviderId");
    expect(String(result.error)).toContain("配置");
  });

  it("data-url 返回：落盘 files/images/ 下，字节一致，persisted:true", async () => {
    const provider = makeProvider({ data: `data:image/png;base64,${PNG_BYTES.toString("base64")}` });
    const result = await generateImageTool.execute(makeCtx(provider), { prompt: "a cat" });
    expect(result.success).toBe(true);
    const output = (result as { output: { path: string; persisted: boolean } }).output;
    expect(output.persisted).toBe(true);
    expect(output.path).toMatch(/^files\/images\/\d{8}-\d{6}-[0-9a-f]{6}\.png$/);
    const written = await fs.readFile(path.join(tmpDir, output.path));
    expect(written.equals(PNG_BYTES)).toBe(true);
  });

  it("裸 base64 返回：按 png 落盘", async () => {
    const provider = makeProvider({ data: PNG_BYTES.toString("base64") });
    const result = await generateImageTool.execute(makeCtx(provider), { prompt: "p" });
    expect(result.success).toBe(true);
    const output = (result as { output: { path: string } }).output;
    expect(output.path.endsWith(".png")).toBe(true);
    const written = await fs.readFile(path.join(tmpDir, output.path));
    expect(written.equals(PNG_BYTES)).toBe(true);
  });

  it("data-url 类型不在白名单：结构化错误，不落盘", async () => {
    const provider = makeProvider({ data: "data:image/svg+xml;base64,PHN2Zy8+" });
    const result = await generateImageTool.execute(makeCtx(provider), { prompt: "p" });
    expect(result.success).toBe(false);
    expect(String(result.error)).toContain("白名单");
    await expect(listImages()).rejects.toThrow();
  });

  it("url 返回 + 下载成功：落盘 + persisted:true，按 content-type 映射扩展名", async () => {
    const provider = makeProvider({ url: "https://img.example.com/a.jpg" });
    const fetchMock = vi.fn(async () => imageResponse(PNG_BYTES, "image/jpeg"));
    vi.stubGlobal("fetch", fetchMock);

    const result = await generateImageTool.execute(makeCtx(provider), { prompt: "p" });
    expect(result.success).toBe(true);
    const output = (result as { output: { path: string; persisted: boolean } }).output;
    expect(output.persisted).toBe(true);
    expect(output.path).toMatch(/^files\/images\/\d{8}-\d{6}-[0-9a-f]{6}\.jpg$/);
    const written = await fs.readFile(path.join(tmpDir, output.path));
    expect(written.equals(PNG_BYTES)).toBe(true);
    expect(fetchMock).toHaveBeenCalledWith("https://img.example.com/a.jpg", expect.anything());
  });

  it("下载失败（HTTP 500 / 网络错误）：persisted:false + sourceUrl 回退，success:true", async () => {
    const provider = makeProvider({ url: "https://img.example.com/fail.png" });
    vi.stubGlobal("fetch", vi.fn(async () => imageResponse(PNG_BYTES, "image/png", 500)));
    const httpFail = await generateImageTool.execute(makeCtx(provider), { prompt: "p" });
    expect(httpFail.success).toBe(true);
    const out1 = (httpFail as { output: { persisted: boolean; sourceUrl: string; note: string } }).output;
    expect(out1.persisted).toBe(false);
    expect(out1.sourceUrl).toBe("https://img.example.com/fail.png");
    expect(out1.note).toContain("HTTP 500");

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("fetch failed");
      }),
    );
    const netFail = await generateImageTool.execute(makeCtx(provider), { prompt: "p" });
    expect(netFail.success).toBe(true);
    const out2 = (netFail as { output: { persisted: boolean; sourceUrl: string } }).output;
    expect(out2.persisted).toBe(false);
    expect(out2.sourceUrl).toBe("https://img.example.com/fail.png");
    // 回退不落盘
    await expect(listImages()).rejects.toThrow();
  });

  it("型号透传：参数 model 覆盖值 / 缺省 undefined 均传到 provider.generate", async () => {
    const provider = makeProvider({ data: PNG_BYTES.toString("base64") });
    const ctx = makeCtx(provider);

    await generateImageTool.execute(ctx, { prompt: "p", model: "gpt-image-1", size: "1792x1024" });
    expect(provider.generate).toHaveBeenLastCalledWith("p", { size: "1792x1024", model: "gpt-image-1" });

    await generateImageTool.execute(ctx, { prompt: "p" });
    expect(provider.generate).toHaveBeenLastCalledWith("p", { size: undefined, model: undefined });
  });

  it("content-length 超 20MB：拒绝下载并回退 persisted:false", async () => {
    const provider = makeProvider({ url: "https://img.example.com/big.png" });
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(new Uint8Array(8), {
            status: 200,
            headers: { "content-type": "image/png", "content-length": String(21 * 1024 * 1024) },
          }),
      ),
    );
    const result = await generateImageTool.execute(makeCtx(provider), { prompt: "p" });
    expect(result.success).toBe(true);
    const output = (result as { output: { persisted: boolean; note: string } }).output;
    expect(output.persisted).toBe(false);
    expect(output.note).toContain("超限");
  });

  it("流式读取累计超 20MB：中断并回退 persisted:false", async () => {
    const provider = makeProvider({ url: "https://img.example.com/stream.png" });
    const chunk = new Uint8Array(1024 * 1024);
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let i = 0; i < 21; i++) controller.enqueue(chunk);
        controller.close();
      },
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(stream, { status: 200, headers: { "content-type": "image/png" } })),
    );
    const result = await generateImageTool.execute(makeCtx(provider), { prompt: "p" });
    expect(result.success).toBe(true);
    const output = (result as { output: { persisted: boolean } }).output;
    expect(output.persisted).toBe(false);
    await expect(listImages()).rejects.toThrow();
  });

  it("下载 content-type 不在白名单：回退 persisted:false", async () => {
    const provider = makeProvider({ url: "https://img.example.com/x.svg" });
    vi.stubGlobal("fetch", vi.fn(async () => imageResponse(PNG_BYTES, "image/svg+xml")));
    const result = await generateImageTool.execute(makeCtx(provider), { prompt: "p" });
    expect(result.success).toBe(true);
    expect((result as { output: { persisted: boolean } }).output.persisted).toBe(false);
  });

  it("provider 返回既无 url 也无 data：结构化错误", async () => {
    const provider = makeProvider({});
    const result = await generateImageTool.execute(makeCtx(provider), { prompt: "p" });
    expect(result.success).toBe(false);
    expect(String(result.error)).toContain("未返回任何图片数据");
  });

  it("生成失败：结构化错误不抛裸异常；超长 prompt 在错误里截 500（决策 8）", async () => {
    const prompt = "绝密提示词" + "x".repeat(2000);
    const provider: ImageGenProvider = {
      name: "leaky",
      supportsModel: () => true,
      generate: vi.fn(async () => {
        throw new Error(`provider exploded while handling prompt: ${prompt}`);
      }),
    };
    const result = await generateImageTool.execute(makeCtx(provider), { prompt });
    expect(result.success).toBe(false);
    expect(String(result.error)).toContain("生成失败");
    expect(String(result.error)).not.toContain(prompt);
    const idx = String(result.error).indexOf("绝密提示词");
    expect(idx).toBeGreaterThanOrEqual(0);
    // 截断后的 prompt 片段 ≤500 字符（含省略号 501）
    const leaked = String(result.error).slice(idx);
    expect(leaked.length).toBeLessThanOrEqual(501);
  });

  it("输出/错误不携带完整超长 prompt（data-url 成功路径输出无 prompt 字段）", async () => {
    const prompt = "y".repeat(3000);
    const provider = makeProvider({ data: PNG_BYTES.toString("base64") });
    const result = await generateImageTool.execute(makeCtx(provider), { prompt });
    expect(result.success).toBe(true);
    expect(JSON.stringify(result.output)).not.toContain(prompt);
  });
});
