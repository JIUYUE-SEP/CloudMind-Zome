import { fetchWithTimeout } from "@/utils/fetch";

/**
 * engine 鉴权 token 解析链（web 开发模式）。
 *
 * 优先级：显式配置（NUXT_PUBLIC_ENGINE_TOKEN）> localStorage 覆盖
 * （cloudmind.engineToken）> nitro dev server 自动读文件（/api/engine-token）。
 * 全部缺失返回 ""——维持既有 401/4401 提示，不崩。
 */
export function resolveEngineToken(
  configuredToken: string | undefined,
  localToken: string | undefined,
  serverToken: string | undefined,
): string {
  return configuredToken || localToken || serverToken || "";
}

/**
 * 从本应用 nitro dev server 拉 engine auth-token（GET /api/engine-token）。
 * 运行时下发而非构建时内联——token 不进客户端 bundle。失败/无 token 返回 ""。
 */
export async function fetchEngineTokenFromServer(): Promise<string> {
  try {
    const res = await fetchWithTimeout("/api/engine-token", {}, 3_000);
    if (!res.ok) return "";
    const body: unknown = await res.json();
    const token = (body as { token?: unknown }).token;
    return typeof token === "string" ? token : "";
  } catch {
    return "";
  }
}
