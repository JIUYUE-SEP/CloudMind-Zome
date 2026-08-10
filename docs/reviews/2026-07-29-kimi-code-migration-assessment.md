# kimi-code 四大功能对 CMZ 的可迁移性评估

- 日期：2026-07-29
- 调研对象：kimi-code（`F:\MyProject_justlove\参考\kimi-code-main`，核心在 `packages/agent-core-v2/src/agent/`）
- 目标仓库：CMZ（`services/engine`，Fastify + bootstrap.ts 函数式组装，无 DI，DocumentStore JSON/JSONL 持久化）
- 方法：只读代码调研，所有结论附 文件:行号 证据（kimi-code 侧行号相对 `packages/agent-core-v2/src/`）

---

## 一、MCP

### 1. kimi-code 怎么做的

两层结构：Session 层 `SessionMcpService` 懒建唯一的 `McpConnectionManager`，合并三层 mcp.json + plugin 配置后 `connectAll`；Agent 层 `AgentMcpService` 订阅 manager 状态，把每个 connected server 的 tools 以 `mcp__<server>__<tool>` 限定名注册进 toolRegistry。调用链上带**调用侧自愈**：`callTool` 失败按错误分类——服务器已应答的直接抛；歧义错误先 5s ping 探活，活着原地重试一次；传输已死则 single-flight 重连后用新 client 重试一次，**每次调用最多一次重连**（`agent/mcp/tools/mcp.ts:100-140`）。连接崩溃由 `onUnexpectedClose` 监听标 failed（`agent/mcp/connection-manager.ts:317-334`），断线时**保留工具注册**，故障降级为"慢调用"而非"tool not found"（`agent/mcp/mcpService.ts:225-231`）。401 时 server 翻成 `needs-auth` 状态并注册合成的 `mcp__<server>__authenticate` 工具驱动 OAuth 浏览器流（`mcpService.ts:263-282`）。

关键证据：

- 状态机 `pending | connected | failed | disabled | needs-auth`（`agent/mcp/connection-manager.ts:27`）
- single-flight 重连合并（`connection-manager.ts:248-258`）、attemptId 代际戳防竞态（`connection-manager.ts:336-339`）
- 探活语义：任何应答（含 MethodNotFound）都算活（`agent/mcp/client-shared.ts:59-71`）
- 三传输 client 统一 `MCPClient` 接口，工厂按 `config.transport` 分发（`agent/mcp/types.ts:45-59`、`connection-manager.ts:341-369`）
- stdio stderr 环形缓冲 4KB，失败时拼进错误信息（`agent/mcp/client-stdio.ts:28,162-176` + `connection-manager.ts:498-504`）
- tool 命名：字符白名单 + 下划线折叠 + 64 字符封顶加 FNV-1a 哈希后缀（`agent/mcp/tool-naming.ts:7-27`）
- 配置：zod discriminated union + 按有无 command/url 自动推断 transport（`agent/mcp/config-schema.ts:64-71`）

设计亮点：

- **探活分流 + 封顶一次**：不盲目重连，先 5s ping；明确注释接受 at-least-once 语义是刻意取舍（`tools/mcp.ts:20-23`）
- **断线保注册**：模型上下文稳定，server 掉了工具不消失（`mcpService.ts:225-231`）
- **OAuth 建模成普通工具**：`mcp__<server>__authenticate` 让模型自己引导用户完成授权，无需 UI 特判（`agent/mcp/tools/auth.ts:53-68`）
- **无熔断器是刻意设计**：全仓无 circuit breaker，靠"重试/重连各封顶一次 + 超时 + 状态机"兜底

### 2. 架构耦合度

**评级：可搬（分层搬运）。**

| 层 | 耦合 | 结论 |
|---|---|---|
| `tool-naming.ts`（27 行） | 零依赖 | 直接搬 |
| `config-schema.ts` / `client-*.ts` / `types.ts` | 仅 MCP SDK + zod + 可一行替换的 Error2 | 直接搬（换 shim） |
| `connection-manager.ts`（16.7KB） | **无 DI 装饰器**，构造参数是普通 options 对象（`:72-78`） | 核心资产，手工 `new` 即可 |
| `oauth/` 整目录 | `callback-server.ts` 纯 node:http 零依赖；store 是 3 方法小接口 | 可搬（CMZ 只做 stdio 可整目录不搬） |
| `tools/mcp.ts` 的 `retryAfterReconnect` | 与工具契约解耦良好 | 逻辑可抄，套到 CMZ tool 适配层 |
| `mcpService.ts` / `mcpDiscoveryOps.ts` / `configSection.ts` / `sessionMcpService.ts` | DI scope 注册、eventBus module augmentation、wire model/op（`mcpService.ts:18-19,26-35,411-417`） | 缠死在底座上，只抄策略不搬代码 |

### 3. CMZ 对比

已有（包 1）：stdio-only 连接、`mcp__` 前缀 + server 名 sanitize、fail-closed 审批（仅 `readOnlyHint===true` 免审批、禁 remember）、Windows cmd shim、进程树清理（`services/engine/src/tools/mcp/`）。
缺（包 2 计划）：崩溃自愈重连、调用熔断、tool.name sanitize、审批覆盖增强。

对包 2 四点的结论：

1. **崩溃自愈重连** ✅ kimi 的"意外关闭监听标 failed + 探活分流 + single-flight 重连 + 断线保注册"四件套正好全覆盖，且与 CMZ fail-closed 不冲突
2. **调用熔断** ❌ kimi 没有熔断器（刻意的"封顶一次"哲学）；CMZ 若坚持熔断属自研增量，可抄的是它的封顶纪律
3. **tool.name sanitize** ✅ `tool-naming.ts` 整文件可搬，比 CMZ 现状多字符白名单、64 字符封顶哈希
4. **审批覆盖** ⚠️ kimi 审批走通用 toolPolicy 体系（`agent/toolPolicy/evaluate.ts:44-51,90`），没有 CMZ 的 MCP 专用 fail-closed——CMZ 更严格，保留；可借鉴"approvalRule 用限定名做策略 key"

### 4. 迁移建议

**形式：适配移植（机制层）+ 直接搬代码（tool-naming.ts）。**

- 落点：`services/engine/src/tools/mcp/`
  - `tool-naming.ts` 直接搬为 `naming.ts`（替换/扩展 `wrapper.ts` 的 `sanitizeMcpName`，保留 `mcp__` 前缀约定）
  - `client-manager.ts` 增加：`onUnexpectedClose` → 标 unavailable（已有雏形，补 single-flight `reconnect()` 与 attemptId 代际戳）
  - `wrapper.ts` 的 `execute` 增加调用侧自愈：失败分类 → 5s ping 探活 → 原地重试一次 / 重连后重试一次（封顶一次）
  - 断线保注册：bootstrap 注入工具列表后 server 崩溃不摘工具（现状即快照注入，天然符合，需在文档中明确语义）
- 不搬：OAuth 整目录（stdio-only 无 401 场景）、http/sse client（路线图后续包再议）、熔断器（采纳 kimi 的"封顶一次"替代）
- 工作量：**2-3 天**（含测试：fake server 崩溃 → 标 unavailable → 下次调用自愈）
- 路线图衔接：正对"包 2"四项中的三项，熔断项建议按 kimi 哲学改文案为"调用重试/重连封顶一次"

---

## 二、Skill（工具化 Skill）

### 1. kimi-code 怎么做的

Skill 全文**不进** system prompt。system prompt 只注入**清单**（name + 截 250 字 description + whenToUse + path，按来源分组，开头 `DISREGARD any earlier skill listings`，`app/skillCatalog/registry.ts:117-127`），且仅当 Skill 工具激活时才渲染该 section（`app/agentProfileCatalog/profile-shared.ts:92-93,113-114`）。Skill 工具描述用 "BLOCKING REQUIREMENT" 强制模型：清单命中必须调工具（`agent/tools/skill/skill.md:1`）。调用后 `executeModelSkill` 查目录、过门控（嵌套深度上限 3、`disableModelInvocation`），做 `$NAME/$1/$ARGUMENTS` 参数展开（`app/skillCatalog/registry.ts:147-185`），包成 `<kimi-skill-loaded>` 块（`agent/skill/prompt.ts:38-44`），以 `delivery: { kind: 'steer' }` 随工具结果返回；prompt 服务在 `onDidExecuteTool` 钩子里把 steer 消息**作为 user 消息注入当前 turn**（`agent/prompt/promptService.ts:251-255` + `agent/tools/skill/skillTool.ts:130-153`）。复用不靠代码去重，靠 skill.md 纪律：对话中已有同 name 同 args 的块则直接遵循。

关键证据：

- 清单组装：`agent/profile/profileService.ts:905-912`（`resolveSkillListing`）
- 参数展开：先 tokenize（支持引号分组）再按优先级替换 `$ARGUMENTS[i]`/`$N`/`$ARGUMENTS`，值经 XML 转义防注入；无占位符时追加 `ARGUMENTS:` 行兜底（`registry.ts:147-185,250-285`）
- 嵌套深度 `MAX_SKILL_QUERY_DEPTH=3`（`agent/tools/skill/skill.ts:19`）——但诚实记录：`withInitialQueryDepth` 在 v2 生产代码无调用方（仅测试命中），深度保护机制就位未接线
- 工具/ agent 层职责切分：工具只声明 `delivery: 'steer'`，注入由 prompt 服务完成（`skillTool.ts:6-11` 头注释）；`executeModelSkill` 是显式传参的独立导出函数（`skillTool.ts:90-96`），可无 DI 单测

设计亮点：

- **清单/正文两段式加载**：上下文成本从 O(全部技能全文) 降到 O(清单) + O(命中技能)
- **steer 语义**：工具结果可携带"注入当前对话的 user 消息"，是工具化 skill 的关键基础设施（`tool/toolContract.ts:26-38`）
- **placeholder 兜底**：args 永不静默丢失（`registry.ts:181-183`）
- **工具描述即纪律文档**：复用规则、args 语义都写在模型可见处而非代码注释

### 2. 架构耦合度

**评级：可搬（机制核心全是纯函数/薄壳；steer 语义需 CMZ 自建，是唯一"伤筋"点但不大）。**

- 直接搬：`app/skillCatalog/registry.ts`（catalog + 参数展开 + 清单渲染）、`parser.ts`（frontmatter 解析）、`fileSkillDiscovery.ts`、`agent/skill/prompt.ts`（块渲染）、`skill.md`（纯文本）
- 小改可搬：`executeModelSkill`（接口换成具体类/回调；DI 壳丢弃，bootstrap 手工 new）；清单注入就是"拼 system prompt 时调一次 `getModelSkillListing()`"
- 弃置：`skillService.ts`（wire.dispatch/telemetry/Turn）、`skillOps.ts`、DI 注册壳
- **CMZ 必须自建**：steer 语义——在 ReActLoop 工具结果处理处加 `delivery` 分支，把消息 append 进当前 turn 上下文后再继续推理（约等于工具返回类型加一个可选字段）

### 3. CMZ 对比

已有：SKILL.md 三来源加载（内置 / `DATA_DIR/skills` / agent 私有），**全文注入 system prompt**（`services/engine/src/skills/loader.ts`，bootstrap `resolveAgentSkillPrompts`）。
缺：清单/正文两段式、Skill 工具、参数化展开（`$ARGUMENTS` 等）、steer 注入、复用纪律、嵌套深度保护。

诚实评估痛点：CMZ 当前技能数量少时全量注入成本可控；工具化的价值随技能池增长（路线图"公共 Skill 池"）而陡增——**这是面向技能池规模化的前置投资，不是当下 bug**。

### 4. 迁移建议

**形式：借鉴设计重写（分两期）+ 仅 prompt 措辞资产（可立即）。**

- 第一期（低成本，半天）：把 kimi 的清单纪律引入现有注入——system prompt 里 skill section 改为清单格式（name + 截断 description + whenToUse），全文注入暂保留；同步迁移 `SKILLS_SECTION_PROSE` 的来源优先级话术（Project > User > Extra > Built-in）
- 第二期（技能池落地前）：完整工具化
  - 搬 `registry.ts` 参数展开 + `prompt.ts` 块渲染为 `services/engine/src/skills/catalog.ts`
  - 新增 `Skill` 内置工具（`tools/builtin/skill.ts`），描述迁移 skill.md 三条纪律
  - ReActLoop 工具结果类型加 `delivery?: { kind: "steer"; message }`，loop 处理处注入当前 turn
  - 嵌套深度用显式参数跨调用传递（kimi 的播种机制生产未接线，CMZ 直接做显式传递更可靠）
- 工作量：第一期 **0.5 天**；第二期 **3-4 天**（含 steer 改造与测试）
- 路线图衔接：排在"公共 Skill 池"之前或与同期；技能数量 <10 时不必急于第二期

---

## 三、子 Agent

### 1. kimi-code 怎么做的

LLM 调 `Agent` 工具 → `IAgentLifecycleService.create()` 在同进程创建**独立 DI 子作用域**（自带 wire journal、contextMemory、profile 绑定；注册表扁平，父子关系只记 labels）→ `runAgentTurn` 向子 agent 队列塞一条 user 消息驱动一个 turn，结束后从子上下文**蒸馏**最后一条 assistant 文本作为 summary 返回父 agent（中间内容不进父上下文）→ 运行句柄包成 `SubagentTask` 注册进 `AgentTaskService`：前台阻塞等结果，后台立即返回 task_id，完成时 taskService 把 `<notification>` XML 作为合成 user 消息经 loop 正规 step 准入（`activeOrNewTurn`：回合中折进下一 step，空闲自起新 turn）enqueue 给父 agent（`agent/task/taskService.ts:215-231,1096-1124`）。resume 复用 live 子 agent handle 再 enqueue 新 turn，保留全部历史。

关键证据：

- 上下文隔离：`createScopedChildHandle` 独立作用域 + 独立持久化根（`session/agentLifecycle/agentLifecycleService.ts:155-193`）；输入隔离=零上下文只收 prompt（`session/subagent/runAgentTurn.ts:34-37`）；输出隔离=只收蒸馏 summary（`runAgentTurn.ts:145-174`）
- ownership/并发校验（`agent/tools/agent/agentTool.ts:327-341`）
- taskService 状态机 `running → completed|failed|timed_out|killed|lost`（`agent/task/types.ts:1-16`）；重启后僵尸任务标 **lost** 而非 failed（`taskService.ts:940-955`）
- 输出双轨：内存 1MiB 环形缓冲 preview + 全量落盘 output.log 供 Read 翻页（`taskService.ts:1010-1028`）
- 通知三键幂等（building/scheduled/delivered + context 扫描兜底），跨 undo/compaction/重启不重不漏（`taskService.ts:1164-1168,1246-1250`）
- 诚实记录的 gap：跨重启 resume 子 agent 当前快照**无自动重物化路径**（resume 分支只 get 不 create，`agentTool.ts:240-243`；session resume 只重建 main agent）——CMZ 若抄应让 resume 在 get miss 时 fallback 到 create-by-id

设计亮点：

- **通知即 StepRequest**：后台完成通知走 loop 正规准入而非 hack 注入，天然解决"回合中 vs 空闲"投递语义
- **agent_id / task_id 双命名空间分离**，且每次输出都教育 LLM 不混用（`agentTool.ts:530`）
- **蒸馏而非转发**：父上下文不被中间产物污染
- **lost 状态**：重启语义精确

### 2. 架构耦合度

**评级：伤筋动骨（核心状态机可搬，外围接线重写）。**

- 直接搬：`agent.md` 等 prompt 资产（零代码依赖）、`agent/task/types.ts`、`notificationXml.ts`、`subagent-task.ts`（~114 行）
- 适配后搬：`agent/task/persist.ts`（只依赖 2 个薄存储接口，CMZ DocumentStore 写 ~30 行适配器即可接住）；taskService 状态机精华（registerTask/settle/terminateWithGrace/输出双轨/lost，约 600 行核心可抽为普通类）
- 缠在底座上：`agentTool.ts`（17 个 DI 注入，`agentTool.ts:115-132`）、通知投递的 loop StepRequest、wire Ops 恢复、undo 对账、compaction 重提醒、`runAgentTurn.ts` 的 accessor.get 全套

### 3. CMZ 对比

已有：`dispatch_subagent` 工具前台/后台（`services/engine/src/subagent/dispatcher.ts` + `background.ts`），经 AgentWorker 队列保持串行；批量骨架 `subagent/batch.ts` 已存在未接入（并发 worker 池 + retry，42 行）。
缺：委派纪律 prompt（现有工具描述简陋）、resume 机制、任务状态持久化（重启即蒸发，无 lost 语义）、完成通知注入父会话、输出落盘可翻页、ownership 校验。

### 4. 迁移建议

**形式：仅 prompt 措辞资产（立即）+ 借鉴设计重写（分批，按痛点驱动）。**

- 立即（半天）：迁移 `agent.md` 委派纪律四条（当同事简报 / 查找给路径 / 调查给问题 / 不委派理解）与反委派纪律（琐事不委派、不并行重做子 agent 工作、不中途抛弃），改写进 `dispatch_subagent` 的工具描述与 `services/engine/src/subagent/` 的 prompt；后台纪律（禁止启动后立刻等）同步迁移
- 第二批（痛点=重启任务蒸发，2-3 天）：background.ts 任务表接 DocumentStore 持久化，重启 reconcile 把 running 标 **lost**（借 kimi 语义，比 failed 精确）；输出落盘 + preview 双轨
- 第三批（按需，2-3 天）：resume 机制（`dispatch_subagent` 加 `resume` 参数复用会话上下文）+ 完成通知作为合成 user 消息注入父会话队列——CMZ 无 loop StepRequest 体系，简化为"向父会话消息队列 push 一条通知消息"
- 不搬：DI 子作用域体系（CMZ per-agent worker 注册表已是扁平等价物）、wire journal、undo/compaction 对账
- 路线图衔接：与"subagent batch 接入"共用同一任务注册表；通知注入依赖父会话队列语义，建议与群聊消息通道复用

---

## 四、Swarm

### 1. kimi-code 怎么做的

三层：工具层 `AgentSwarm`（`prompt_template` 含 `{{item}}` 占位符 + `items` 数组，硬校验 ≥2 items、prompt 去重、≤128）→ Agent 作用域模式层（swarm 模式 enter/exit，wire Model）→ Session 作用域并行协调层。整包展开成 `SessionSwarmTask[]` 交给 `SessionSwarmService.run`，内部由 **`AgentRunBatch` 纯调度器**（653 行，头注释自承"Pure scheduling logic"，经 `AgentRunBatchLauncher` 四方法接口与底座完全解耦，`session/swarm/agentRunBatch.ts:6-8,69-74`）驱动：burst-then-throttle 启动（先连发 5 个，之后每 700ms 放一个，`:47,194-222`）；撞 provider 限流时任务 unshift 回队头**续跑而非重开**，进入容量衰减模式（每 2s 减 1 下限 1、3 分钟恢复 +1，`:405-490`）；最后一个任务不重排直接 failed（防无限排队）；部分失败不拖死整批，结果按下标原位聚合（`:520-526`）。工具层把结果渲染成 `<agent_swarm_result>` XML 一次性回给模型（`agent/tools/agent-swarm/agentSwarmTool.ts:288-319`）。

**批次排他 veto**：`AgentSwarmService` 注册 `onBeforeExecuteTool` 监听，统计整批 tool calls 中 AgentSwarm 数量——0 个放行；恰好 1 个且整批只有这 1 个放行；其余 veto 整批，拒绝文案直接教模型正确用法（`agent/swarm/swarmService.ts:55-73`）。机制是通用两阶段裁决器（即时裁决优先，approval 类副作用裁决冷阶段才发生，`agent/toolExecutor/beforeToolExecuteEvent.ts:5-23`）。

设计亮点：

- **调度器接口隔离**：653 行复杂调度零 DI 零 scope，可单测可直搬
- **限流自适应**：容量衰减/渐进恢复 + 限流任务续跑保留上下文
- **veto 复用通用裁决机制**而非特判，且与 agent-swarm.md 的"If AgentSwarm is called, that call must be the only tool call"文档纪律互为表里（文档先行，veto 兜底）
- **输入纪律全部前置**于任何 spawn 之前

### 2. 架构耦合度

**评级：可搬，但只搬"调度器 + prompt 资产"，服务层按底座重写（半伤筋动骨）。**

- 直接搬：`session/swarm/agentRunBatch.ts` 整文件（只需提供 `isProviderRateLimitError` 等价物 + 自己的 Launcher 实现——CMZ 刚做完的 ResilientLLMProvider 错误分类正好复用）、zod schema + 常量（`agent-swarm.ts`）、`renderSwarmResults` 等纯函数、三个 .md
- 需重写：`AgentSwarmTool`（7 个 DI 注入改构造参数，中等改造量）、`AgentSwarmService`（wire Model 换普通字段，veto 换工具调度前置检查函数，约半天）、`SessionSwarmService`（accessor.get 换显式传参）
- **前提条件**：① 子 agent 创建/跑 turn 原语（CMZ 有：dispatcher），② turn 结果蒸馏 summary（CMZ 有：runAgentCollect），③ AbortSignal 贯穿（CMZ 部分有）

### 3. CMZ 对比

已有：`subagent/batch.ts` 骨架（并发 worker 池 + retry，42 行，未接入）； dispatcher 单 subagent 前台/后台。
缺：模板 × items 扇出工具、限流自适应调度、burst 启动坡道、批次排他约束、结果 XML 聚合、resume 续跑。

### 4. 迁移建议

**形式：适配移植——用 `AgentRunBatch` 替换 `batch.ts` 的 worker 池内核，接入为 `dispatch_subagent_batch` 工具。**

- 落点：
  - `services/engine/src/subagent/agent-run-batch.ts`：直搬 kimi `agentRunBatch.ts`（改 `isProviderRateLimitError` 用 `provider/protocols/shared.ts` 的 429 判定；retry npm 包可换 20 行自实现退避）
  - 重写 `batch.ts`：保留 `SubagentBatch` 对外形状，内部委托 AgentRunBatch，Launcher 四回调接 dispatcher（spawn=新 dispatch，retry=同 input 重试，suspended=logger.warn）
  - 新增工具 `dispatch_subagent_batch`（或 `dispatch_subagent` 加 `items` 模式）：模板 + items 校验（≥2、去重、上限沿用 128 或调小到 16 匹配桌面场景）、结果 XML 渲染直搬
  - 批次排他：CMZ ReActLoop 目前顺序执行工具，天然满足"一响应一批"，无需 veto 机制，但 agent-swarm.md 的纪律文案要进工具描述
- 工作量：**2-3 天**（含限流场景的 fake provider 测试）
- 路线图衔接：正是"subagent batch（批量并发派发）骨架已存在未接入"的落地路径——不建议在 42 行骨架上续写调度逻辑（限流续跑、burst 坡道都是已踩过坑的硬逻辑），直接换核

---

## 五、总结表

| 功能 | 迁移形式 | 价值 | 工作量 | 建议优先级 |
|---|---|---|---|---|
| MCP（包 2 机制） | 适配移植 + tool-naming.ts 直搬 | 高（包 2 已排期，四件套直接覆盖 3/4 项） | 2-3 天 | **P0** |
| Skill 工具化 | 借鉴设计重写（两期）+ prompt 资产立即 | 中（面向技能池规模化的前置投资，当下无痛点） | 0.5 天（一期）/ 3-4 天（二期） | P2（一期可提前） |
| 子 Agent | 仅 prompt 措辞资产（立即）+ 借鉴设计重写（分批） | 高（prompt 资产半天见效；lost 语义/通知/resume 按痛点驱动） | 0.5 天（prompt）/ 各 2-3 天（机制） | **P0（prompt）/ P1（机制）** |
| Swarm | 适配移植（AgentRunBatch 换核 batch.ts） | 中高（批量派发落地路径，调度硬逻辑现成） | 2-3 天 | P1 |

**最推荐先迁：MCP 包 2 机制。** 理由：它是四者中唯一"已排期 + 有现成低耦合实现 + 正对三个计划项"的交集——`tool-naming.ts` 27 行零依赖当天可搬，自愈四件套（意外关闭监听 / 探活分流 / single-flight 重连 / 断线保注册）所处文件无 DI 可直接手工 new，且 CMZ 刚完成的 ResilientLLMProvider 错误分类可直接复用于调用侧重试判定，价值/工作量比最高。

**零成本搭车项**：kimi 的三份纪律 prompt（`agent.md` 委派纪律、`skill.md` 复用纪律、`agent-swarm.md` 批次纪律）是纯文本资产，与代码零耦合，建议无论机制迁移排期如何都先吸收进 CMZ 对应工具的描述文案。
