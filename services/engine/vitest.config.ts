import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    pool: "forks",
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
