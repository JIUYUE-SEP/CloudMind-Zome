import type { EmbedderProvider } from "../provider/types.js";
import type { SidecarClient } from "../sidecar/client.js";

const MAX_INDEX_CHARS = 2000;

/**
 * 向量记忆索引：消息 embed 后写入 sidecar 向量库，供跨会话语义检索。
 * 任何一步失败都静默降级——索引是增强能力，不能影响主链路。
 */
export class MemoryIndexer {
  constructor(
    private client: SidecarClient,
    private embedder: EmbedderProvider,
  ) {}

  async indexMessage(agentId: string, docId: string, text: string): Promise<void> {
    const trimmed = text.trim();
    if (!trimmed) return;
    if (!(await this.client.isAvailable())) return;
    try {
      const [vec] = await this.embedder.embed([trimmed.slice(0, MAX_INDEX_CHARS)]);
      if (vec) await this.client.upsert(agentId, docId, vec);
    } catch (err) {
      console.error("memory index failed", err);
    }
  }

  async search(agentId: string, query: string, topK: number): Promise<{ id: string; score: number }[]> {
    if (!query.trim()) return [];
    if (!(await this.client.isAvailable())) return [];
    try {
      const [vec] = await this.embedder.embed([query.slice(0, MAX_INDEX_CHARS)]);
      if (!vec) return [];
      return await this.client.search(agentId, vec, topK);
    } catch {
      return [];
    }
  }
}
