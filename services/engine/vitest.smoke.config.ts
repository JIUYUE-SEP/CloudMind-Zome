import { defineConfig } from "vitest/config";

/**
 * TS↔Rust 真实链路冒烟专用配置（P5-3）：起真实 sidecar 二进制，成本高
 * （cargo build + 进程冷启动），不进默认套件，经
 * `pnpm --filter @mindcloud/engine test:sidecar` 显式运行。
 */
export default defineConfig({
  test: {
    pool: "forks",
    setupFiles: ["tests/helpers/setup.ts"],
    include: ["tests/**/*.smoke.test.ts"],
    fileParallelism: false,
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
