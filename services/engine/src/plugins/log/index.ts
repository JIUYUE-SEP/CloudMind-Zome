import type { Context } from "cordis";
import type { Logger } from "pino";
import { logger } from "./logger.js";

/**
 * log 插件（P1）：收编进程单例 logger 与 log-buffer 环形缓冲（同目录），
 * ctx.log 上架。插件接管所有权；全仓 `import { logger }` 直 import 面原样保留
 * （P1 任务书控范围：消费方一律不改）。
 *
 * log-buffer 自 api/log-buffer.ts 迁址本目录——解除 logger.ts → api/ 的
 * 层间倒置（迁移方案 A2 节点名）；容量/级别等语义一字未改。
 */
export const name = "log";

/** 无依赖：pino 单例模块加载即就绪，不等任何服务 */
export const inject: string[] = [];

declare module "cordis" {
  interface Context {
    /** CMZ 业务日志统一出口（pino；stdout + /logs 环形缓冲双流，语义见 src/logger.ts） */
    log: Logger;
  }
}

// 无配置面：不写 Config 校验器（有配置面的插件照 _template.ts 补同名 schema）
export function apply(ctx: Context): void {
  // provide 经 fiber effect 注册，插件卸载自动摘除（可逆注册纪律）
  ctx.provide("log", logger);
}
