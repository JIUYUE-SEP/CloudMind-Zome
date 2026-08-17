import type { Context } from "cordis";
import { SidecarClient } from "../../sidecar/client.js";

/**
 * sidecar 插件（P9）：Rust sidecar gRPC 客户端单例上架 ctx.sidecar。
 *
 * - 构造自 bootstrap.ts 迁入（原组合根 `new SidecarClient()` 同一构造点，
 *   无参缺省地址语义不变——构造只记地址，proto 加载/连接在首次调用时
 *   惰性发生，挂载时序无行为差异）；
 * - 消费面两处：agents 插件 config 回调 getSidecar（worker 创建链
 *   MemoryIndexer 现造）与 http 插件 ApiContext.sidecarClient
 *   （P1-3 删除 agent 时级联清理向量索引）；
 * - 生命周期随进程（原 bootstrap 同样不 close），不挂 fiber disposer。
 */
export const name = "sidecar";

/** 无 ctx 服务依赖（地址经 env/缺省常量，proto 路径惰性查找） */
export const inject: string[] = [];

declare module "cordis" {
  interface Context {
    /** Rust sidecar gRPC 客户端（桌面向量检索；纯 dev 下优雅降级） */
    sidecar: SidecarClient;
  }
}

export function apply(ctx: Context): void {
  ctx.provide("sidecar", new SidecarClient());
}
