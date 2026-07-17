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

export function isValidChatMode(value: unknown): value is ChatMode {
  return value === "chat" || value === "code";
}

export function isValidProjectId(value: unknown): value is string {
  return typeof value === "string" && /^[a-zA-Z0-9_-]{1,64}$/.test(value);
}

export function sanitizeInput(text: unknown): { ok: false; error: string } | { ok: true; text: string } {
  if (typeof text !== "string") return { ok: false, error: "text must be a string" };
  if (text.length > 10000) return { ok: false, error: "text too long (max 10000 characters)" };
  return { ok: true, text };
}
