/**
 * exit 前等 stdout 已缓冲日志冲刷完毕（M51 范式，复用点：bootstrap main().catch、
 * plugins/http listen EADDRINUSE）：POSIX 管道下 process.stdout.write 异步缓冲，
 * 立即 exit 会截断刚写出的错误日志（supervisor 排障关键证据）。pino multistream
 * 无 flush 面（logger.flush() 对它是空调用），借一次空写回调等既有缓冲写出；
 * 回调在缓冲 flush 后触发（写失败同样回调）。超时兜底：冲刷异常也不能把
 * 退出路径挂死。
 */
export async function flushStdout(timeoutMs = 500): Promise<void> {
  try {
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, timeoutMs);
      // 兜底计时器不得拖住进程（含测试注入 fake exit 的场景）
      if (typeof timer === "object" && "unref" in timer) timer.unref();
      process.stdout.write("", () => {
        clearTimeout(timer);
        resolve();
      });
    });
  } catch {
    /* best-effort：冲刷失败照退 */
  }
}
