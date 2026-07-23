import request from "supertest";

/** 与 tests/helpers/setup.ts 注入的 CLOUDMIND_AUTH_TOKEN 一致 */
export const TEST_AUTH_TOKEN = "test-auth-token";

type App = Parameters<typeof request>[0];

/**
 * 统一带 Bearer token 的 supertest 包装：engine 除 /health 外全部要求鉴权（P0-2），
 * 存量用例把 request(app.server) 换成 authedRequest(app.server) 即可，语义不变。
 */
export function authedRequest(app: App) {
  const base = request(app);
  const bearer = `Bearer ${TEST_AUTH_TOKEN}`;
  return {
    get: (url: string) => base.get(url).set("Authorization", bearer),
    post: (url: string) => base.post(url).set("Authorization", bearer),
    put: (url: string) => base.put(url).set("Authorization", bearer),
    patch: (url: string) => base.patch(url).set("Authorization", bearer),
    delete: (url: string) => base.delete(url).set("Authorization", bearer),
    options: (url: string) => base.options(url).set("Authorization", bearer),
  };
}
