# 跟进 issue：scheduler 测试在并行负载下 flaky（timing + Windows 文件锁）

- 创建日期：2026-07-17
- 来源：feat/code-agent-mode 修复收尾验证时发现
- 优先级：低（测试稳定性，非产品缺陷）
- 状态：**已解决**（2026-07-17，见文末）

## 问题描述（两部分）

### A. 墙钟时序断言

`services/engine/tests/scheduler/scheduler.test.ts` 的 "fires tasks asynchronously without blocking tick"：

```ts
await new Promise((r) => setTimeout(r, 10));
expect(tickResolved).toBe(true);
```

断言依赖 10ms 的 `setTimeout` 让出窗口：期望 `tick()` 在此期间 resolve（验证 tick 不被 pending 的 worker 阻塞）。CPU/IO 满载（turbo 并行跑多包）时事件循环延迟可超过 10ms，断言偶发失败。

### B. Windows 文件锁（rename EPERM）

同文件 "updates nextRunAt and enqueues due task" 偶发失败，真实错误为：

```
Error: EPERM: operation not permitted, rename '...\scheduler.jsonl.tmp' -> '...\scheduler.jsonl'
```

根因：`DocumentStore.writeLinesInner`/`writeJsonInner` 用"写 tmp + rename"做原子写，而 Windows 不允许 rename 覆盖一个正被读句柄占用的目标文件。测试内轮询 `repo.get()`（readLines）与 `runTask` 的 `repo.update()`（rename）并发，读句柄短暂占用期间 rename 即 EPERM。**这是生产缺陷，不只是测试问题**：Windows 上 scheduler 写回 `scheduler.jsonl` 时，API/轮询并发读取同一文件同样会触发，后果是任务调度时间未推进（可能重复触发）。

## 复现

- 单独跑 `tests/scheduler/`：A、B 均偶发（实测失败率约 20–50%，随机器负载波动）。
- `pnpm test`（turbo 并行满载）更容易触发。
- 重跑通常通过，因此长期被"重跑即绿"掩盖。

## 解决方案（已实施）

1. **A — 去墙钟化**（scheduler.test.ts）：10ms 固定窗口改为 `vi.waitFor(..., { timeout: 2000, interval: 5 })` 轮询，确定性等待 tick 完成，同时仍验证"tick 不阻塞于 worker"这一性质（若 tick 阻塞，waitFor 超时判负）。
2. **B — rename 重试**（`src/memory/document-store.ts`）：新增 `renameWithRetry`，对 EPERM/EBUSY/EACCES 做 5 次递增退避重试（20–100ms），覆盖瞬时读句柄占用；`writeJsonInner`/`writeLinesInner` 统一走该路径。POSIX 行为不变（rename 本就允许覆盖，一次成功）。回归测试：`tests/memory/document-store.test.ts` 模拟"并发读句柄持有 200ms 期间 writeLines"，未修复时必抛 EPERM。

## 关联背景：测试并行度配置

`services/engine/vitest.config.ts` 保留 `fileParallelism: false`（测试文件串行）。评估记录：
- 并行（默认）实测 11 败：进程级 `CLOUDMIND_DATA_DIR` 互相覆盖 + 未覆盖 env 的测试并发写同一兜底数据目录。
- `isolate: true`（每文件独立进程）并行实测 10–12 败：46 个文件进程爆炸导致资源饱和、5s 超时，此路不通。
- 故保留串行，代价是套件耗时略增（约 10–20s）。

## 验证

- `tests/scheduler/` 连续 8 次运行全绿（修复前约半数失败）。
- `pnpm vitest run`（引擎 289 测试）与 `pnpm test`（turbo 三包）均全绿。
