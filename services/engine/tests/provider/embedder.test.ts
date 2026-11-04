/**
 * 嵌入 provider 型号口径（回归）：`AgentConfig.embedderModelId` 曾是纯配置字段——
 * provider 型号写死 text-embedding-3-small，编辑器里改了也不生效。
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import {
  DEFAULT_EMBEDDING_MODEL,
  MockEmbedderProvider,
  OpenAIEmbedderProvider,
} from "../../src/provider/embedder.js";

/** 替换 OpenAI 客户端的 embeddings.create，断言请求体（参照 image-gen.test 的打桩方式） */
function stubEmbeddings(provider: OpenAIEmbedderProvider) {
  const createMock = vi.fn(async () => ({ data: [{ embedding: [0.1, 0.2, 0.3] }] }));
  (provider as unknown as { client: { embeddings: { create: unknown } } }).client = {
    embeddings: { create: createMock },
  } as never;
  return createMock;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("OpenAIEmbedderProvider 型号口径", () => {
  it("构造传入 model：embed 请求用该型号", async () => {
    const provider = new OpenAIEmbedderProvider("sk-test", undefined, "text-embedding-3-large");
    const create = stubEmbeddings(provider);
    const [vectors] = await Promise.all([provider.embed(["hello"])]);
    expect(create).toHaveBeenCalledWith({ model: "text-embedding-3-large", input: ["hello"] });
    expect(vectors).toEqual([[0.1, 0.2, 0.3]]);
  });

  it("未传 model：回落缺省型号（保持旧行为）", async () => {
    const provider = new OpenAIEmbedderProvider("sk-test");
    const create = stubEmbeddings(provider);
    await provider.embed(["hello"]);
    expect(create).toHaveBeenCalledWith({ model: DEFAULT_EMBEDDING_MODEL, input: ["hello"] });
  });

  it("缺省型号常量是 text-embedding-3-small（配置缺省口径不许漂移）", () => {
    expect(DEFAULT_EMBEDDING_MODEL).toBe("text-embedding-3-small");
  });
});

describe("MockEmbedderProvider", () => {
  it("维度固定 384（索引/测试依赖该形状）", async () => {
    const vectors = await new MockEmbedderProvider().embed(["a", "b"]);
    expect(vectors).toHaveLength(2);
    expect(vectors[0]).toHaveLength(384);
  });
});
