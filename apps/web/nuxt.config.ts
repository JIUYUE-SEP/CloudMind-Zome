export default defineNuxtConfig({
  ssr: true,
  devtools: { enabled: true },
  modules: ["@pinia/nuxt"],
  nitro: {
    output: {
      publicDir: "dist"
    },
    prerender: {
      routes: ["/"]
    }
  },
  runtimeConfig: {
    engineUrl: process.env.ENGINE_URL || "http://127.0.0.1:8848",
    public: { engineUrl: process.env.ENGINE_URL || "http://127.0.0.1:8848" }
  }
});
