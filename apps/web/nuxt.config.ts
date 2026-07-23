export default defineNuxtConfig({
  ssr: !process.env.TAURI_ENV_PLATFORM,
  devtools: { enabled: true },
  modules: ["@pinia/nuxt"],
  css: ["~/assets/css/main.css"],
  runtimeConfig: {
    // 前端只消费 public.engineUrl / public.engineToken（useEngineClient），顶层私有键无消费者
    // engineToken：engine 本地 token 鉴权（P0-2）的 web 开发注入通道（NUXT_PUBLIC_ENGINE_TOKEN）；
    // desktop 静态包此项为空，token 由 Tauri IPC（get_engine_token）下发
    public: {
      engineUrl: process.env.ENGINE_URL || "http://127.0.0.1:8848",
      engineToken: process.env.ENGINE_TOKEN || ""
    }
  },
  nitro: {
    preset: process.env.TAURI_ENV_PLATFORM ? "static" : undefined,
    prerender: {
      routes: [],
    },
    output: {
      publicDir: "dist"
    }
  }
});
