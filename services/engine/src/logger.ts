// P1 修复（F5）：pino 单例本体已迁进 plugins/log/logger.ts（插件自包含，
// 解除包级双向依赖）。本文件退为纯 re-export shim——全仓 `import { logger }`
// 消费面零改动；loggerStreams 消费方 api/server.ts:7,33 同口再导出。
export { logger, loggerStreams } from "./plugins/log/logger.js";
