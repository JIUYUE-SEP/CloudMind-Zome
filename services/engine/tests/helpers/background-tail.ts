import type { BackgroundManager } from "../../src/subagent/background.js";

/**
 * 等 BackgroundManager 某任务的终态尾巴收完（output.log、终态落盘、
 * notified 落盘）：onUpdate 只在 run()/runTracked() 的 notifyTerminalOnce
 * 全部落盘之后触发，等它 = 所有异步尾巴已收尾。
 *
 * 替代"内存状态翻转后立即断言文件/日志"的墙钟窗口，以及
 * vi.waitFor 默认 1s 轮询预算——CI 慢环境下状态翻转先于落盘、落盘链
 * 超过轮询预算都会挂（flaky 家族二期根因）。
 */
export function waitForTerminalTail(
  manager: BackgroundManager,
  taskId: string,
): Promise<void> {
  const isTerminal = (status: string | undefined): boolean =>
    status === "completed" || status === "failed";
  // 订阅先行：若任务已终态（onUpdate 已触发过），靠订阅前快照兜底，不悬挂
  const bg = manager.get(taskId);
  if (bg && isTerminal(bg.status) && bg.notified) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    const off = manager.onUpdate((updated) => {
      if (updated.taskId === taskId && isTerminal(updated.status) && updated.notified) {
        off();
        resolve();
      }
    });
  });
}
