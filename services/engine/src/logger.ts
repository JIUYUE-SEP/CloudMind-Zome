import pino from "pino";
import { createLogBufferStream } from "./plugins/log/log-buffer.js";

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
 */
export const logger = pino({ level: process.env.ZOME_LOG_LEVEL ?? "info" }, streams);

/** server.ts 的 Fastify logger 复用同一流（与业务日志同缓冲） */
export const loggerStreams = streams;
