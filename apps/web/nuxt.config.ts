export default defineNuxtConfig({
  ssr: true,
  devtools: { enabled: true },
  modules: ["@pinia/nuxt"],
  css: ["~/assets/css/main.css"],
  runtimeConfig: {
    // 前端只消费 public.engineUrl / public.engineToken（useEngineClient），顶层私有键无消费者
    // engineToken：engine 本地 token 鉴权（P0-2）的 web 开发显式覆盖通道（NUXT_PUBLIC_ENGINE_TOKEN）。
    // 零配置路径走 nitro dev server 的 /api/engine-token（server/api/engine-token.ts 读
    // CLOUDMIND_DATA_DIR/auth-token 运行时下发，不进客户端 bundle）
    public: {
      engineUrl: process.env.ENGINE_URL || "http://127.0.0.1:8848",
      engineToken: process.env.ENGINE_TOKEN || ""
    }
  },
  nitro: {
    prerender: {
      routes: [],
    },
    output: {
      publicDir: "dist"
    }
  }
});
