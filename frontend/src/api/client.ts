import { getApiBase } from './config'

const TOKEN_KEY = 'cloudmind-token'

function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY)
}

function getHeaders(contentType = true): Record<string, string> {
  const headers: Record<string, string> = {}
  const token = getToken()
  if (token) headers['Authorization'] = `Bearer ${token}`
  if (contentType) headers['Content-Type'] = 'application/json'
  return headers
}

export function setAuthToken(token: string) {
  localStorage.setItem(TOKEN_KEY, token)
}

export function clearAuthToken() {
  localStorage.removeItem(TOKEN_KEY)
}

export function getUploadUrl(url: string | undefined): string {
  if (!url || !url.startsWith('/uploads/')) return url || ''
  const token = getToken()
  if (!token) return url
  const sep = url.includes('?') ? '&' : '?'
  return `${url}${sep}token=${encodeURIComponent(token)}`
}

export interface ApiResponse<T = any> {
  code: number
  data?: T
  message?: string
}

async function request<T = any>(
  method: string,
  path: string,
  body?: any,
  contentType = true,
): Promise<ApiResponse<T>> {
  const base = getApiBase()
  const url = path.startsWith('http') ? path : `${base}${path}`
  const opts: RequestInit = { method, headers: getHeaders(contentType), cache: 'no-store' }
  if (body && contentType) opts.body = JSON.stringify(body)
  else if (body) opts.body = body

  try {
    const res = await fetch(url, opts)
    const contentType = res.headers.get('content-type') || ''
    const text = await res.text()

    // Guard against Vite SPA fallback / backend HTML error pages.
    if (!contentType.includes('application/json')) {
      const preview = text.trim().slice(0, 200)
      const hint = preview.toLowerCase().startsWith('<!doctype') || preview.startsWith('<')
        ? ' (received HTML instead of JSON; check Vite proxy and API base URL)'
        : ''
      const message = `API returned non-JSON response (${res.status} ${res.statusText})${hint}: ${preview}`
      console.error(`[API ${method}] ${path}:`, message)
      return { code: -1, message }
    }

    let json: ApiResponse<T> | any
    try {
      json = JSON.parse(text)
    } catch (e) {
      console.error(`[API ${method}] ${path} JSON parse error:`, e, '\nRaw:', text.slice(0, 500))
      return { code: -1, message: `Invalid JSON from API: ${String(e)}` }
    }

    // Backend may return FastAPI error JSON (detail) without our {code} wrapper.
    if (!res.ok) {
      const msg = json?.message || json?.detail || JSON.stringify(json)
      return { code: -1, message: `HTTP ${res.status} ${res.statusText}: ${msg}` }
    }

    if (json.code !== 0 && json.code !== undefined) {
      console.error(`[API ${method}] ${path} error:`, json.message)
    }
    return json
  } catch (e) {
    console.error(`[API ${method}] ${path} network error:`, e)
    return { code: -1, message: String(e) }
  }
}

export const api = {
  get: <T = any>(path: string) => request<T>('GET', path),
  post: <T = any>(path: string, body?: any) => request<T>('POST', path, body),
  put: <T = any>(path: string, body?: any) => request<T>('PUT', path, body),
  delete: <T = any>(path: string) => request<T>('DELETE', path),
  upload: <T = any>(path: string, formData: FormData) =>
    request<T>('POST', path, formData, false),
  rawFetch: (path: string, opts?: RequestInit) => fetch(path, opts),
}
