# Code Review：ContextPipeline v2 Phase 1（自评审）

- 日期：2026-07-17
- 范围：`services/engine/src/context/{token-counter,layers,downgrade,assembler,pipeline}.ts` + `core/react/turn.ts` 与 `core/agent-worker.ts` 集成（commit 96fd7ff..10492bd）
- 评审人：kimi（作者自评，已按 review 纪律重新回读全部相关源码与 provider 发送层）
- 基线：设计文档 `docs/design/context-pipeline-v2.md`（含三处维克托拍板：assemble 返回 `{messages, tools}`、每轮统一 assemble、7 工具全为 L6-core）

## 总评

**可进 Phase 2。** 设计决策逐项核验全部落地：降级顺序 L5 → L4 → L6-ext → L3 由顺序链测试钉死；L1/L1.5/L2/L6-core 在实现与测试双重层面不可触碰；token 计数为 tiktoken 真实计数且与 provider 实际发送内容对齐（id/createdAt 不计入——正确）；`TurnResult.appended` 让持久化与输入组装解耦，消灭了"L3 截断导致 slice 错位"这一潜在事故。无 Blocker。三个 Major 均为**范围边界与运维面**问题（步骤内工具结果不计数、预算配置未接线、降级无观测日志），不阻塞 Phase 2 开工，但建议在 Phase 2/3 排期内消化。

## 🔴 Blocker

无。

## 🟡 Major

- **M1. 步骤内工具结果完全游离于预算之外** — `core/react/turn.ts:42-49`
  assemble 仅在轮入口执行一次，`maxSteps: 5` 循环内每步追加的 assistant + tool 消息不再计数。而工具结果体量巨大：`read_file` 无大小上限（`tools/builtin/read.ts:35-36` 全文返回）、`run_command` 单条上限 1MB（`tools/builtin/run_command.ts:6`）——一条 500KB 文件读取 ≈ 12.5 万 token，单步即可击穿 7.2 万预算并导致 provider 400。Phase 1 验收"超窗口不再报错"只覆盖了历史侧。
  建议（Phase 2）：工具结果落 context 前做 token 截断（如单条 ≤ 预算的 20%），或在 step 边界对增量做预算重检；优先给 read_file 加行数/字节上限。
- **M2. `maxContextTokens` 硬编码默认 80000，未接入任何配置** — `core/agent-worker.ts:63`
  worker 一律 `new ContextPipeline()` 用默认值；32k 窗口的模型会让管线形同虚设（预算超过真实窗口），128k+ 模型则浪费。设计文档验收 #4 明确"所有阈值可在 config 里调整"，Phase 1 未接线。
  建议（Phase 2）：从 agentConfig/model 元数据或 config.json 读取窗口与 reserveRatio，bootstrap 装配时注入。
- **M3. 降级全程静默，无任何观测点** — `context/pipeline.ts:80-94`
  L3 被逐级截断、兜底触发（`pipeline.ts:89-91`）都不留痕迹。对一个"数字生命"的记忆系统，上下文静默退化（如长期每轮都被截到 5 条）从外面看与正常无异，出了问题无从排查。
  建议：至少在兜底触发与 L3 实际截断时 `console.warn`（带 agentId、原始/截后条数、total/budget），成本一行日志。

## 🟢 Minor

- `context/token-counter.ts:41-42` — `think` 内容计入 token，但 provider 发送层实际丢弃 think（`provider/llm.ts:29-31` 只取 text）。方向安全（只会提前降级、不会溢出），但系统性偏高估计；可与发送层对齐后只计 text。
- `context/pipeline.ts:80-94` — 降级循环每轮重新 `JSON.stringify(tools)` + 全量 encode messages；Phase 1 中 tools 恒定，可 hoisting。当前延迟远优于 <100ms 验收线，仅记录。
- `context/token-counter.ts` — cl100k 统一计数对 tokenizer 更大的模型（部分中文模型 ~1 token/字）会系统性**偏少**，10% buffer 可能不够；文档已定此为接受风险，建议后续加 `tokenizerModel` 配置项。
- `core/agent-worker.ts:158-161` — 语义检索结果置于 history 头部，超预算时是 L3 中最先被截掉的部分（embed + getByIds 成本白花）。Phase 3 接入 L4 层后自然消解。
- `context/downgrade.ts:13-22` — `truncateHotContext` 在 `keep ≥ messages.length` 时仍会丢弃头部 tool 消息；当前降级路径（keep 恒小于 length）不会触发，但作为导出函数较脆弱，可加早退分支。
- 边界：assistant 带 toolCalls 结尾但无 tool 结果的脏历史（旧数据或中断轮次）会原样发给 provider 触发 400——非本阶段引入，记录备查。
- `pipeline.ts` 的 `sourceId/sourceName`、`hotMemoryCount/semanticCandidateCount` 为预留未用（接口合规，Phase 2/3 启用）；`agent-worker.ts:122-127` 的 `promptParts.join` 只剩单元素，遗留代码可简化。

## 👍 亮点

- **计数与发送层对齐核验通过**：llm.ts 实际发送 role/text/toolCalls(同名 JSON)/tool_call_id，token-counter 逐项对应计数，且正确地**不**计 id/createdAt（不上线）。`MESSAGE_OVERHEAD=4` 取 OpenAI cookbook 惯例。
- **降级语义忠实**：`selectNextStep` 头部扫描复刻 Python if/elif 链；"顺序链全序列"测试（merge→drop→keep-10→keep-5→keep-3→drop→halve×2→drop→keep-15→keep-5）把设计顺序钉死；永不压缩层不变量有专项测试（含 l6Core 引用相等）。
- **孤儿 tool 消息清理**：`truncateHotContext` 丢弃失去前置 assistant toolCalls 的 tool 消息，避免 OpenAI 协议 400——这是截断实现里最容易漏的坑。
- **`TurnResult.appended` 是本阶段最有价值的结构改进**：持久化不再依赖"输入长度 slice"，与 pipeline 的组装/截断彻底解耦，同时天然保证 system prompt 不落库。
- **防御性复制**：pipeline 不修改调用方的 history/tools 数组；assembled messages 的所有权清晰。
- **测试分层得当**：降级全路径用 FakeCounter 做确定性断言，tiktoken 真实计数有独立单测，turn/worker 两级集成测试覆盖"超预算截断后 provider 收到最新历史"。
- **YAGNI 纪律**：L6-ext 只留槽位与步骤、不提前接实现；`hotMemoryCount/semanticCandidateCount` 仅作接口预留。
