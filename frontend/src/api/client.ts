const API_BASE = '/api/v1'

function getToken(): string | null {
  return localStorage.getItem('cm_token')
}

function getHeaders(contentType = true): Record<string, string> {
  const headers: Record<string, string> = {}
  const t = getToken()
  if (t) headers.Authorization = `Bearer ${t}`
  if (contentType) headers['Content-Type'] = 'application/json'
  return headers
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
  const url = path.startsWith('http') ? path : `${API_BASE}${path}`
  const opts: RequestInit = { method, headers: getHeaders(contentType), cache: 'no-store' }
  if (body && contentType) opts.body = JSON.stringify(body)
  else if (body) opts.body = body

  try {
    const res = await fetch(url, opts)
    const json: ApiResponse<T> = await res.json()
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
