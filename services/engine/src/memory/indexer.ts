import type { EmbedderProvider } from "../provider/types.js";
import type { SidecarClient } from "../sidecar/client.js";

const MAX_INDEX_CHARS = 2000;
const EMBED_TIMEOUT_MS = 5000;

/**
 * embed 走 OpenAI SDK 默认超时（分钟级），嵌入服务 hang 时会卡住聊天主链路。
 * 包一层超时，超时按失败处理（调用方静默降级）。
 */
async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("embed timeout")), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * 向量记忆索引：消息 embed 后写入 sidecar 向量库，供跨会话语义检索。
 * 任何一步失败都静默降级——索引是增强能力，不能影响主链路。
 */
export class MemoryIndexer {
  constructor(
    private client: SidecarClient,
    private embedder: EmbedderProvider,
    private embedTimeoutMs: number = EMBED_TIMEOUT_MS,
  ) {}

  async indexMessage(agentId: string, docId: string, text: string): Promise<void> {
    const trimmed = text.trim();
    if (!trimmed) return;
    if (!(await this.client.isAvailable())) return;
    try {
      const [vec] = await withTimeout(
        this.embedder.embed([trimmed.slice(0, MAX_INDEX_CHARS)]),
        this.embedTimeoutMs,
      );
      if (vec) await this.client.upsert(agentId, docId, vec);
    } catch (err) {
      console.error("memory index failed", err);
    }
  }

  /**
   * 语义检索：返回命中的 doc id 与相似度（域 [0,1]，越大越相关）。
   * 注意 sidecar 原始返回的是距离（1 - cosine，域 [0,2]，越小越近），
   * 在本出口统一换算为 similarity = max(0, 1 - distance)，
   * 调用方（SemanticRetriever 等）拿到的即为相似度，无需关心底层语义。
   */
  async search(agentId: string, query: string, topK: number): Promise<{ id: string; score: number }[]> {
    if (!query.trim()) return [];
    if (!(await this.client.isAvailable())) return [];
    try {
      const [vec] = await withTimeout(
        this.embedder.embed([query.slice(0, MAX_INDEX_CHARS)]),
        this.embedTimeoutMs,
      );
      if (!vec) return [];
      const hits = await this.client.search(agentId, vec, topK);
      return hits.map((h) => ({ id: h.id, score: Math.max(0, 1 - h.score) }));
    } catch {
      return [];
    }
  }
}
