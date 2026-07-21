export default defineNuxtConfig({
  ssr: !process.env.TAURI_ENV_PLATFORM,
  devtools: { enabled: true },
  modules: ["@pinia/nuxt"],
  css: ["~/assets/css/main.css"],
  runtimeConfig: {
    // 前端只消费 public.engineUrl（useEngineClient），顶层私有键无消费者
    public: { engineUrl: process.env.ENGINE_URL || "http://127.0.0.1:8848" }
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
