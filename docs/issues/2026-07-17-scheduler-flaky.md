# 跟进 issue：scheduler.test.ts 时序断言在并行负载下偶发 flaky

- 创建日期：2026-07-17
- 来源：feat/code-agent-mode 修复收尾验证时发现
- 优先级：低（测试稳定性，非产品缺陷）
- 状态：open

## 问题描述

`services/engine/tests/scheduler/scheduler.test.ts:83-84`（用例 "does not run task concurrently when worker is pending"，describe: Scheduler）：

```ts
// Yield so runTask starts awaiting workerPromise.
await new Promise((r) => setTimeout(r, 10));
expect(tickResolved).toBe(true);
```

该断言依赖一个 **10ms 的 `setTimeout` 让出窗口**：测试期望 `tick()` 的 promise 在这 10ms 内 resolve。这是一个基于墙钟时间的时序假设，而非确定性同步点。

## 现象

在 `pnpm test`（turbo 并行跑 engine + web + desktop 三个包）满载运行时偶发失败：

```
FAIL tests/scheduler/scheduler.test.ts
AssertionError: expected false to be true // tickResolved
```

- 单独运行 `pnpm vitest run tests/scheduler/scheduler.test.ts`：稳定通过（4/4）。
- 重跑完整套件：通过。
- 2026-07-17 在 feat/code-agent-mode 收尾验证中复现一次（engine 288 个测试仅此 1 个失败）。

## 根因

CPU 满载时事件循环延迟可超过 10ms，导致让出窗口结束时 `tick()` 的微任务链尚未完成。断言的通过与否取决于机器瞬时负载，属于典型的 timing-sensitive flaky test。

## 建议修复方向（二选一）

1. **放宽窗口（最小改动）**：把 10ms 提高到一个在过载 CI 上也有充分余量的值（如 100–200ms），并加注释说明这只是"让 tick 开始等待"的让出，不是性能断言。缺点：仍是墙钟时间，理论上不是 100% 确定。
2. **改确定性同步（推荐）**：去掉墙钟依赖——例如用 `vi.waitFor(() => expect(tickResolved).toBe(true))` 轮询等待（项目已有此用法），或重构被测代码注入可控的调度钩子 / 使用 `vi.useFakeTimers()` 显式推进，使"runTask 已开始等待 workerPromise"成为可观测的确定性事件。

## 影响范围

- 仅测试层：`tests/scheduler/scheduler.test.ts` 单个用例，不涉及 `src/scheduler/*` 产品代码（已确认被测逻辑本身正确）。
- 影响面：全量 `pnpm test` 偶发红，需要人工重跑确认，降低 CI 信号可信度。
- 不影响引擎功能、不影响其他 287 个引擎测试。

## 验收标准

- 在 turbo 并行满载下连续跑 20 次完整 `pnpm test`，该用例 0 失败。
