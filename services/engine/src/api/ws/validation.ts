import type { ChatMode } from "@mindcloud/shared";

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
