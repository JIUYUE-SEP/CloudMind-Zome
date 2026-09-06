# 按需工具目录实施计划（依据 spec 2026-08-26）

- 日期：2026-08-26
- 范围：`services/engine`（context/core/tools + 测试）、`docs`
- 依据：`docs/archive/superpowers/specs/2026-08-26-tool-catalog-design.md`——决策 1-7 不翻案；机制锚点（L1 注入点 agent-worker.ts:662-678、turn 固定点 turn.ts:172/184/289、水位 :351/423/491）已在 spec §2 标定
- 方法：实现子代理分阶段；独立 review + 主控终审；`pnpm verify` + `pnpm test:e2e` 绿才销记

---

## 阶段 1（引擎核心）——1 个实现子代理

1. `context/tool-classify.ts` 补 `isExtToolName(name: string): boolean`（`mcp__`/`ext__` 前缀判定名字版）；`isExtTool` 改为委托它（行为不变，既有 9 例测试零回归）。
2. 新 `services/engine/src/core/dynamic-tool-loader.ts`：
   - 构造接全量 Tool 注册表（worker 侧 `config.tools` 中按 `isExtToolName` 滤出的动态工具）。
   - `load(names: string[])` → `{ loaded: Tool[]; unknown: string[]; resident: string[] }`（resident=传入的内置名/已在 loaded 的名）；loaded set 上限 16，LRU（取回/使用刷新序，满则逐出最久未用）。
   - `loadedTools(): Tool[]`（当前 loaded 集，按最近使用序）；`catalog(): { name: string; blurb: string }[]`（未 loaded 动态工具的目录条目，blurb=描述首句截 80）。
3. 新 `tools/builtin/load_tool.ts`（第 15 件内置，core 常驻）：
   - zod：`names: z.array(z.string().min(1)).min(1).max(8)`；
   - `accesses: [{ resource: "memory", action: "read" }]`；`requiresApproval: false`；
   - execute：经 `ctx.services.dynamicToolLoader` 守卫（无 loader = 无动态工具 agent，返回「无可用动态工具」指引）；三分支 fail-closed（未知名 → 错误+可用名录；内置名 → 「已常驻无需取回」错误；超限由 schema 拦）；成功返回每件工具的 `{ name, description, parameters }` 全文 + 「已注入后续步骤可用」提示。
   - `tools/types.ts` ToolServices 加 `dynamicToolLoader`；`tools/builtin/index.ts` 注册。
4. `core/agent-worker.ts` 接线：
   - worker 构造 loader（动态工具 = config.tools.filter(t => isExtToolName(t.name))）；
   - `toolDescriptions` 改 = 内置全量 + loader.loadedTools() 的 schema（:652-659 改造）；
   - L1 promptParts 在 Skills 段后、SECURITY_GUIDELINE 前插「# 按需工具」段（含 TOOL_CATALOG_DISCIPLINE 文案 + 目录行 `- name — blurb`；catalog() 为空不渲染——恒等验收）；
   - ToolContext.services 合并 dynamicLoader（:892 附近既有合并点）；
   - runTurn 传入 `refreshTools`（见任务 5）。
5. `core/react/turn.ts` 步前重读：`TurnInput` 加可选 `refreshTools?: () => unknown[]`；循环内每步 `if (input.refreshTools) tools = input.refreshTools();`（:289 stepInput 构造前）；无 refreshTools 时行为与现状恒等。worker 侧 refreshTools 实现 = 重建「内置 + loaded」descriptions（与任务 4 同一构造函数提取复用，禁止两份真相）。
6. **测试**：
   - `tests/context/tool-classify.test.ts`：isExtToolName 三态 + isExtTool 委托恒等。
   - `tests/core/dynamic-tool-loader.test.ts`：load 成功/未知名/内置名 resident/重复取回刷新 LRU/第 17 件逐出最久未用/catalog 只列未 loaded。
   - `tests/tools/load_tool.test.ts`：schema 边界（空数组/超 8）、无 loader 指引、三分支 fail-closed、成功返回含 parameters 全文、requiresApproval=false + 注册表第 15 件钉死。
   - `tests/core/agent-worker-*.test.ts` 增补或新文件：无动态工具时 L1 无「按需工具」段（恒等）；有动态工具时目录段格式与 DISCIPLINE 文案；toolDescriptions 默认不含未 loaded 动态工具。
   - `tests/core/react/` turn 集成：stub provider 两步——step1 调 load_tool、step2 断言 stepInput.tools 含新 schema 且水位计数包含增量。

**验收：** 引擎全量绿（新增 ≥15 例）；typecheck/lint 绿；既有测试零回归（尤其 M3 契约与 watermark 用例）。

## 阶段 2（文档销记）——独立 review 通过后

- 路线图：ContextPipeline/工具节加「按需工具目录」条目（决策 1/2/4 要点 + load_tool 第 15 件 + 实测成本口径）；「二、部分实现」如有相关行顺手销。
- README：内置工具 14→15 + 一行功能说明。
- 架构文档：L1 节补目录段、L6 节补「目录化 + 取回即注入」机制图一句。
- 开发指南：如 §2.1 关键文件表提及 turn/worker 工具流，顺手对齐。
- 全量 `pnpm verify` + `pnpm test:e2e`。

## 评审与闸门

阶段 1 完 → 独立 review（重点：① 恒等性——无动态工具零变化 ② 注入语义——轮内生效与水位一致 ③ LRU 正确性 ④ fail-closed 三分支 ⑤ 与 L6-ext 层级不破坏）→ 主控终审亲读 diff → 阶段 2 → 总闸 → 三笔提交（实现/文档或合并按量定）。

## 风险与开放点

- **轮内 tools 重建成本**：每步重建 descriptions（zodToJsonSchema × ~15-20 件）——每步一次，量级微秒-毫秒级，可接受；若 profile 证伪再缓存（开放点）。
- **M3 契约类既有断言**（debug 调用次数、tools 内容断言）可能被撞——实现时先跑既有用例再增新例，红了按恒等口径修。
- spec §7 开放点（目录长度治理/活跃保护/分组排序）v1 全不做。
