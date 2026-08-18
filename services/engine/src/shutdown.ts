import { logger } from "./logger.js";
/**
 * 优雅关停（P1-2，数据 review M6）：收到 SIGTERM/SIGINT 时先 stop 停止
 * 接收新任务，再把压缩队列 drain 完再退出——此前 drain() 在生产代码零
 * 调用，每次正常退出都丢弃压缩队列 pending 项，与崩溃同等制造重启孤儿。
 * drain 带超时兜底（默认 10s）：超时也退，不卡死关停；超时丢弃的段由
 * 启动对账兜底。close 同样带超时兜底（默认 5s）：生产上 app.close()
 * 会等长生命周期 WebSocket 连接，可能永久挂起，超时记日志后照常退出。
 *
 * 信号可达性（Windows 场景）：sidecar supervisor 强杀用 taskkill /F
 * （TerminateProcess），任何 handler 都不会执行——该路径的孤儿由
 * 启动对账（reconcile.ts + topic-state.json）兜底。本 handler 服务于
 * dev Ctrl+C、Unix 服务管理（systemd/Docker SIGTERM）等信号真实可达的场景。
 */

export interface ShutdownDeps {
  /** 停止接收新任务（如 scheduler.stop），在 drain 之前调用 */
  stop?: () => void | Promise<void>;
  /** 等待所有后台压缩任务完成（各 worker 的 CompressionQueue.drain） */
  drain: () => Promise<void>;
  /** 关闭 HTTP server（停止接收新连接） */
  close: () => Promise<unknown>;
  /** drain 超时毫秒，默认 10s */
  timeoutMs?: number;
  /** close 超时毫秒，默认 5s */
  closeTimeoutMs?: number;
  /** 退出进程（测试注入替身） */
  exit?: (code: number) => void;
  log?: (msg: string) => void;
}

export async function gracefulShutdown(deps: ShutdownDeps): Promise<void> {
  const timeoutMs = deps.timeoutMs ?? 10_000;
  const closeTimeoutMs = deps.closeTimeoutMs ?? 5_000;
  const exit = deps.exit ?? ((code: number) => process.exit(code));
  const log = deps.log ?? ((msg: string) => logger.info(msg));
  log(`[shutdown] 开始优雅关停：drain 压缩队列（超时上限 ${timeoutMs}ms）`);
  // 先停止接收新任务再 drain 存量：否则 drain 期间 scheduler 触发的新
  // 压缩段入队即被丢弃（虽有启动对账兜底，但属顺序颠倒）；stop 失败不阻断关停
  try {
    await deps.stop?.();
  } catch {
    // 与 drain/close 一致：任何关停步骤失败都不阻断退出
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  // drain 失败与超时区分文案（Low 群修复）：失败带原因，超时才提时间窗——
  // 两者都不阻断退出，但排障口径不同
  let drainError: unknown;
  const drained = await Promise.race([
    deps.drain().then(
      () => true,
      (err: unknown) => {
        drainError = err;
        return false; // drain 自身失败视同失败路径：不阻断退出
      },
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
    if (drainError !== undefined) {
      log(`[shutdown] drain 自身失败（非超时），直接退出（遗留压缩段有 pending 记录，由启动对账兜底）：${drainError instanceof Error ? drainError.message : String(drainError)}`);
    } else {
      log(`[shutdown] drain 未在 ${timeoutMs}ms 内完成，直接退出（遗留压缩段有 pending 记录，由启动对账兜底）`);
    }
  }
  let closeTimer: ReturnType<typeof setTimeout> | undefined;
  let closeError: unknown;
  const closed = await Promise.race([
    deps.close().then(
      () => true,
      (err: unknown) => {
        closeError = err;
        return false; // close 自身失败视同失败路径：不阻断退出
      },
    ),
    new Promise<false>((resolve) => {
      closeTimer = setTimeout(() => resolve(false), closeTimeoutMs);
      // 兜底计时器不得拖住进程（含测试注入 fake exit 的场景）
      if (typeof closeTimer === "object" && "unref" in closeTimer) closeTimer.unref();
    }),
  ]);
  if (closeTimer) clearTimeout(closeTimer);
  if (!closed) {
    if (closeError !== undefined) {
      log(`[shutdown] close 自身失败（非超时），强制退出：${closeError instanceof Error ? closeError.message : String(closeError)}`);
    } else {
      // app.close() 会等长生命周期 WebSocket 连接，可能永不返回
      log(`[shutdown] close 未在 ${closeTimeoutMs}ms 内完成，强制退出`);
    }
  }
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
