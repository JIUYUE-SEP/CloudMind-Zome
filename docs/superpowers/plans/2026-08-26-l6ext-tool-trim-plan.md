# L6-ext 工具裁剪封口计划（阶段 0 侦察 + 设计 + 实施）

- 日期：2026-08-26
- 范围：`services/engine`（context 管线 + 测试）、`docs`
- 性质：小特性/机制封口。spec 合入本 plan；路线图「二、部分实现」L6-ext 行由此单销项
- 方法：阶段 0 侦察主控亲做（带 文件:行）；实现子代理执行；独立 review + 主控终审；`pnpm verify` + `pnpm test:e2e` 绿才销记

**设计前提（已定决策，不翻案）：**

1. **分类策略：名字前缀分流**。`mcp__` / `ext__` 前缀 → L6-ext；其余一律 L6-core。14 个内置工具（含 dispatch 系）全部归 core——内置工具是 Agent 基本盘，预算压力不该静默剥夺编排能力；用户更容易预期"某 MCP 工具暂时下线"而非"突然不能派子代理"。layers.ts 旧注释里"subagent 专用"列入 ext 的设想**本单不采纳**，留开放点（未来如需可配再议）。
2. **分类函数放 pipeline 侧**（`context/` 模块内），单一事实源，所有调用方零改动。`ToolSchema = unknown`（layers.ts:5），读取名字必须过形状守卫：读不到合法名字 → **归 core**（fail-safe，永不误裁不可识别项）。
3. **ext 内优先级 = 输入顺序**（注册序），halve 保前部（既有语义）。不引入优先级字段，v1 不过度设计。
4. **零接口变化**：`AssembleInput.tools` 形状不变、worker / factory / puppet 零改动；无 ext 时行为与现状恒等。
5. **不引新依赖**。
6. **可观测**：降级日志已带 l6Ext 计数（pipeline.ts:313 附近），本单只需让分类计数进 debug 日志一行。

---

## A. 阶段 0 侦察结论

### A1. 断点
- `context/pipeline.ts:223-225`：`l6Core: [...input.tools], l6Ext: []`——注释明写「Phase 1 决策：现有 7 个内置工具全部为 L6-core；L6-ext 预留（MCP 接入后启用）」。MCP 与外部插件早已接入，**启用条件到了，分流没写**。
- `AssembleInput.tools`（pipeline.ts:74）：OpenAI function 格式 `{type:"function", function:{name, description, parameters}}`，由 `core/agent-worker.ts:652-659` 从 Tool 实例经 `zodToJsonSchema` 构造。

### A2. 降级机器（全的，无需动）
- `context/downgrade.ts:70-82`：`l6ext:halve`（>1 时 ceil 减半）→ `l6ext:drop`（清空），位于 L5 → L4 之后、L3 之前（序列 `:32-104`）。
- 计数重算：`pipeline.ts:301-307`——l6ext 两步执行后重组 tools 并重算 token，已正确处理"整组 JSON 编码按条拆不一致"的坑。
- 降级后回传：`AssembleResult.tools`（pipeline.ts:97-98）即发往 LLM 的最终工具表——ext 被裁的回合，LLM 看不到这些工具，语义正确。

### A3. 名字前缀锚点
- MCP 工具限定名：`mcp__<server>__<tool>`（`tools/mcp/wrapper.ts` + naming 规则）。
- 外部插件工具：`ext__<plugin>__<tool>`（`tools/external/naming.ts:11` `EXTERNAL_TOOL_PREFIX`）。
- 内置 14 工具名无前缀（builtin/index.ts 注册表）。

### A4. 观测面
- 降级日志：`pipeline.ts:313` 附近 debug 已带 `l6Ext=N` 计数（现状恒 0）。

### A5. 测试落点
- 既有：`tests/context/pipeline.test.ts`（29 例）、`tests/context/downgrade.test.ts`（9 例）、`tests/context/pipeline-incremental.test.ts`（5 例）——新用例并入同目录范式。

---

## B. 实施任务（1 个实现子代理）

1. 新文件 `services/engine/src/context/tool-classify.ts`：
   - `readToolName(schema: unknown): string | undefined`——形状守卫读 `schema.function.name`（string 才算；其余形态 undefined）。
   - `isExtTool(schema: unknown): boolean`——名字以 `mcp__` 或 `ext__` 开头 → true；读不到名字或无前缀 → false（决策 2 fail-safe）。
2. `context/pipeline.ts:223-225` 分流：`l6Core: input.tools.filter(t => !isExtTool(t))`、`l6Ext: input.tools.filter(isExtTool)`；debug 日志一行带分类计数（core=N ext=N，接 A4 既有日志点或相邻处）。
3. `context/layers.ts:57` 注释更新：删「Phase 1 恒空」过时表述，写明分类规则（决策 1）与 fail-safe（决策 2）。
4. **测试**：
   - `tests/context/tool-classify.test.ts`：mcp__/ext__/内置名/无 function 段/无 name/name 非 string/顶层 name 形态（非嵌套）六类分流断言。
   - `tests/context/pipeline.test.ts` 增补：① 混合 tools 注入后 layers 分流计数正确；② 构造超预算场景（小 budget + 大 ext 工具组），断言降级序列里 `l6ext:halve`/`l6ext:drop` 先于任何 L3 步骤生效、结果 `tools` 移除对应 ext、core 全保留；③ 无 ext 时与现状恒等（既有用例即钉，确认不红即可）。
5. **文档**（销记拍，最后做）：路线图「二、部分实现」L6-ext 行删、工具节补一句（ext=前缀动态工具，超预算按 L5→L4→L6-ext→L3 序裁剪，core 永不裁）；架构文档上下文节同步一句；开发指南如有提及处顺手。

**验收：** `pnpm --filter @mindcloud/engine test` 全绿（新增 ≥8 例）；typecheck/lint 绿；既有 29 例 pipeline 用例零回归。

## C. 评审与闸门

独立 review 子代理（非实现者）：对照决策 1-6 逐条 + 重点审 ① fail-safe 是否真不误裁 ② 降级序语义（ext 先于 L3）③ 无 ext 恒等性。主控终审亲读 diff。review 不过不合并。最后全量 `pnpm verify` + `pnpm test:e2e`。

## D. 风险与开放点

- **dispatch 系归 core 的取舍**：编排重负载 agent 在极端预算压力下仍会撞 L3 裁剪——这是决策 1 的明确取舍，不是遗漏。开放点：未来 per-agent 工具分层可配（名字规则表）时再议。
- **ext 内无优先级**：MCP 多 server 场景下 halve 按注册序裁，可能裁掉"更重要"的那个 server 的工具。v1 接受，开放点记档。
- **puppet 路径**：puppet runTurn 裸跑不走 ContextPipeline（subagent/puppet.ts），本单与其零交集，无需动。
