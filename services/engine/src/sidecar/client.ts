import fs from "node:fs";
import path from "node:path";
import grpc from "@grpc/grpc-js";
import protoLoader from "@grpc/proto-loader";

/**
 * Rust sidecar（zome-sidecar）的 gRPC 客户端。
 * sidecar 只在 Tauri 桌面环境运行，纯 `pnpm dev` 下不存在——
 * 因此所有调用都优雅降级（返回 undefined/[]），绝不让聊天主链路失败。
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

  private call<TRes>(method: string, req: unknown, deadlineMs = 3000): Promise<TRes | undefined> {
    const client = this.getClient();
    if (!client) return Promise.resolve(undefined);
    return new Promise((resolve) => {
      client[method](
        req,
        { deadline: Date.now() + deadlineMs },
        (err: unknown, res: TRes) => resolve(err ? undefined : res),
      );
    });
  }

  async isAvailable(): Promise<boolean> {
    const now = Date.now();
    if (now - this.availability.at < AVAILABILITY_CACHE_MS) return this.availability.ok;
    const res = await this.call("Health", {}, 1000);
    this.availability = { at: now, ok: res !== undefined };
    return this.availability.ok;
  }

  async upsert(agentId: string, docId: string, embedding: number[]): Promise<boolean> {
    const res = await this.call("Upsert", { agent_id: agentId, doc_id: docId, embedding });
    return res !== undefined;
  }

  async search(agentId: string, query: number[], topK: number): Promise<{ id: string; score: number }[]> {
    const res = await this.call<{ results?: { doc_id: string; score: number }[] }>(
      "Search",
      { agent_id: agentId, query, top_k: topK },
    );
    return (res?.results ?? []).map((r) => ({ id: r.doc_id, score: r.score }));
  }

  async countTokens(text: string, model: string): Promise<number | undefined> {
    const res = await this.call<{ count: number }>("CountTokens", { text, model });
    return res?.count;
  }
}
