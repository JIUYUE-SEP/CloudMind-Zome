import pino from "pino";
import { createLogBufferStream } from "./log-buffer.js";

// 共享日志流（stdout + /logs 环形缓冲）：Fastify 请求日志与各业务模块
// 共用同一出口，保证两类日志同进 LogPanel
const streams = pino.multistream([{ stream: process.stdout }, { stream: createLogBufferStream() }]);

/**
 * 业务日志统一出口（P4-1，体验 review O-B1）：业务模块一律经此写日志
 * （原 70+ 处裸 console 绕开 pino，LogPanel 名存实亡）。
 *
 * 级别语义：
 * - info：正常流程的关键节点（启动、对账、worker 生命周期、WS 连接/断开）
 * - warn：可恢复问题与降级（坏行跳过、检索降级、配置缺失回退）
 * - error：真错误（明确报错、写盘失败、回调异常）
 * - debug：逐条诊断（enqueue/runTurn 细节），默认 info 级别不输出，
 *   排查时 ZOME_LOG_LEVEL=debug 开启
 *
 * P1 修复（F5）：pino 单例本体自 src/logger.ts 迁进插件目录（物理搬家，
 * 语义一字未改）；src/logger.ts 退为纯 re-export shim，全仓消费方面零改动。
 */
// M51：ZOME_LOG_LEVEL 白名单校验——pino 对未知 level 在构造（模块 import）
// 时直接抛错致启动失败；非法值回落 info，构造完成后 warn 一次（配置错误
// 必须可见，但不能阻断启动）
const VALID_LEVELS = new Set(["fatal", "error", "warn", "info", "debug", "trace", "silent"]);
const envLevel = process.env.ZOME_LOG_LEVEL;
const invalidLevel = envLevel !== undefined && !VALID_LEVELS.has(envLevel);
export const logger = pino({ level: invalidLevel ? "info" : (envLevel ?? "info") }, streams);
if (invalidLevel) {
  logger.warn(
    `[log] ZOME_LOG_LEVEL="${envLevel}" 非法，已回落 info（合法值：fatal/error/warn/info/debug/trace/silent）`,
  );
}

/** server.ts 的 Fastify logger 复用同一流（与业务日志同缓冲） */
export const loggerStreams = streams;
