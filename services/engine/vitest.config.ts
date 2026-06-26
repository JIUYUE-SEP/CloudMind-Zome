import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    pool: "forks",
    coverage: {
      provider: "v8",
      reporter: ["text", "json", "html", "lcov"],
      reportsDirectory: "./coverage",
      exclude: ["node_modules/", "dist/", "bench/", "tests/", "**/*.d.ts"],
    },
  },
});
