# CMZ Cordis 插件化迁移方案（阶段 0：只读侦察 + 设计）

- 日期：2026-08-14
- 范围：`services/engine`（bootstrap.ts 657 行手工接线 → Cordis 插件树）
- 性质：阶段 0 交付物——只读侦察结论 + 迁移方案设计；本单不含实现代码
- 方法：npm registry 实查（命令见 A1）；3 个并行只读深扫（dsh vendor 调研 / engine 依赖真相图 / 注入点盘点）；A4 五条灵魂断言由主线逐条亲自复核代码；全部结论带 `文件:行` 或实查命令证据，查不到如实写「未找到」

**设计前提（已定决策，不翻案）：**
1. 底座全借（Cordis）+ 灵魂全自研——架构层复用，心智/记忆哲学层自研
2. 灵魂不做特权代码，写成运行时断言（dsh "model-visible means logged, a runtime invariant asserts it" 同款手法）
3. 感知注入单口：未来 `perception/inject` waterfall 是唯一感知注入点，消息带来源归属，白名单外只许改写/追加、不许吞
4. 器官清单跟人形走：`DATA_DIR/agents/<id>/plugins.yml`（与 SOUL.md 同级）；全局层 `DATA_DIR/plugins.json`；内置 bundle 兜底
5. 不做热重载（重启=睡一觉；配置变更沿用现有 worker retire/重建模式）
6. 两步走：先内部插件化（bootstrap 解体、行为零变化、测试保绿），后外部插件发现

---

## A. 只读侦察结论

### A1. Cordis 选型调研

**上游 npm 包实查**（2026-08-14 执行）：

```
npm view cordis version time license dependencies maintainers repository homepage
npm view cordis versions --json
npm view @cordisjs/core version
```

输出摘要：

- 最新版本 `4.0.0-rc.8`，发布于 2026-08-10（registry `modified` 同日，活跃维护中）
- license：MIT；maintainer：shigma；仓库 `github.com/cordiverse/cordis`（packages/core）
- 运行时依赖仅 2 个：`@standard-schema/spec ^1.1.0`、`cosmokit ^1.8.1`
- 版本线：3.x 稳定线止于 `3.18.1`（2024-09-17，距今约 2 年未动）；4.0.0 自 2024-11-11 alpha → 2025-03-29 beta → 2026-03-28 进入 rc → 2026-08-10 rc.8，迭代密集
- `@cordisjs/core` 是旧 scope 名，停在 `3.18.1`
- TS 类型：包以 TypeScript 写成并随包发布类型（vendored 副本 `vendor/cordis/package.json:16` 的 `types: lib/types/index.d.ts` 与 exports `:18-25` 沿用上游结构，可佐证）

**dsh vendored 版与上游的差异**（证据相对 dsh 根 `F:\MyProject_justlove\参考\deepseek-harness-master`）：

- 为什么 vendor：`vendor/README.md:3`——"harness fully owns its framework layer (auditable, patchable, pinned)"；`:5` 全部 rescope 进 `@deepseek-ai/*`（harness 包把 cordis 声明为 peer dep，连带发布会抢占上游注册名）；`:31` 治理门禁"每条与上游的分歧必须穷尽记录"
- fork 版本：`@deepseek-ai/cordis 4.0.1`（`vendor/cordis/package.json:2,4`）；`vendor/README.md:17` manifest 表记上游快照为 `cordis 4.0.0-rc.7` @ commit `56b3d4f7…`——两处版本号不一致，如实记录，不做推测
- 本地修改 18 条（`vendor/README.md:33-50`），其中行为级 ≥6 项：
  1. fiber 生命周期加固：`vendor/cordis/src/fiber.ts:110-112`（effectInertia）、`:119-137`（emitPluginDisposed 收容 teardown 通知失败）、`:420-422`（UNLOADING 拒绝创建 effect）、`:299-308`（先拥有完整 disposer 再发布 internal/plugin）、`:504-520`（effect 先于插件代码对可重入卸载可见）、`:725-753`（`Fiber.update()` 返回 internal/update waterfall 结果）
  2. 惰性 Loader 配置解析（移植上游 PR cordiverse/cordis#41）：`fiber.ts:191-192`（`_config` 原始配置）、`:641-644`（`_resolveConfig()` 走 internal/config）、`:739-745`（非 ACTIVE 推迟解析）；事件声明 `vendor/cordis/src/events.ts:335-339`
  3. include 的 patch 语义导出 + 上游 bug 修复（insert 行随插随建索引，同层靠后 patch 可配置/禁用前面 insert 的行）：`vendor/include/src/index.ts:23,58,96-101`
  4. entry `disabled` 的 `!!js` 插值：`vendor/loader/src/config/entry.ts:101-107`
  5. JSDoc 全量补全（comment-only，动机是 API 文档生成器 hard-error）
  6. Node 原生 TS 兼容（内部导入显式 `.ts` 后缀）：`vendor/cordis/src/index.ts:2-14`
- 结论：dsh 的 cordis 是带 18 项分歧的行为级 fork，不是"上游 + 配置"

**Cordis 核心概念速览**（`docs/cordis-primer.md` + vendor 源码）：

- 插件三形态：函数 / `new (ctx, config)` 类 / `{ apply(ctx, config) }` 对象（`vendor/cordis/src/registry.ts:92-133`）；公共元数据 `name` / `Config` / `inject` / `provide` / `intercept`（`:99-111`）
- Fiber 生命周期：`PENDING`（等依赖）→ `LOADING` → `ACTIVE`；`FAILED` / `UNLOADING` / `DISPOSED`（`fiber.ts:139-154`）；缺 inject 依赖时停在 PENDING，依赖到齐才激活（`fiber.ts:611-623`）
- 一切注册都是可逆 effect：disposer 逆序执行、二次调用 no-op（`fiber.ts:76-93,402-561`）；`ctx.on()` 经 fiber effect 注册，fiber 卸载自动回收（`events.ts:254-260`）；父卸载级联子卸载（`fiber.ts:265`）
- Context 是 proxy：`extend()`/`isolate()`/`intercept()` 创建作用域子上下文而不改父（`context.ts:36-41,99-145`）
- 五种派发模式（`events.ts:24-32`）：`emit`（同步、不等 Promise、忽略返回值，`:194-196`）；`parallel`（Promise.allSettled，失败汇 AggregateError，`:183-187`）；`serial`（按注册序逐个 await，可 bail，`:204-209`）；`bail`（serial 同步版，`:217-222`）；`waterfall`（around 中间件，不调 `next()` 即否决后续链含内建行为，`:224-243`）
- 配置三层：entry 原始 config → `internal/config` waterfall 惰性解析 → `ctx.intercept` 祖先合并；`Config` 为 standard-schema 校验器，启动前校验失败抛 ValidationError（`fiber.ts:18-62`）
- 内建 `internal/*` 事件：`events.ts:321-352`

**最小插件解剖**（`packages/context/time-context/src/index.ts`，209 行）：`name`（:21）+ `inject = ['agents']`（:24）+ `Config` interface 与同名 schemastery schema 并存（:27-38）+ `apply(ctx, config)`（:145）；以 `{ prepend: true }` 挂 waterfall 监听，先 `await next()` 委托下游再追加带来源归属的消息（:170-208）；无显式 teardown——`ctx.on` 注册随 fiber dispose 自动摘除（:140-142）。另有伴生 invariant 插件（`src/invariant.ts:22-25`）。

**cordis.patch.yml 配置语义**（`packages/bundle/base/cordis.patch.yml` + `vendor/include/src/index.ts`）：文件是 patch 列表；`insert` 不带 id 追加根部、带 id 入 group（`include/src/index.ts:80-95`）；非 insert patch 按 id 寻址，缺失/未命中/name 不符均 warn+skip（`:105-119`）；覆盖是整体替换而非合并（`:121-124`）；`disabled: true | !!js 表达式`（每次挂载决策求值）；层叠顺序：空列表 → bundle → profile patch → home patch → `--patch` overlay（`docs/architecture.md:27`），同行 last write wins。

**"model-visible means logged" 运行时断言**（决策 2 的参照实现）：

- 规则陈述：`docs/architecture.md:96`——"Anything that reaches a model request must be reconstructable from the log, and a runtime invariant asserts it."
- 断言落点：`packages/core/agent-loop/src/invariant.ts:19-55`——伴生插件 `agent-loop-invariant` 以 `{ global: true, prepend: true }` 挂 `llm/stream` waterfall（:54），对每个请求断言：options/messages 冻结（:23,27-29）、存活 session id（:24-26）、日志含 step/start 与 request/header（:32-38）、**`JSON.stringify(options.messages) !== JSON.stringify(session.deriveMessages())` 即 fail "log-reconstruction desync"（:39-42）**、请求头字段一致（:44-52）
- 机制底座：`packages/runtime-diagnostics/invariants/src/index.ts`——`ctx.invariants` 服务，`register(packageName, installer)`（:136）、`fail()` 抛 `InvariantError`（:50-64,162）、以 cordis effect 安装（:188）；有 `verify-package-invariants` 穷尽性门禁
- 未找到：生产 bundle 中挂载 InvariantRegistry 的确切位置（三个 bundle 的 cordis.patch.yml 均无 invariants 行；仅 `packages/examples/agent-spine-demo/src/index.ts:26-30` 显式挂载）——如实记录

### A2. CMZ 模块依赖真相图（要点）

入口 `services/engine/src/bootstrap.ts`（`main()` 起于 :86）。完整实例化全表与模块档案在深扫报告基础上经主线抽核（bootstrap.ts 全文、worker-registry.ts 全文已由主线亲自读过）。要点：

**构造依赖全表（bootstrap.ts 行号）**：ConfigRepository(:87) / AgentRepository(:88，onChange→workerRegistry.retire :92-95) / WorkerRegistry(:90) / SidecarClient(:97) / SkillService(:101-111) / RecallService(:114-116) / PuppetModelService(:118) / IntermindService(:120-124) / McpClientManager(:127-128) / runAgentCollect(:132-154) / PuppetRunner(:159-202) / BackgroundManager(:204-220) / HandoffManager(:222) / HandoffLoopRegistry(:224) / SubagentDispatcher(:225-230) / SubagentSwarm(:234-239) / getPlanManager(:241-258) / getOrCreateWorker(:260-379) / 工厂群 findProviderConfig(:381)、createLLMProvider(:387)、createFallbackLLMProvider(:434)、createEmbedderProvider(:472)、createImageProvider(:484) / ApiContext(:496-527) / Scheduler(:529) / 启动对账(:533-595) / createServer(:599) / getAuthToken(:602) / registerShutdownHandlers(:641-651)。

**前向引用 / 循环依赖**：

- `getOrCreateWorker`（:260，async 函数声明提升）被三处于声明前引用：:123（IntermindService.getAgentWorker）、:137（runAgentCollect 体内）、:216（createSubagentTerminalNotifier.getWorker）——箭头函数延迟求值 + 函数声明提升，运行时安全但有顺序耦合
- 同模式：`findProviderConfig`(:381) 被 :169/:272/:396/:441/:555 引用；`createLLMProvider`(:387) 被 :171/:249/:274/:560 引用；`createFallbackLLMProvider`(:434) 被 :176/:279 引用
- **唯一 const TDZ 前向引用**：`subagentDispatcher`（const，:225）被 :194 前向引用（puppetRunner.getRuntime 的 services 内）——靠 getRuntime 延迟到运行时才安全；插件化时若把构造改急切求值会炸
- 无文件级运行时循环 import；但存在 4 组**包级双向值依赖**（决定插件加载顺序约束）：
  1. config ↔ memory：config/{auth-token,crypto,repository} → memory/document-store；memory/{topic/state,topic/store,repositories/*} → config/paths
  2. memory ↔ scheduler：memory/{indexer(:4), repositories/agent(:9)} → scheduler/error-throttle；scheduler/repository → memory/document-store
  3. mind ↔ memory：mind/mind-files → memory/document-store；memory/topic/compression-task(:4-5) → mind/{mind-files, injection-filter}
  4. context ↔ memory（一半类型级）：context/semantic(:5) → memory/topic/store（值）；memory/topic/store → context/layers（类型级）
- **层间倒置**（迁移前置清理对象）：core/agent-worker.ts:44 与 subagent/puppet.ts:7 值级依赖 `api/ws/approval-audit`；logger.ts:2 值级依赖 `api/log-buffer`

**per-agent 懒创建点**：AgentWorker（bootstrap.ts:260 → worker-registry.ts:54，Map 缓存 + inflight 共享 + retire 竞态处理 worker-registry.ts:15-88）；PlanManager（bootstrap.ts:241-258）；ApiContext 四类 repository per-call 现造（:498-501）；SchedulerRepository（scheduler.ts:53,92）；puppet runtime 每次运行现造（bootstrap.ts:161-201）；HandoffResumeLoop 按 WS 连接现造（api/ws/handler.ts:100）；SkillService 的 historyStore per-call（skills/service.ts:70）与 resolveCache 30s TTL（:50）。

**全局单例**：bootstrap 内 21 个（见构造全表）+ 模块级 3 个：logger（logger.ts:19）、tiktoken（context/token-counter.ts:58-63）、auth-token 缓存（config/auth-token.ts:39-49，测试清缓存口 :56）。

**接线中枢（插件化的三条天然接缝）**：`ApiContext`（api/context.ts:24，REST/WS 路由的服务聚合）、AgentWorker 的 `services` 注入（bootstrap.ts:327-335 与 :193-199）、`ToolServices`（tools/types.ts:17，类型级引用 6 个模块）。

### A3. 注入点/事件点现状

**总结论：引擎目前没有任何通用 hook/事件总线**，所有"外部行为"都是源码级接线（构造注入回调或直接函数调用）。逐点：

1. **enqueueSystemNotice 感知注入**：函数本体 agent-worker.ts:281-307（签名 `text, sourceId, opts?.intermindRide`；无前后钩子，挂新行为只能改函数体）。生产者仅 2 个：subagent 终态通知 subagent/notify.ts:51（开关判定 :44-45，触发源 background.ts:317-319 的 onTaskTerminal）、intermind 私信唤醒 intermind/service.ts:147-151（:140 wake!==false；回信搭车不唤醒 :158-164）。流向：先落热存储（agent-worker.ts:292-296）→ 构造无 onApprovalRequest 的 Job 入队（:297-306，感知回合写类工具 fail-closed 的防环设计）→ processQueue FIFO 消费（:504-507）→ 作为 user 消息进 pipeline L3（:682 → turn.ts:443 → pipeline.ts:164）
2. **turn.ts 回合流程**（runTurn 入口 turn.ts:429-750）：历史清洗 :435 → pipeline 组装 :440-453 → 预检（refresh :479、水位 :500-505、撞顶 :525-526、提醒 :527-535）→ 主循环/工具调用 :537-673（executeLoopStep step.ts:51 → runToolCallBatch tool-call.ts:30，审批门 tool-call.ts:71 → agent-worker.ts:731-756）→ 步后落盘 :580-597（onStepAppended :594-596）→ 步后水位 :599-668（撞顶 :607-621 break、70% 提醒 :622-654，阈值硬编码 :60-61）→ 收尾兜底 :677-728（runMaxStepsSummary :691、writeHandoffBookContent :713、makeHandoffBook :714）→ turn.end :732。**唯一显式注入式钩子：onStepAppended、signal、emit、contextPipeline、resolveSessionTaskText**；预检/水位/收尾各阶段无对外口子
3. **scheduler 触发链**：bootstrap.ts:529 装配（`new Scheduler(context, …)` 吃整个 ApiContext，scheduler.ts:28）→ :597 start → setInterval 5s tick（scheduler.ts:32-37）→ tick 遍历 agents、isDue 判定（:47-74）→ runTask（:88-129：推进排期 :96-102 → getAgentWorker :104 → worker.runScheduledTask :107-119）→ agent-worker.ts:309-331（user 消息落热存储 :310-328 → enqueue :330）
4. **handoff 撞顶触发链**：撞顶检测 turn.ts:525-526（预检 ≥0.9）与 :607-621（步后 ≥0.9 break）→ 交接书产出 :707-727（writeHandoffBookContent :713 → makeHandoffBook :714 → onStepAppended 落历史 :723-725）→ worker 发 handoff.book 事件 agent-worker.ts:807-821 → ws 层拦截 handler.ts:173-189 → HandoffResumeLoop.onWatermarkBook resume-loop.ts:54-56 → handleBook :77-145（控制面落盘 :111、保险丝 :120-129、定时器 :131-133）→ startResume :147-198 → deps.enqueueResume（实现 handler.ts:115-165：加载历史 :120 → 重新解析 worker :123-124 → enqueue 带 handoffResume :125-152）→ worker 交接书置顶注入 agent-worker.ts:791-796（HANDOFF_RESUME_GUIDE :109-111）→ pipeline 置顶（pipeline.ts:195，assembler.ts:48-50，置于 L1 前永不降级）。打断入口 resume-loop.ts:289-309 经 handoff/registry.ts:20,30,65
5. **context pipeline 组装**：层定义 context/layers.ts:39-56；来源数据在 agent-worker.ts processQueue 收集，入层/拼接在 pipeline.ts 与 assembler.ts。置顶（交接书）：agent-worker.ts:791-796 → assembler.ts:48-50；**L1** 人格前缀：loadSoul :558 + Skills 目录 :560-567（SKILL_DISCIPLINE :100-103）+ SECURITY_GUIDELINE :570 → pipeline.ts:161,196 / assembler.ts:53-55；**L2** @提及：声明于 pipeline.ts:57 但生产路径未传——**L2 当前未接线，是现成空槽位**；**L3** 热上下文：job.messages :682 → turn.ts:443 → pipeline.ts:164（滤旧水位提醒 :39-46）→ assembler.ts:67-69；MIND 附加层：:670-680 → pipeline.ts:171,198 → assembler.ts:73-75（伪装 assistant 追加 L3 后）；**L4** 语义检索：:652-665（SemanticRetriever 构造 :241-247）→ pipeline.ts:166-168（置信度 ≤0.5 丢弃+多轮去重）→ assembler.ts:63；**L5** 话题摘要：:594-602 → pipeline.ts:169 → assembler.ts:62；尾部附加（规程恢复/检索失败告知）：:608-646 → pipeline.ts:199-200 → assembler.ts:78-84；**L6** 工具定义：:546-553 → turn.ts:444 → pipeline.ts:172-174（l6Core=全部内置，l6Ext 恒空预留），**不走 message 通道**，经 AssembleResult.tools 单独返回（pipeline.ts:80-81,217）。组装主循环 pipeline.ts:158-266，降级序 L5→L4→L6-ext→L3（layers.ts:62，selectNextStep 在 context/downgrade.ts）

**现有最自然的 hook 挂接面**（迁移时的事件接缝）：Job.onEvent/onDone/onApprovalRequest（agent-worker.ts:174-178）、TurnInput.onStepAppended/signal（turn.ts:93,108）、ToolContext.services（agent-worker.ts:142,758 → tool-call.ts:85）、HandoffResumeLoopDeps（resume-loop.ts:12-25）、BackgroundManagerDeps.onTaskTerminal（background.ts:100）。

### A4. 灵魂断言落点核查（主线逐条亲自复核）

| # | 断言 | 落点（文件:行） | 判定 |
|---|---|---|---|
| 1 | 同一 agentId 意识串行（FIFO） | 队列 agent-worker.ts:198；入队 :250-269（含退役守卫 :257-260）；单 runningJob 出队 :504-507；finally 再触发 :878-881；waitForIdle :382-386；创建/替换/退役唯一权威 worker-registry.ts:15-88（retire :29-46、inflight 共享 :61-62、等待 retiring :64-70、pendingRetires :81-83） | **现状已强制**（AgentWorker 队列 + WorkerRegistry 双层结构） |
| 2 | 模型可见即可从存储重建 | 历史取自 repository：api/ws/handler.ts:342,356、ws/session-handler.ts:238,240（listBySession limit 20）；新产出 step 级落盘 agent-worker.ts:769-779；系统通知先落盘后入队 :292-296；scheduler user 消息先落盘 :309-331；pipeline 注入全部来自可重建存储（SOUL.md :558、L5 压缩档 :597、MIND.md :673、L4 来自已落盘消息的向量索引 :652-665） | **靠结构保证**（链路上无"注入而不落盘"的口子），**但无显式运行时断言**——每轮组装时不校验"模型所见 == 存储重建"，决策 2 的断言化是迁移新增面 |
| 3 | 话题压缩「先归档后移除热存储」 | 顺序保证在单方法内：message.ts:131-142（:137 注释"先写归档再删热存储：归档成功前不动 messages.jsonl"；先 archiveStore().appendLine :138-140 再 mutateLines 剔除 :141）；压缩档先于归档落盘 compression-task.ts:68→86；归档失败隔离压缩档 :88-91；注入嫌疑降级仅归档 :63-66；短话题仅归档 :29-32 | **现状已强制** |
| 4 | 傀儡无 SOUL / 无持久记忆 | puppet.ts:14-20（设计注释：无 SOUL/无 MIND/记忆即弃）；手工 messages + buildPuppetSystemPrompt :116-130,:49-63（不调 loadSoul）；runTurn 裸跑不传 contextPipeline/onStepAppended :140-169（热存储与向量索引零新增）；bootstrap.ts:156-202 傀儡路径不走 AgentWorker；LLM 调用仍落档 llm_calls.jsonl（bootstrap.ts:164-168，属审计非记忆） | **现状已强制**（结构性：路径上根本没有落盘钩子与人格加载） |
| 5 | 写类/出网工具审批 fail-closed | 默认面 agent-worker.ts:731-756：全局门 config.approve（bootstrap.ts:312 当前 `() => true`）→ requiresApproval 且无 onApprovalRequest → auditFailClosed + return false（:737-741）→ trustAllTools 仅在有审批通道时生效且不越无通道路径（:745-754）→ 人工通道 :755；傀儡同语义 puppet.ts:151-160；感知回合无审批通道（:297-306）故写类天然 fail-closed | **现状已强制** |

---

## B. 迁移方案设计

### B1. 校验版服务清单（对 v1 草案的修正）

v1 草案：config / agents / llm(+embedder,imagegen) / tools / skills / memory / pipeline / perception / scheduler / plans / subagents / intermind / handoff / sidecar / http / log（16 项）。

校验结论：**16 项全部保留，其中 3 项需修正边界；新增 5 项（mind / compute / conductor / blueprint / approval-audit）；另列 4 类"不入清单"**。修正后 21 个服务。

| 服务 | 现状模块证据 | 判定与修正理由 |
|---|---|---|
| log | logger.ts:19（模块单例）；api/log-buffer.ts:14,24 | **保留，边界修正**：log-buffer 必须随 log 一并下沉——logger.ts:2 值级反向依赖 api/log-buffer 是层间倒置，不一起搬则倒置原样残留 |
| config | config/repository.ts:73、paths.ts:5,9,13、agent-tools.ts:12、auth-token.ts:39-49、crypto.ts:54,65 | **保留**：auth-token/crypto 归入本服务（bootstrap.ts:602 的 listen 前 token 就绪语义保留）；注意 config → memory/document-store 值级出边（auth-token.ts:4、crypto.ts:4、repository.ts:4），依赖 memory 基座 |
| agents | memory/repositories/agent.ts:14（AgentRepository）+ core/worker-registry.ts:15 + bootstrap.ts:260-379 getOrCreateWorker | **保留，扩义**：v1 只像"agent 配置"，真相是配置 + worker 生命周期权威强耦合（onChange→retire，bootstrap.ts:92-95），二者必须同插件或经显式事件连接；per-agent 懒创建映射为 cordis 子 fiber/scope |
| llm(+embedder,imagegen) | provider/{llm.ts:14,29、resilient.ts:37、protocols/index.ts:31,136,244、embedder.ts:5,30、image-gen.ts:5,31、record-calls.ts:27、errors.ts:1}；bootstrap 工厂群 :381-494 | **保留**：最干净叶模块之一（仅依赖 logger）；record-calls 归本服务——它是"logged"半边的落点，决策 2 断言的数据源 |
| tools | tools/builtin/index.ts:16（13 个内置）、tools/mcp/client-manager.ts:73、tools/registry.ts:4、types.ts:17,33,52 | **保留**：切断两条值级出边为 inject——dispatch_subagent.ts:3 → subagent/dispatcher、read_private_messages.ts:4 → intermind/service |
| skills | skills/service.ts:42（接口 :29）、loader.ts:10 | **保留**：findBuiltinSkillsDir 的 cwd 向上查找（bootstrap.ts:62-84）与 ZOME_BUILTIN_SKILLS_DIR 语义保留 |
| memory | document-store.ts:48、repositories×5（agent:14/message:6/memory:6/action:6/llm-call:6）、indexer.ts:31、recall.ts:73、reconcile.ts:31,61,93、topic/*（tracker:34/queue:8/compression-task:25/compressor:143/judge:91,113/state:95-122/store） | **保留**：须先承接 error-throttle 出边（memory/indexer.ts:4、repositories/agent.ts:9 → scheduler/error-throttle——下沉到基座插件，否则 memory↔scheduler 双向边带进插件树） |
| pipeline | context/{pipeline.ts:95、layers.ts、assembler.ts:42、downgrade.ts:114、semantic.ts:71、token-counter.ts:60、recall.ts、history-sanitize.ts:19、truncate.ts:47、security-guideline.ts:12}；core/pipeline-factory.ts:13 | **保留**（对应 context/ 目录）：per-agent 实例经 pipeline-factory；token-counter 保持进程单例（:58-63 注释明言防 WASM 泄漏）；L2 空槽位（pipeline.ts:57 声明未接线）是 perception 期现成挂点 |
| perception | 现状无模块；胚胎是 agent-worker.ts:281-307 enqueueSystemNotice | **保留（新建服务）**：决策 3 的单口总线；事件定义见 B2 |
| scheduler | scheduler/scheduler.ts:20（构造吃整个 ApiContext :28）、repository.ts:7、engine.ts:3,13、error-throttle.ts:31 | **保留，构造修正**：入树前先把构造面从 ApiContext 瘦身为 inject 声明（agents + 自有 repository）；error-throttle 下沉后 memory↔scheduler 双向边解除 |
| plans | plan/manager.ts:17、repository.ts:10；bootstrap.ts:241-258 per-agent 缓存 | **保留**：执行走 runAgentCollect（api/routes/plans.ts:109），依赖 agents 服务 |
| subagents | subagent/{dispatcher.ts:17、background.ts:82、batch.ts:36、agent-run-batch.ts:132、puppet.ts:76、puppet-models.ts:135、task-repository.ts:54、notify.ts:37} | **保留**：傀儡无 SOUL/无记忆/fail-closed 三条现状强制（A4-4/5）在拆分后必须原样保持 |
| intermind | intermind/service.ts:72（deps :45-49）、audit.ts:15,33 | **保留**：对 core 的调用靠注入回调 getAgentWorker（service.ts:141）——天然 inject 形态 |
| handoff | handoff/{manager.ts:42、state.ts:12、resume-loop.ts:38、registry.ts:13、types.ts:6-11} | **保留，边界修正**：HandoffResumeLoop 现状按 WS 连接现造于 api/ws/handler.ts:100——这是 api↔handoff 跨界点，迁移时收回 handoff 插件（ws 层只留事件桥） |
| sidecar | sidecar/client.ts:88 | **保留**：干净叶模块（仅依赖 logger），首批插件化试点候选 |
| http | api/server.ts:30、16 个 register*Routes（server.ts:9-25）、ws/handler.ts:35、ws/session-handler.ts:33、listen-error.ts:14 | **保留**：ApiContext（api/context.ts:24）随各服务入树逐步解散；最终瘦身为 cordis 组合根适配层 |
| **mind（新增）** | mind/mind-files.ts:82,151,183,208,320、injection-filter.ts:35,46,54 | **v1 漏**。SOUL/MIND 是灵魂层独立面（决策 1/2），被 agent-worker(:37-42)、compression-task(:4-5)、api/routes/agents(:6) 三向消费；并入 memory 会模糊"心智哲学层自研"的边界 |
| **compute（新增）** | compute/context-window.ts:57、usage.ts:199 | **v1 漏**。W 查找链被 worker(agent-worker.ts:687-692)、puppet(puppet.ts:135-139)、bootstrap(:295) 三处共用；usage 聚合供 api/routes/compute.ts:6 |
| **conductor（新增）** | conductor/conductor.ts:9、repository.ts:7 | **v1 漏**。群聊路由纯函数 + SessionRepository（bootstrap.ts:503），被 ws/session-handler.ts:4 消费 |
| **blueprint（新增）** | blueprint/engine.ts:17、repository.ts:7 | **v1 漏**。瞬态回合（ephemeral job，agent-worker.ts:166-171）是唯一官方"绕过记忆体系"通道，经 context.getAgentWorker（engine.ts:92）执行 |
| **approval-audit（新增）** | api/ws/approval-audit.ts:35-99 | **v1 漏**。被 core/agent-worker.ts:44 与 subagent/puppet.ts:7 值级依赖（层间倒置），必须先于 worker 插件存在的独立微服务（fail-closed 审计与人工审批通道的汇聚点） |

**不入清单**（附理由）：shutdown/生命周期——由 cordis fiber 级联 dispose + 一个 drain 钩子承接（bootstrap.ts:641-651 的 drainCompression/scheduler.stop/mcpManager.close/app.close 映射为各插件 disposer），不单列服务；versioning——叶子校验工具，并入 memory 基座；git-commit/listen-error——http 内部细节；document-store——不作为独立服务露面，作 memory 基座插件的内部实现（被 8 个模块的 repository 共用，见 A2）。

### B2. 事件地图 v1

派发模式语义（A1 证据）：emit=同步不等待无返回；parallel=allSettled；serial=按序等待可 bail；waterfall=中间件，不调 next 即否决后续链。

| 事件 | 模式 | 现状生产者 | 现状消费者 | 设计生产者 | 设计消费者 |
|---|---|---|---|---|---|
| `perception/inject` | **waterfall** | 无事件：notify.ts:51 与 intermind/service.ts:147-151 直调 worker.enqueueSystemNotice（agent-worker.ts:281） | worker 队列 :297-306 → L3 | subagents 终态、intermind、scheduler 提醒等白名单插件 | perception 插件（唯一入队口；来源归属+白名单校验；白名单外只许改写/追加不许吞——waterfall 的 next() 否决语义直接兑现决策 3） |
| `turn/step` | emit | runTurn 步后落盘回调 turn.ts:594-596 | agent-worker.ts:769-779（落盘+话题快照） | turn 引擎（agents 插件内） | 断言插件、观察型消费者；落盘本体留在 worker 核心不事件化（保"logged"硬保证） |
| `turn/end` | emit | turn.ts:732；异常补帧 agent-worker.ts:870 | ws 前端（handler 转发） | turn 引擎 | http(ws 桥)、统计 |
| `watermark/warn` | emit | turn.ts:527-535（预检）、:622-654（步后 70%） | 借 onStepAppended 落提醒 :531-533,:638-640 | turn 引擎 | 观察型（日志/指标）；提醒注入行为留 turn 核心 |
| `watermark/stop` | emit | turn.ts:525-526、:607-621 | handoff 链（下条） | turn 引擎 | handoff 插件（触发交接书流程） |
| `handoff/book` | emit | agent-worker.ts:807-821 | ws 拦截 handler.ts:173-189 → resume-loop.ts:54-56 | agents/worker 插件 | handoff 插件（resume loop 从 ws 层收回插件内） |
| `scheduler/due` | emit | scheduler.ts:47-74 tick → runTask :88-129 | worker.runScheduledTask（agent-worker.ts:309-331） | scheduler 插件 | agents/worker 插件（入队） |
| `llm/request` | **waterfall** | 无现状（provider 直调） | — | worker/puppet/plan/compression 各 LLM 调用点 | **断言插件**（global+prepend，dsh invariant.ts:54 同款：JSON 比对"模型所见==存储重建"）；record-calls 落档 |
| `llm/called` | emit | withLLMCallRecording 包装层（record-calls.ts:27；bootstrap.ts:267-271,164-168,559-567） | llm_calls.jsonl | llm 插件 | 审计/usage 聚合（compute/usage.ts:199） |
| `tool/approval` | **serial** | 审批门 tool-call.ts:71 → agent-worker.ts:731-756 | 全局门（bootstrap.ts:312）→ fail-closed（:737-741）→ trustAllTools（:745-754）→ 人工通道（:755） | turn 引擎（工具批执行） | approval-audit 插件（fail-closed 默认面+审计+WS 人工审批）；serial 的可 bail 语义兑现"拒绝即中断" |
| `worker/created` / `worker/retired` | emit | worker-registry.ts:78（创建）、:29-46（retire） | 现状无事件消费（内部 Map） | agents 插件 | handoff（打断）、perception（路由表）、日志 |
| `topic/closed` | emit | tracker 关闭点 agent-worker.ts:582-587、:828-832；judge 回写 :467-482 | enqueueCompression :437-455 → CompressionQueue | agents/worker（话题 tracker） | memory 压缩插件 |
| `subagent/terminal` | emit | background.ts:317-319 onTaskTerminal | notify.ts:37-57 → 感知注入 | subagents 插件 | perception 插件（转 perception/inject） |
| `intermind/received` | emit | service.ts:147-151（写信落盘后唤醒） | worker 感知回合 | intermind 插件 | perception 插件（转 perception/inject） |
| `message/persisted` | emit | messageRepository.append 各点（agent-worker.ts:292-296,:313-328,:773） | 现状无事件；向量索引直调 :488-502,:842 | memory 插件 | indexer（向量索引）、断言插件 |

### B3. 分期迁移计划

初稿顺序：logger/config → llm/tools → scheduler → memory/pipeline → per-agent worker 挂载 → 感知总线收口。**修订为 P0–P9 共 10 期**，顺序调整两处及理由：

1. **scheduler 从第 3 期后移到触发源群（P7）**：初稿把它当"简单模块先迁"，但真相是 Scheduler 构造吃整个 ApiContext（scheduler.ts:28），早迁反而拖着整个上下文面进场；它是纯触发生产者（消费者只有一个：worker.runScheduledTask，agent-worker.ts:309-331），worker 插件就位后迁成本最低。
2. **llm 与 tools 拆开，tools 与 skills 同期**：tools 的服务通道 ToolServices（tools/types.ts:17 类型级引用 6 个模块）+ 两条值级出边（dispatch_subagent.ts:3、read_private_messages.ts:4）是硬耦合，需要 inject 机制先立；llm 是干净叶模块，先行。
3. **新增 P2 前置清理**：approval-audit/log-buffer 层间倒置不先下沉，worker 插件化时倒置会被固化进插件树。

每期通用门槛（"行为零变化"验证）：`pnpm --filter @mindcloud/engine typecheck && pnpm --filter @mindcloud/engine lint && pnpm --filter @mindcloud/engine test`（vitest run，130 个测试文件）全绿；标注 [e2e] 的期加跑 `pnpm test:e2e`（tests/e2e/chat.spec.ts、logs.spec.ts）。通用回退：每期独立提交边界，验证失败 `git revert` 该期即回到上一稳定态；bootstrap.ts 直到 P9 保持组合根身份，每期 diff 限于"一个模块域的构造从 bootstrap 移入插件"。

| 期 | 内容 | 改动面 | 保绿验证（重点测试路径） | 回退策略 |
|---|---|---|---|---|
| P0 | 准备：引入 cordis（pin 版本，见 B5）、插件目录约定与模板（参照 dsh time-context：name/inject/Config/apply）、测试基线快照 | services/engine/package.json、新目录骨架；零行为改动 | 全量基线跑通并记录 | 删依赖即回退 |
| P1 | log + config 插件化；log-buffer 随 log 下沉（解除 logger.ts:2 倒置） | logger.ts、api/log-buffer.ts、config/*、bootstrap.ts:87,602 | tests/config/*（4）、tests/api/{auth,logs,config,cors}.test.ts | revert P1 |
| P2 | approval-audit 下沉为独立微插件；llm 全家插件化（provider/* + bootstrap 工厂群 :381-494） | api/ws/approval-audit.ts 迁址、provider/*、bootstrap.ts 工厂群 | tests/provider/*（5）、tests/api/approval-audit.test.ts | revert P2 |
| P3 | tools + skills 插件化；ToolServices 改经 cordis ctx inject；切断 tools→subagent/intermind 值边 | tools/*、skills/*、tools/types.ts、bootstrap.ts:101-111,127-128,286-290 | tests/tools/**（26 含 mcp 8）、tests/skills/*（2）、tests/api/skills.test.ts、tests/packaging/builtin-skills.smoke.test.ts | revert P3 |
| P4 | memory + mind 插件化；error-throttle 从 scheduler 下沉入基座（解 memory↔scheduler 双向边）；compression-task→mind 改 inject | memory/*、mind/*、scheduler/error-throttle.ts 迁址、bootstrap.ts:88,114-116,540-595 | tests/memory/**（13）、tests/topic/**（7）、tests/mind/*（3）、tests/schema-version.test.ts、tests/api/memory.test.ts | revert P4 |
| P5 | pipeline + compute 插件化；token-counter 保持进程单例 | context/*、compute/*、core/pipeline-factory.ts、bootstrap.ts:295-299 | tests/context/**（14）、tests/compute/*（2）、tests/core/pipeline-factory.test.ts | revert P5 |
| P6 [e2e] | **per-agent worker 挂载**（最大风险期）：agents 插件 = AgentRepository + WorkerRegistry + getOrCreateWorker 解体（bootstrap.ts:260-379）+ AgentWorker + react/turn；per-agent 懒创建映射 cordis 子 fiber，retire=dispose；守门不变量：FIFO 串行（A4-1）、retire 语义（worker-registry.ts:29-46）、话题交接（bootstrap.ts:366-376）、审批链（agent-worker.ts:731-756）、ephemeral 语义（:166-171） | core/*、bootstrap.ts:90,92-95,132-154,241-379、memory/repositories/agent.ts | tests/core/*（8）、tests/handoff/*（3）、tests/subagent/puppet.test.ts、tests/api/{chat,ws,ws-session}.test.ts、tests/shutdown.test.ts + e2e | revert P6；守门四测试（worker-registry/agent-worker/react/puppet）任一红即停线 |
| P7 [e2e] | 触发源群：scheduler/plans/subagents/intermind/handoff/conductor/blueprint 各插件化；resume-loop 从 handler.ts:100 收回 handoff 插件；puppet 路径（bootstrap.ts:156-202）入 subagents | 7 个模块目录 + api/ws/handler.ts 减重、bootstrap.ts:118-124,159-239,496-535 | tests/{scheduler,plan,subagent,intermind,handoff,conductor,blueprint}/** 共约 25 个、tests/api/{scheduler,plans,subagents,intermind,handoff,blueprints,sessions}.test.ts + e2e | revert P7（按模块可分小步 revert） |
| P8 | **感知总线收口 + 灵魂断言**：perception/inject waterfall 单口（enqueueSystemNotice 改为总线注入，来源归属+白名单，决策 3）；invariant 插件把 A4-2 升级为显式运行时断言（llm/request waterfall JSON 比对，dsh 同款），并把 A4-1/3/5 的结构保证各补一条断言 | core/agent-worker.ts:281-307 改造、新增 perception 与 invariants 插件 | tests/core/agent-worker.test.ts（notice 用例 :1349,1386,1391,1401）、tests/subagent/resume-notify.test.ts、tests/intermind/service.test.ts + 新增 invariant 测试 | revert P8（断言插件可整体摘除回结构性保证） |
| P9 [e2e] | http 收口 + bootstrap 退役：createServer/16 routes/ws 瘦身为组合根适配层；ApiContext（api/context.ts:24）解散；bootstrap.ts 只剩 cordis 树挂载 + 关停钩 | api/*、bootstrap.ts 全文收尾 | tests/api/**（23）+ e2e 全量 | revert P9 |

### B4. 风险清单

| # | 风险 | 触发条件 | 缓解 |
|---|---|---|---|
| 1 | 隐式顺序依赖被破坏（bootstrap 的 6 处函数提升引用 + 1 处 const TDZ :194→:225） | 插件化把延迟求值闭包改成急切构造 | 迁移期保持"回调闭包"形态进场，再换 inject；cordis PENDING 语义（fiber.ts:611-623）天然替代手工排序；P6 守门测试 |
| 2 | FIFO 串行不变量破坏（A4-1） | worker 挂载期把 enqueue 改为事件直发绕过队列 | enqueue 保持唯一入口；P8 补运行时断言；tests/core/worker-registry.test.ts、agent-worker.test.ts 保绿 |
| 3 | "可见即可重建"断链（A4-2） | perception 插件注入消息未落盘即入队，或 pipeline 新层来源不可重建 | 保留"先落盘后入队"结构（agent-worker.ts:292-296 模式）；P8 invariant 插件 JSON 比对断言 |
| 4 | 归档顺序破坏（A4-3） | 压缩拆成事件消费者后 archiveAndRemove 被拆步/乱序 | message.ts:131-142 单方法原子序不动；tests/memory/message-repository-archive.test.ts、compression-task.test.ts 保绿 |
| 5 | 审批 fail-closed 退化（A4-5） | 审批门改事件链后默认放行，或 trustAllTools 越权无通道路径 | tool/approval 用 serial 模式、"无监听即拒绝"为内建兜底；tests/api/approval-audit.test.ts、tests/subagent/puppet.test.ts、agent-worker.test.ts 保绿 |
| 6 | cordis 4.x 仍处 RC，上游 API 漂移 | 跟版升级；或 rc 间 breaking change | pin 精确版本 + 锁文件；内部插件化（决策 6 第一步）完成前不追版；B5 的 vendor 触发条件兜底 |
| 7 | 包级双向依赖造成 inject 死等（PENDING 永不激活） | config↔memory、memory↔scheduler、mind↔memory、context↔memory 四组边原样进插件树 | P2/P4 先下沉共享基座（document-store/paths/error-throttle）；每插件 inject 声明精确到服务名 |
| 8 | 范围蔓延（顺手重构改行为） | 迁移期"顺手优化" | 行为零变化是每期硬门槛；评审只看 diff；与本单纪律一致 |
| 9 | 组装层测试盲区：bootstrap 手工接线本身无直接单测 | 接线顺序/遗漏改动无测试感知 | tests/api/** 集成测试 + e2e 兜底；P6/P7/P9 标 [e2e] 必跑 |
| 10 | Windows/打包路径假设（findBuiltinSkillsDir 向上查找 bootstrap.ts:62-84、ZOME_BUILTIN_SKILLS_DIR） | 插件化改变 cwd/目录结构假设 | tests/packaging/builtin-skills.smoke.test.ts 保绿；P3 期显式保留该解析逻辑 |

### B5. Cordis 选型结论

**推荐：直接用上游 npm 包 `cordis@4.0.0-rc.8`（pin 精确版本 + 锁文件），不 vendor dsh fork，也不自行 vendor。** 证据链：

1. **dsh fork 的行为级修改与 CMZ 决策不重叠**：fiber 加固的主战场是 HMR/热重载场景（loader/hmr 包配套修改占 18 条修改的大头），CMZ 决策 5 明确不做热重载；include/loader 的 patch 机制（`!!js` 插值、层叠 patch）对应 dsh 的配置驱动加载，CMZ 决策 4 用自研器官清单（plugins.yml/plugins.json），这套机制用不上
2. **fork 的其余修改对 CMZ 无价值**：JSDoc 补全（服务其文档生成器）、`.ts` 后缀（Node 原生 TS）、`@deepseek-ai` rescope（其发布策略）——CMZ 不发布框架层
3. **vendor 的治理成本是真实前提**：dsh 自己要求"每条分歧穷尽记录"+ lockfile hygiene 门禁（vendor/README.md:10,31）；CMZ 无分歧要记，vendor 纯亏治理成本
4. **上游包本身够用且健康**：MIT、运行时依赖仅 2 个（`@standard-schema/spec` + `cosmokit`）、2026-08-10 仍在发版、类型随包发布（A1 实查）
5. **版本风险接受 RC 线**：3.18.1 稳定但停在 2024-09 且与参考实现（dsh fork 基于 4.0.0-rc.7）不同代；4.x rc 线自 2026-03 已进入收敛期（rc.0→rc.8 五个月内 9 个 rc），pin 死单版本可控

**vendor 触发条件（写明，避免日后扯皮）**：若内部插件化阶段实证上游 RC 缺少 fork 的 fiber teardown 加固（effectInertia/emitPluginDisposed/UNLOADING 拒绝 effect，vendor/cordis/src/fiber.ts:110-137,420-422）且 CMZ 的插件停用 semantics（如感知白名单摘除、worker 子 fiber dispose）依赖该精度，则只 vendor cordis 核心单包（2 个运行时依赖，代价小），参照 dsh 同步规程（vendor/README.md:52-60：记上游 commit → 拷 src → 重放本地修改 → 更新 manifest → 全量 test/build）。

### B6. 粗粒度估算

| 期 | 人日量级 | 备注 |
|---|---|---|
| P0 准备 | 0.5 | 依赖、骨架、基线 |
| P1 log/config | 1 | 含 log-buffer 下沉 |
| P2 audit 下沉 + llm | 1.5 | 干净模块，主要量在工厂群搬迁 |
| P3 tools + skills | 2 | ToolServices inject 化是设计点 |
| P4 memory + mind | 2.5 | 双向边拆解 + topic 子系统量大 |
| P5 pipeline + compute | 1.5 | 纯计算模块，接口清晰 |
| P6 worker 挂载 | 3 | 最大风险面，含守门不变量复核 |
| P7 触发源群 | 2.5 | 7 个模块，单个 0.3-0.5 |
| P8 perception + 断言 | 2 | 含 invariant 插件新写 |
| P9 http 收口 | 1 | 适配层瘦身 |
| 回归缓冲 | 1.5 | 各期联调与 e2e 回归 |
| **合计** | **约 19–20 人日** | 对应决策 6 第一步（内部插件化）；外部插件发现另立单估算 |
