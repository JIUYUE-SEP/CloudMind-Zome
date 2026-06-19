/**
 * Runtime API configuration.
 *
 * In development, Vite proxies `/api` and `/uploads` to the local backend,
 * so the default base is `/api/v1` and the WebSocket uses `location.host`.
 *
 * In the Tauri desktop build, the Rust side exposes the `backend_url` command
 * and main.ts rewrites these values to point at the embedded Python backend.
 */

function normalizeApiBase(base: string | undefined): string {
  if (!base || base === '/') return '/api/v1'
  return base.replace(/\/$/, '')
}

let apiBase = normalizeApiBase(import.meta.env.VITE_API_BASE_URL)
let wsBase = ''

export function setApiBase(base: string) {
  apiBase = normalizeApiBase(base)
}

export function setWsBase(base: string) {
  wsBase = base
}

export function getApiBase(): string {
  return apiBase
}

export function getWsBase(): string {
  // Production/Tauri: backend_url has been set explicitly.
  if (wsBase) return wsBase

  // Development: Vite proxy forwards WS through the dev server host.
  return `ws://${location.host}`
}
