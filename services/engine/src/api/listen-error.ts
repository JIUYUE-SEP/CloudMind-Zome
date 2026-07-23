/**
 * engine listen 失败分类（P0-3）：EADDRINUSE 用独立 exit code 2 退出，
 * 与普通崩溃（exit 1）区分开——supervisor 读到 exit 2 即知是端口冲突，
 * 不做盲目高频重启，转为低频重试并提示端口占用。
 */
export const EADDRINUSE_EXIT_CODE = 2;

export interface ClassifiedListenError {
  exitCode: number;
  message: string;
}

/** 是 EADDRINUSE 返回退出码与中文提示，其他错误返回 null（由调用方按原路径抛出） */
export function classifyListenError(err: unknown, port: number): ClassifiedListenError | null {
  if ((err as NodeJS.ErrnoException)?.code !== "EADDRINUSE") return null;
  return {
    exitCode: EADDRINUSE_EXIT_CODE,
    message:
      `[startup] 端口 ${port} 被占用（EADDRINUSE）：本机已有进程监听该端口。` +
      `若是上次遗留的 engine，supervisor 会直接收编复用；若是其他程序占用，请释放端口后重启。`,
  };
}
