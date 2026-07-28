import { logger } from "../../logger.js";
import type { FastifyRequest } from "fastify";
import type { ChatMode } from "@mindcloud/shared";

const DEFAULT_ALLOWED_ORIGINS = [
  "http://localhost:3000",
  "http://127.0.0.1:3000",
  "http://localhost:1420",
];

export function getAllowedOrigins(): string[] {
  return process.env.CLOUDMIND_ALLOWED_ORIGINS
    ? process.env.CLOUDMIND_ALLOWED_ORIGINS.split(",").map((o) => o.trim())
    : DEFAULT_ALLOWED_ORIGINS;
}

/**
 * WebSocket 握手的 Origin 校验（防 CSWSH：浏览器里任意网页都能连本机 WS）。
 * 浏览器必然携带 Origin；不带 Origin 的客户端（curl、Node、Tauri 后端）放行。
 */
export function isAllowedWsOrigin(origin: string | undefined): boolean {
  if (!origin) return true;
  if (process.env.NODE_ENV === "e2e") return true;
  // Tauri webview 使用自定义协议或 tauri.localhost 域
  if (origin.startsWith("tauri://")) return true;
  if (/^https?:\/\/([a-z0-9-]+\.)?tauri\.localhost$/.test(origin)) return true;
  return getAllowedOrigins().includes(origin);
}

export function isValidId(id: string): boolean {
  return /^[a-zA-Z0-9_-]{1,64}$/.test(id);
}

/**
 * WS 握手鉴权（P0-2）：浏览器 WebSocket 不能设请求头，token 改走
 * Sec-WebSocket-Protocol 子协议字段（不出现在 URL 和请求日志里，避免泄进 /logs）。
 * ws 库握手时会回显该子协议，浏览器与 Node 客户端均兼容。
 */
export function extractWsToken(req: FastifyRequest): string | undefined {
  const header = req.headers["sec-websocket-protocol"];
  if (!header) return undefined;
  const offered = (Array.isArray(header) ? header.join(",") : header)
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  return offered[0];
}

export function isValidChatMode(value: unknown): value is ChatMode {
  return value === "chat" || value === "code";
}

export function isValidProjectId(value: unknown): value is string {
  return typeof value === "string" && /^[a-zA-Z0-9_-]{1,64}$/.test(value);
}

// 每次都必须人工确认的工具：即使客户端回执带了 remember:true 也不记入
// 免询问名单（与 apps/web/utils/approval.ts 的名单保持一致）。
// run_command 是裸 shell 任意命令执行，remember 一次等于本连接放行一切命令。
// write_file/edit_file（P2-3，安全 review 审批 Major-1）：写操作是注入攻击的
// 主要落地路径（诱导覆写源码/配置），"remember 一次 = 放行该工具一切路径
// 与内容"与 run_command 同类、爆炸半径小一档，一律每次批；
// 路径粒度 remember（方案 A）易留绕过口子，不取。
// dispatch_subagent（P2-5）：跨 agent confused deputy 通道，"remember 一次 =
// 放行一切目标 agent 与任务"，与写类同类，一律每次批。
const NO_REMEMBER_TOOLS = new Set(["run_command", "write_file", "edit_file", "dispatch_subagent"]);

export function isApprovalRememberable(toolName: string): boolean {
  return !NO_REMEMBER_TOOLS.has(toolName);
}

export function sanitizeInput(text: unknown): { ok: false; error: string } | { ok: true; text: string } {
  if (typeof text !== "string") return { ok: false, error: "text must be a string" };
  if (text.length > 10000) return { ok: false, error: "text too long (max 10000 characters)" };
  return { ok: true, text };
}

/**
 * 下发 WS 事件前的 delta 帧校验：携带 delta 字段的帧（text.delta / thinking.delta）
 * 其值必须是 string。provider 层异常产生的非 string delta 直接丢弃并打 warn，
 * 避免脏帧穿透到前端拼接口径。
 */
export function sanitizeDeltaEvent<T>(event: T): T | null {
  if (event && typeof event === "object" && "delta" in event) {
    const delta = (event as { delta: unknown }).delta;
    if (typeof delta !== "string") {
      logger.warn({ err: event }, "dropping ws event with non-string delta");
      return null;
    }
  }
  return event;
}
