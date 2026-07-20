// engine 日志内存缓冲：pino 默认只写 stdout，这里并行 tee 一份到内存环形缓冲，
// 供 GET /logs 返回给前端 LogPanel。只保留最近 MAX_ENTRIES 条，进程重启即清空。

export interface BufferedLogEntry {
  time: number;
  level: number;
  msg: string;
}

const MAX_ENTRIES = 1000;

const buffer: BufferedLogEntry[] = [];

export function getBufferedLogs(limit?: number): BufferedLogEntry[] {
  if (limit === undefined) return [...buffer];
  return buffer.slice(-limit);
}

export function clearBufferedLogs(): void {
  buffer.length = 0;
}

/** pino multistream 可消费的写流：逐行解析 JSON 日志入缓冲，解析失败的行直接忽略 */
export function createLogBufferStream(): { write: (chunk: string | Uint8Array) => void } {
  return {
    write(chunk: string | Uint8Array) {
      const line = typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
      for (const part of line.split("\n")) {
        const trimmed = part.trim();
        if (!trimmed) continue;
        try {
          const entry = JSON.parse(trimmed) as { time?: unknown; level?: unknown; msg?: unknown };
          buffer.push({
            time: typeof entry.time === "number" ? entry.time : Date.now(),
            level: typeof entry.level === "number" ? entry.level : 30,
            msg: typeof entry.msg === "string" ? entry.msg : "",
          });
        } catch {
          // 非 JSON 行（如启动期裸 console 输出）不入缓冲
        }
      }
      if (buffer.length > MAX_ENTRIES) {
        buffer.splice(0, buffer.length - MAX_ENTRIES);
      }
    },
  };
}
