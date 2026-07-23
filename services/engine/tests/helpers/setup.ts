// engine 本地 token 鉴权（P0-2）的全局测试注入：
// createServer 的 onRequest hook 与 WS handler 经 CLOUDMIND_AUTH_TOKEN 取到该值，
// tests/helpers/auth.ts 的 authedRequest / TEST_AUTH_TOKEN 携带同一值，
// 存量用例无需逐个关心 token 生成。
process.env.CLOUDMIND_AUTH_TOKEN = "test-auth-token";
