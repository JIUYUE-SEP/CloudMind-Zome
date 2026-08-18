import { logger } from "../logger.js";
import fs from "node:fs";
import path from "node:path";
import grpc from "@grpc/grpc-js";
import protoLoader from "@grpc/proto-loader";
import { DEFAULT_SIDECAR_ADDR } from "@mindcloud/shared";

/**
 * Rust sidecar（zome-sidecar）的 gRPC 客户端。
 * sidecar 不随纯 web 形态常驻（保留为休眠能力），`pnpm dev` 下通常不存在——
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

/** proto-loader 生成的动态客户端没有类型定义，这里只声明实际用到的方法 */
interface ZomeSidecarGrpc {
  Health(
    req: Record<string, never>,
    opts: { deadline: number },
    cb: (err: unknown, res: unknown) => void,
  ): void;
  Upsert(
    req: { agent_id: string; doc_id: string; embedding: number[] },
    opts: { deadline: number },
    cb: (err: unknown, res: unknown) => void,
  ): void;
  Search(
    req: { agent_id: string; query: number[]; top_k: number },
    opts: { deadline: number },
    cb: (err: unknown, res: unknown) => void,
  ): void;
  DeleteAgent(
    req: { agent_id: string },
    opts: { deadline: number },
    cb: (err: unknown, res: unknown) => void,
  ): void;
  DeleteDocs(
    req: { agent_id: string; doc_ids: string[] },
    opts: { deadline: number },
    cb: (err: unknown, res: unknown) => void,
  ): void;
}

type GrpcMethod = keyof ZomeSidecarGrpc;

/**
 * sidecar 明确报错（M-a）：sidecar 进程在线但返回错误 Status（如高版本数据
 * Status::internal）——与"不可达/超时"的静默降级严格区分，调用方必须可感知。
 */
export class SidecarCallError extends Error {
  constructor(
    public readonly method: string,
    public readonly code: number | undefined,
    details: string,
  ) {
    super(`sidecar ${method} 明确报错（gRPC code=${code}）：${details}`);
    this.name = "SidecarCallError";
  }
}

/**
 * 错误分类（M-a）：不可达（UNAVAILABLE）/超时（DEADLINE_EXCEEDED）= sidecar
 * 不可用，静默降级合理；其余错误 Status = sidecar 明确报错，必须上抛。
 * 无 code 的异常保持历史行为按不可用处理。
 */
export function classifySidecarError(err: unknown): "unavailable" | "explicit" {
  const code = (err as { code?: unknown } | null)?.code;
  if (typeof code !== "number") return "unavailable";
  if (code === grpc.status.UNAVAILABLE || code === grpc.status.DEADLINE_EXCEEDED) {
    return "unavailable";
  }
  return "explicit";
}

export class SidecarClient {
  private client?: ZomeSidecarGrpc;
  private availability: { at: number; ok: boolean } = { at: 0, ok: false };

  constructor(private addr: string = process.env.ZOME_SIDECAR_ADDR || DEFAULT_SIDECAR_ADDR) {}

  private getClient(): ZomeSidecarGrpc | undefined {
    if (this.client) return this.client;
    const protoPath = findProtoPath();
    if (!protoPath) return undefined;
    try {
      // keepCase：proto 字段是 snake_case（agent_id/doc_id/top_k），proto-loader
      // 默认转 camelCase 会导致请求键被整体丢弃、响应读错字段，Upsert/Search 静默失效
      const def = protoLoader.loadSync(protoPath, { longs: Number, defaults: true, keepCase: true });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- 动态包定义，唯一收窄点
      const pkg = grpc.loadPackageDefinition(def) as any;
      this.client = new pkg.zome.ZomeSidecar(
        this.addr,
        grpc.credentials.createInsecure(),
      ) as ZomeSidecarGrpc;
      return this.client;
    } catch (err) {
      logger.error({ err: err }, "failed to load sidecar proto");
      return undefined;
    }
  }

  private call<TRes>(method: GrpcMethod, req: Parameters<ZomeSidecarGrpc[GrpcMethod]>[0], deadlineMs = 3000, quiet = false): Promise<TRes | undefined> {
    const client = this.getClient();
    if (!client) return Promise.resolve(undefined);
    return new Promise((resolve, reject) => {
      client[method](
        // 各方法 req 类型不同，union 传入在运行时无差别（grpc-js 直接序列化）
        req as never,
        { deadline: Date.now() + deadlineMs },
        (err: unknown, res: unknown) => {
          if (err) {
            // 错误分类（M-a）：sidecar 明确返回错误 Status（如高版本数据）上抛，
            // 调用方识别后必须可感知；不可达/超时仍走统一降级出口：
            // 返回值契约不变（undefined），但错误必须可观测。
            // Health 走 quiet：它由 isAvailable 每 10s 轮询，可用性翻转时在
            // isAvailable 里记一次，避免 sidecar 缺席时日志刷屏
            if (classifySidecarError(err) === "explicit") {
              const e = err as { code?: number; details?: string };
              reject(new SidecarCallError(method, e.code, e.details ?? String(err)));
              return;
            }
            if (!quiet) logger.warn({ err: err }, `[sidecar] ${method} 调用失败，按不可用降级`);
            resolve(undefined);
            return;
          }
          resolve(res as TRes);
        },
      );
    });
  }

  async isAvailable(): Promise<boolean> {
    const now = Date.now();
    if (now - this.availability.at < AVAILABILITY_CACHE_MS) return this.availability.ok;
    // 探活语义：即使 sidecar 明确报错（进程在线但 Health 失败）也按不可用记
    const res = await this.call("Health", {}, 1000, true).catch(() => undefined);
    const ok = res !== undefined;
    // 只在可用性翻转时记日志（首次探测不记：纯 pnpm dev 下 sidecar 本就不存在）
    if (this.availability.at !== 0 && ok !== this.availability.ok) {
      logger.warn(`[sidecar] 可用性变化：${this.availability.ok ? "可用" : "不可用"} -> ${ok ? "可用" : "不可用"}`);
    }
    this.availability = { at: now, ok };
    return ok;
  }

  async upsert(agentId: string, docId: string, embedding: number[]): Promise<boolean> {
    // 与 search 同档 30s：sidecar 重启后首条嵌入 upsert 同样触发完整冷载入，
    // 默认 3s 会把该条嵌入打成超时丢弃（实测数据见 search 注释）
    const res = await this.call("Upsert", { agent_id: agentId, doc_id: docId, embedding }, 30_000).catch(
      (err: unknown) => {
        // 写路径保持 bool 契约（M-a）：明确报错不静默——error 级留痕后按失败返回
        logger.error({ err: err }, "[sidecar] Upsert 明确报错，本条嵌入未写入");
        return undefined;
      },
    );
    return res !== undefined;
  }

  // 注意：sidecar 原始返回的是距离（1 - cosine，越小越近），不是相似度。
  // 相似度换算在 MemoryIndexer.search 出口统一进行，本层原样透传。
  // M-a：sidecar 明确报错（SidecarCallError）不在本层吞掉，上抛给调用方感知；
  // 不可达/超时仍按空结果降级。
  async search(agentId: string, query: number[], topK: number): Promise<{ id: string; score: number }[]> {
    const res = await this.call<{ results?: { doc_id: string; score: number }[] }>(
      "Search",
      { agent_id: agentId, query, top_k: topK },
      // 30s 依据实测（P0 review 返工，2026-07-24，Ryzen 7 8845H）：
      // 万条 1536 维（295.7MB embeddings.jsonl）冷载入 12.3-12.5s
      // （search 12487/12438/12357ms、upsert 12443/12323/12296ms，各 3 轮）。
      // 30s ≈ 2.4 倍余量，约覆盖同机 2 万条 1536 维；超出后按空降级并 warn
      30_000,
    );
    return (res?.results ?? []).map((r) => ({ id: r.doc_id, score: r.score }));
  }

  /**
   * 删除 agent 的全部向量数据（P1-3）：sidecar 逐出 INDEX_CACHE 并删除磁盘
   * indices 目录。sidecar 不可达时返回 false（调用方 warn 降级，不阻断删除——
   * 目录统一后磁盘 embeddings 已随 agents/{id} 的 rm -rf 删除，残留仅是
   * sidecar 内存缓存，sidecar 重启即清）。
   */
  async deleteAgent(agentId: string): Promise<boolean> {
    // bool 契约不变（M-a）：明确报错 error 级留痕，仍按 false 返回（语义同注释）
    const res = await this.call("DeleteAgent", { agent_id: agentId }).catch((err: unknown) => {
      logger.error({ err: err }, "[sidecar] DeleteAgent 明确报错，内存缓存可能未逐出");
      return undefined;
    });
    return res !== undefined;
  }

  /**
   * 按 doc_id 批量删除向量（M14 tombstone）：sidecar 从 docs/doc_ids 移除并
   * 追加墓碑行落盘，被删文档立即不可检索，物理剔除交给 sidecar 运行期/启动
   * compaction。sidecar 不可达时返回 false（调用方 warn 降级，不阻断主流程——
   * 残留向量被 L4 归档排除兜住正确性，仅索引体积代价）。
   */
  async deleteDocs(agentId: string, docIds: string[]): Promise<boolean> {
    if (docIds.length === 0) return true;
    // bool 契约不变（M-a）：明确报错 error 级留痕，仍按 false 返回
    const res = await this.call("DeleteDocs", { agent_id: agentId, doc_ids: docIds }).catch(
      (err: unknown) => {
        logger.error({ err: err }, "[sidecar] DeleteDocs 明确报错，向量墓碑未写入");
        return undefined;
      },
    );
    return res !== undefined;
  }
}
