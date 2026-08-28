# 按需工具目录（Tool Catalog）设计规格——缩略常驻 + 取回即注入

> 版本：1.0 | 日期：2026-08-26
> 状态：设计定案（实施 plan 另立）
> 目标：动态工具（MCP / 外部插件）从「全量 schema 每轮常驻」改为「一行缩略目录常驻 + 模型按需取回全文后使用」，把固定上下文成本降一个数量级，功能不缩。

---

## 1. 背景与问题

工具 schema 是每轮请求的固定成本（2026-08-26 本仓库实测：内置 14 工具合计 3481 tokens，单个 63–955）。挂 MCP 后失控：一个中等 MCP server（15–25 工具）约 4k–8k tokens，三个 server + 内置 ≈ 固定 15–20k——80k 窗口没说话先没四分之一。L6-ext 裁剪（2026-08-26 封口）只治撞顶急救（被动派），治不了日常浪费：没撞顶的每一轮也在为闲置工具全额付费。

**先例（本仓库同一哲学已表达两次）：**

- Skill 系统：L1 只注技能目录（名字+一句话）作发现入口，规程正文经 `skill` 工具按名取回（`tools/builtin/skill.ts:23-62`，fail-closed 返可用名录）。
- recall 工具：浏览压缩档目录 → 按 topicId 取归档原文。

本设计是该哲学的第三次表达，应用到工具面上。外部参照：Claude Code ToolSearch（defer_loading + 搜索注入）；本设计取「目录可见」路线而非「搜索命中」路线——模型看得到全貌做选择，与 skill 系统同构。

## 2. 现状机制证据（实施锚点）

- L1 注入点：`core/agent-worker.ts:662-678`——promptParts = SOUL.md → Skills 段（目录 + `SKILL_DISCIPLINE`）→ `SECURITY_GUIDELINE`（固定尾部）。新目录段插入 Skills 段之后、SECURITY_GUIDELINE 之前。
- 工具表每轮构造：`agent-worker.ts:652-659`（`toolDescriptions` = 全量 Tool 实例 → OpenAI function 格式）。
- turn 机制：`core/react/turn.ts:172,184`——tools 每轮开头经 pipeline.assemble 一次、整轮固定，step 从循环域取（`:289`）。「取回即注入」的注入点 = 让 step 工具表在轮内可增量。
- 水位口径：每步 `contextUsedTokens(result, messages, tools)`（turn.ts:351/423/491）——只要注入走 stepInput.tools，增量自动计入水位，无预算盲区。
- 工具装配：`ctx.tools.forAgent(agentConfig)` 合并内置+MCP+外部（`plugins/tools`），worker `config.tools` 持全量 Tool 实例——目录与取回的全量源。
- 分类复用：`context/tool-classify.ts`（前缀分流，决策单一事实源）；schema 版 `isExtTool` 吃 OpenAI 形状，需补名字版供 Tool 实例侧用。

## 3. 设计（已定决策，不翻案）

### 决策 1：适用范围
仅 `mcp__` / `ext__` 前缀动态工具目录化；内置 14 工具全量常驻（含本单新增的取回工具本身）。**无动态工具的 Agent 行为与现状恒等**（无目录段、无新工具以外的任何变化）——这是硬验收。

### 决策 2：目录形态（缩略常驻）
L1 新段「# 按需工具」，每行一条：`- <限定名> — <首句描述>`（描述取首句/截 ~80 字符）。段首附 `TOOL_CATALOG_DISCIPLINE`（仿 `SKILL_DISCIPLINE` 语义：目录中的工具须先经 `load_tool` 取回再使用；未取回不得假装调用；取回后方有完整参数说明）。60 条目录 ≈ 600–1200 tokens，替代 5–10k 全量。

### 决策 3：取回工具 `load_tool`
新内置工具（第 15 件，core 常驻）：参数 `names: string[]`（≤8 批量）；免审批（元数据只读，同 skill 工具档）；fail-closed——未知名返回错误 + 可用名录；传入已常驻的内置名返回明确错误「该工具已常驻，无需取回」。返回 = 每个工具的完整描述 + parameters JSON Schema（即原 schema 全文）。

### 决策 4：取回即注入（session 粘性 + 轮内生效）
- worker 级 `DynamicToolLoader`：持 session 粘性 loaded set（cap 16，LRU 逐出最久未用；worker 退役/重建天然清空，config 变更语义无额外状态）。
- `load_tool` execute：校验名字属本 agent 动态工具集 → 加入 loaded set → 返回全文。
- **注入**：每轮 `input.tools` = 内置全量 + loaded 集中的动态工具（经 pipeline 自然分流——loaded 动态工具归 l6Ext，仍服从降级，语义与 L6-ext 一致：被裁回合模型不知道它可用，执行面 toolsMap 注册不受 schema 展示影响）。
- **轮内生效**：turn 循环每步重建 stepInput.tools（turn.ts 工具表从「轮初固定」改为「步前重读 loaded」）——step N 取回，step N+1 可调。

### 决策 5：审批正交
`load_tool` 免审批；被取回工具自身 `requiresApproval` 不变，实调时照走既有审批/审计链（mcp__/ext__ 的 NO_REMEMBER 等规则按限定名自动生效，零改动）。

### 决策 6：缓存前缀稳定
目录段只在动态工具集变化时变化（MCP 连接变化/插件清单变更 → worker 退役重建时刷新）；静态期间字节稳定。SOUL/Skills/SECURITY_GUIDELINE 三段不动。

### 决策 7：零接口破坏
`Tool` 接口不加字段；`AssembleInput` 形状不变；puppet 路径不动（裸跑无 L1，工具照旧全量）；skill/recall 系统不动。

## 4. 机制细部

### 4.1 一轮的完整生命周期
1. worker 构造：内置 14+1 schema 全量 + loaded 动态工具 schema → toolDescriptions；动态工具（未 loaded）→ 目录段文本进 L1。
2. pipeline.assemble：schemas 走 core/ext 分流（loaded 动态工具 = ext）；目录段属 L1 永不裁。
3. 模型从 L1 目录发现需要的工具 → 调 `load_tool`（轮内某 step）。
4. execute 更新 loaded set + 返回全文；下一 step 的 stepInput.tools 含该工具 schema。
5. 模型按全文参数调目标工具（如需审批照走）。
6. 跨轮：loaded set 粘性保留（LRU 16），常用工具一次取回多轮受益；16 人满后最久未用逐出（再取即重载，代价一跳）。

### 4.2 与 L6-ext 的层级关系（不冲突）
- 本设计治**日常浪费**：未取回工具零 schema 成本，只付一行目录。
- L6-ext 治**撞顶急救**：loaded 工具在极端预算下仍可被 halve/drop（先裁后 loaded 的，注册序保前部）。
- 顺序：先有不带，再有得扔。

### 4.3 fail-closed 面
- load_tool 未知名/内置名/超批量 → 结构化错误（含可用名录或原因），不写 loaded set。
- 动态工具集为空 → 不渲染目录段（恒等验收）。
- MCP 断线保注册：目录照常列出（快照语义），实调走既有自愈/降级。

## 5. 非目标

- 不做工具搜索（embedding 检索）——目录可见路线已足，搜索是另一张单。
- 不做 schema 文本压缩（Zenodo 路线）。
- 不做 loaded set 持久化（重启即空，重取一跳，可接受）。
- builtin 工具不目录化；dispatch 系保持 core 常驻（同 L6-ext 决策 1 理由）。

## 6. 验收标准

1. 无动态工具的 agent：L1 无目录段、轮行为与现状恒等（既有测试零回归）。
2. 挂 MCP 的 agent：L1 有目录段且每行格式合规；工具 schema 表默认不含未 loaded 动态工具。
3. load_tool：取回 → 下一步 stepInput.tools 含该 schema → 模型可调用；未知名/内置名/超限全 fail-closed。
4. 粘性：第二轮未取回的已 loaded 工具仍在工具表；第 17 个取回逐出最久未用。
5. 降级：loaded 动态工具进 l6Ext 参与 halve/drop；目录段（L1）永不裁。
6. 审批：mcp__ 工具取回后实调仍按 toolOverrides/annotations 走审批。
7. 效果：含 60 个动态工具的 agent，轮固定工具成本从全量降至目录 + 内置量级（测试用计数断言，不用估算）。

## 7. 开放点（不阻塞）

- 目录段在 L1 的长度治理：动态工具破百时目录本身也臃肿（截断到 N 条 + 「还有 M 件，用 load_tool 按名取」？v1 不设限，观察）。
- loaded 工具跨话题压缩后的「活跃保护」（仿 used_skills 自动重取）——v1 靠粘性自然覆盖，压缩不换 worker，无需机制。
- 多 MCP server 时目录排序（按 server 分组？v1 按注册序平铺）。

---

> 实施 plan 另立：`docs/superpowers/plans/2026-08-26-tool-catalog-plan.md`。
