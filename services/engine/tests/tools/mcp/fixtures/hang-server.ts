/**
 * 失败路径回归测试用的假 server：启动后把自身 pid 写入 argv[2] 指定的文件，
 * 然后挂住、永不完成 MCP 握手（stdout 不写任何协议帧），
 * 用于触发 client-manager 的 connect 超时路径，验证子进程被回收。
 */
import fs from "node:fs";

const pidfile = process.argv[2];
if (pidfile) fs.writeFileSync(pidfile, String(process.pid));

setInterval(() => {}, 60_000);
