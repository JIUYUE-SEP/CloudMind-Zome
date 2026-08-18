/**
 * 跨端协议常量（P5-2，架构 review 技术债）：三端单一口径的唯一来源。
 * engine（Fastify/WS）与 web（Nuxt）必须从这里引用，不再各自手写；
 * sidecar 是 Rust，无法消费 TS 包，其同名硬编码以本文件为准人工对齐。
 */

// ---- 资源 ID 规则（agent / session / project 等）----

/** ID 长度上限（字符） */
export const AGENT_ID_MAX_LENGTH = 64;
/** ID 字符集：字母 / 数字 / 下划线 / 连字符 */
export const AGENT_ID_CHARSET_PATTERN = /^[a-zA-Z0-9_-]+$/;
/** 完整 ID 规则（长度 + 字符集），API.md 对外口径 `[a-zA-Z0-9_-]{1,64}` */
export const AGENT_ID_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/;

export function isValidAgentId(id: unknown): id is string {
  return typeof id === "string" && AGENT_ID_PATTERN.test(id);
}

// ---- 工具审批免询问黑名单 ----

// 每次都必须人工确认的工具：即使客户端回执带了 remember:true 也不记入
// 免询问名单。engine 是最终执行者（api/ws/validation.ts），web 仅做展示层
// 预判（utils/approval.ts），两端必须共用这一份。
// run_command 是裸 shell 任意命令执行，remember 一次等于本连接放行一切命令。
// write_file/edit_file（P2-3，安全 review 审批 Major-1）：写操作是注入攻击的
// 主要落地路径（诱导覆写源码/配置），"remember 一次 = 放行该工具一切路径
// 与内容"与 run_command 同类、爆炸半径小一档，一律每次批；
// 路径粒度 remember（方案 A）易留绕过口子，不取。
// dispatch_subagent（P2-5）：跨 agent confused deputy 通道，"remember 一次 =
// 放行一切目标 agent 与任务"，与写类同类，一律每次批。
// dispatch_subagent_batch：同源的批量派发（傀儡 swarm），一次 remember =
// 放行任意模板×items 批量执行，与单发同等待遇。
export const NO_REMEMBER_TOOLS: ReadonlySet<string> = new Set([
  "run_command",
  "write_file",
  "edit_file",
  "dispatch_subagent",
  "dispatch_subagent_batch",
]);

export function isApprovalRememberable(toolName: string): boolean {
  return !NO_REMEMBER_TOOLS.has(toolName);
}

// ---- 进程地址缺省值 ----

/** engine HTTP/WS 默认监听（`PORT` 环境变量可覆盖） */
export const DEFAULT_ENGINE_HOST = "127.0.0.1";
export const DEFAULT_ENGINE_PORT = 8848;
export const DEFAULT_ENGINE_URL = `http://${DEFAULT_ENGINE_HOST}:${DEFAULT_ENGINE_PORT}`;
/** sidecar gRPC 默认地址（`ZOME_SIDECAR_ADDR` 可覆盖） */
export const DEFAULT_SIDECAR_ADDR = "127.0.0.1:50051";

// ---- 跨模块共享契约常量（P3 插件化：切 tools→subagent/intermind 值边的落点） ----

/** dispatch_subagent 前台模式超时上限（dispatcher 与工具共用同一口径） */
export const MAX_FOREGROUND_TIMEOUT_MS = 300_000;

/** Intermind 私信会话 id 前缀 */
export const INTERMIND_SESSION_PREFIX = "intermind:";

/** 私信会话 id 约定：与对端 agent 的来往信件会话 */
export function intermindSessionId(peerAgentId: string): string {
  return `${INTERMIND_SESSION_PREFIX}${peerAgentId}`;
}
