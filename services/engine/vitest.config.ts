import { defineConfig, configDefaults } from "vitest/config";

export default defineConfig({
  test: {
    pool: "forks",
    setupFiles: ["tests/helpers/setup.ts"],
    // *.smoke.test.ts 起真实 sidecar 二进制（P5-3），成本高，不进默认套件，
    // 经 test:sidecar（vitest.smoke.config.ts）显式运行
    // 5s 缺省对 GitHub windows-latest runner 偏紧（实测比本机慢 2-3 倍）：
    // 2026-11-02 CI 上 core/react 的「G3 估算含工具定义」与「100 步保险丝」两例
    // 稳定 5s 超时（本地 1.5-2s 完成）。提到 10s 给其余用例留缓冲；
    // 真实重活用例在用例签名上自标 30s，不靠这条兜底。
    testTimeout: 10_000,
    exclude: [...configDefaults.exclude, "tests/**/*.smoke.test.ts"],
    // 测试文件串行执行，保持最严格的隔离。背景（Windows 实测）：
    // 1) 并行跑文件时 CLOUDMIND_DATA_DIR 等进程级状态互相踩踏，且未覆盖 env 的
    //    测试会并发写同一个兜底数据目录（~/.cloudmind-zome）产生文件锁冲突（11 败）。
    // 2) 改用 isolate:true（每文件独立进程）并行实测 10-12 败：46 个文件进程
    //    爆炸导致资源饱和、测试 5s 超时，此路不通。
    // 代价是套件整体耗时略增（串行约 10-20s，可接受）。
    fileParallelism: false,
    coverage: {
      provider: "v8",
      reporter: ["text", "json", "html", "lcov"],
      reportsDirectory: "./coverage",
      exclude: ["node_modules/", "dist/", "bench/", "tests/", "**/*.d.ts"],
    },
  },
});
