import { logger } from "../../logger.js";
import type { FastifyRequest } from "fastify";
import type { ChatMode } from "@mindcloud/shared";
import { isValidAgentId, isApprovalRememberable } from "@mindcloud/shared";

export { isApprovalRememberable };

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
  return isValidAgentId(id);
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
  return isValidAgentId(value);
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
