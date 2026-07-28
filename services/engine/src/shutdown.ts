import { logger } from "./logger.js";
/**
 * 优雅关停（P1-2，数据 review M6）：收到 SIGTERM/SIGINT 时先把压缩队列
 * drain 完再退出——此前 drain() 在生产代码零调用，每次正常退出都丢弃
 * 压缩队列 pending 项，与崩溃同等制造重启孤儿。drain 带超时兜底（默认
 * 10s）：超时也退，不卡死关停；超时丢弃的段由启动对账兜底。
 *
 * 信号可达性（Windows desktop 场景）：desktop/sidecar 用 taskkill /F 杀
 * 进程树（TerminateProcess），任何 handler 都不会执行——该路径的孤儿由
 * 启动对账（reconcile.ts + topic-state.json）兜底。本 handler 服务于
 * dev Ctrl+C、Unix 服务管理（systemd/Docker SIGTERM）等信号真实可达的场景。
 */

export interface ShutdownDeps {
  /** 等待所有后台压缩任务完成（各 worker 的 CompressionQueue.drain） */
  drain: () => Promise<void>;
  /** 关闭 HTTP server（停止接收新连接） */
  close: () => Promise<unknown>;
  /** drain 超时毫秒，默认 10s */
  timeoutMs?: number;
  /** 退出进程（测试注入替身） */
  exit?: (code: number) => void;
  log?: (msg: string) => void;
}

export async function gracefulShutdown(deps: ShutdownDeps): Promise<void> {
  const timeoutMs = deps.timeoutMs ?? 10_000;
  const exit = deps.exit ?? ((code: number) => process.exit(code));
  const log = deps.log ?? ((msg: string) => logger.info(msg));
  log(`[shutdown] 开始优雅关停：drain 压缩队列（超时上限 ${timeoutMs}ms）`);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const drained = await Promise.race([
    deps.drain().then(
      () => true,
      () => false, // drain 自身失败视同超时：不阻断退出
    ),
    new Promise<false>((resolve) => {
      timer = setTimeout(() => resolve(false), timeoutMs);
      // 兜底计时器不得拖住进程（含测试注入 fake exit 的场景）
      if (typeof timer === "object" && "unref" in timer) timer.unref();
    }),
  ]);
  if (timer) clearTimeout(timer);
  if (!drained) {
    // M-b 后属实：队列丢弃的段在 topic-state.json 留有 pending 记录，
    // 下次启动由 reconcilePendingSegments 补压缩/补归档
    log(`[shutdown] drain 未在 ${timeoutMs}ms 内完成，直接退出（遗留压缩段有 pending 记录，由启动对账兜底）`);
  }
  await deps.close().catch(() => {});
  exit(0);
}

/** 注册 SIGTERM/SIGINT handler（幂等：重复信号不重复执行）；返回注销函数（测试用） */
export function registerShutdownHandlers(deps: ShutdownDeps): () => void {
  let shuttingDown = false;
  const handler = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    (deps.log ?? ((msg: string) => logger.info(msg)))(`[shutdown] 收到 ${signal}`);
    await gracefulShutdown(deps);
  };
  const onSigterm = (): void => void handler("SIGTERM");
  const onSigint = (): void => void handler("SIGINT");
  process.on("SIGTERM", onSigterm);
  process.on("SIGINT", onSigint);
  return () => {
    process.removeListener("SIGTERM", onSigterm);
    process.removeListener("SIGINT", onSigint);
  };
}
