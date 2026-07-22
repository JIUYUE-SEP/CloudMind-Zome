import fs from "node:fs";
import path from "node:path";
import grpc from "@grpc/grpc-js";
import protoLoader from "@grpc/proto-loader";

/**
 * Rust sidecar（zome-sidecar）的 gRPC 客户端。
 * sidecar 只在 Tauri 桌面环境运行，纯 `pnpm dev` 下不存在——
 * 因此所有调用都优雅降级（返回 undefined/[]），绝不让聊天主链路失败。
 * 降级不等于静默：失败在统一出口记 warn（Health 轮询只在可用性翻转时记），
 * 故障可观测但不刷屏。
 */

function findProtoPath(): string | undefined {
  if (process.env.ZOME_PROTO_PATH && fs.existsSync(process.env.ZOME_PROTO_PATH)) {
    return process.env.ZOME_PROTO_PATH;
  }
  let dir = process.cwd();
  for (let i = 0; i < 6; i++) {
    const candidate = path.join(dir, "crates", "zome-sidecar", "proto", "zome.proto");
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return undefined;
}

const AVAILABILITY_CACHE_MS = 10_000;

// proto-loader 生成的动态客户端没有类型定义
/* eslint-disable @typescript-eslint/no-explicit-any */

export class SidecarClient {
  private client: any;
  private availability: { at: number; ok: boolean } = { at: 0, ok: false };

  constructor(private addr: string = process.env.ZOME_SIDECAR_ADDR || "127.0.0.1:50051") {}

  private getClient(): any {
    if (this.client) return this.client;
    const protoPath = findProtoPath();
    if (!protoPath) return undefined;
    try {
      // keepCase：proto 字段是 snake_case（agent_id/doc_id/top_k），proto-loader
      // 默认转 camelCase 会导致请求键被整体丢弃、响应读错字段，Upsert/Search 静默失效
      const def = protoLoader.loadSync(protoPath, { longs: Number, defaults: true, keepCase: true });
      const pkg = grpc.loadPackageDefinition(def) as any;
      this.client = new pkg.zome.ZomeSidecar(this.addr, grpc.credentials.createInsecure());
      return this.client;
    } catch (err) {
      console.error("failed to load sidecar proto", err);
      return undefined;
    }
  }

  private call<TRes>(method: string, req: unknown, deadlineMs = 3000, quiet = false): Promise<TRes | undefined> {
    const client = this.getClient();
    if (!client) return Promise.resolve(undefined);
    return new Promise((resolve) => {
      client[method](
        req,
        { deadline: Date.now() + deadlineMs },
        (err: unknown, res: TRes) => {
          if (err) {
            // 统一降级点：返回值契约不变（undefined），但错误必须可观测。
            // Health 走 quiet：它由 isAvailable 每 10s 轮询，可用性翻转时在
            // isAvailable 里记一次，避免 sidecar 缺席时日志刷屏
            if (!quiet) console.warn(`[sidecar] ${method} 调用失败，按不可用降级`, err);
            resolve(undefined);
            return;
          }
          resolve(res);
        },
      );
    });
  }

  async isAvailable(): Promise<boolean> {
    const now = Date.now();
    if (now - this.availability.at < AVAILABILITY_CACHE_MS) return this.availability.ok;
    const res = await this.call("Health", {}, 1000, true);
    const ok = res !== undefined;
    // 只在可用性翻转时记日志（首次探测不记：纯 pnpm dev 下 sidecar 本就不存在）
    if (this.availability.at !== 0 && ok !== this.availability.ok) {
      console.warn(`[sidecar] 可用性变化：${this.availability.ok ? "可用" : "不可用"} -> ${ok ? "可用" : "不可用"}`);
    }
    this.availability = { at: now, ok };
    return ok;
  }

  async upsert(agentId: string, docId: string, embedding: number[]): Promise<boolean> {
    const res = await this.call("Upsert", { agent_id: agentId, doc_id: docId, embedding });
    return res !== undefined;
  }

  // 注意：sidecar 原始返回的是距离（1 - cosine，越小越近），不是相似度。
  // 相似度换算在 MemoryIndexer.search 出口统一进行，本层原样透传。
  async search(agentId: string, query: number[], topK: number): Promise<{ id: string; score: number }[]> {
    const res = await this.call<{ results?: { doc_id: string; score: number }[] }>(
      "Search",
      { agent_id: agentId, query, top_k: topK },
    );
    return (res?.results ?? []).map((r) => ({ id: r.doc_id, score: r.score }));
  }
}
