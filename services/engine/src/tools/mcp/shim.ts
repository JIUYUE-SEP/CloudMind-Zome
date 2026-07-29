/**
 * Windows spawn shim 封装（spike 坑 #1）。
 *
 * SDK 的 StdioClientTransport 内部 `spawn(command, args, { shell: false })`。
 * Windows 上 `npx`/`uvx` 等是 .cmd/.bat 批处理 shim，无 shell 无法执行；
 * 裸命令名（"npx"）也可能只解析到 .cmd。统一处理：win32 下凡非 .exe 的
 * command 一律包 `cmd.exe /c`（cmd 自己会做 PATH 解析，.exe 也兼容，
 * 这里只对已明确 .exe 的直通以减少一层包装）。
 */
export interface CommandSpec {
  command: string;
  args: string[];
}

export function resolveCommandShim(
  command: string,
  args: string[] = [],
  platform: NodeJS.Platform = process.platform,
): CommandSpec {
  if (platform !== "win32") return { command, args };
  if (/\.exe$/i.test(command)) return { command, args };
  return { command: "cmd.exe", args: ["/c", command, ...args] };
}
