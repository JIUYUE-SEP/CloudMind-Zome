# CloudMind-Zome 模块功能完善性审计报告

> 审计日期：2026-08-13
> 审计方式：14 路并行子代理逐模块代码审计（每条结论带 文件:行号 证据）+ 主控一手复核（git 历史追溯、全仓库 grep、逐行验证关键结论）
> 对照基准：README.md、docs/路线图.md（2026-08-11 版）、docs/API.md 的宣称功能
> 审计对象：services/engine（145 个源文件）、apps/web、apps/desktop（Tauri）、crates/zome-sidecar（Rust）、packages/shared

---

## 一、验证基线（真实运行结果）

| 验证项 | 结果 |
|--------|------|
| engine typecheck（tsc --noEmit） | ✅ 通过 |
| web typecheck（nuxt typecheck） | ✅ 通过 |
| engine 测试（vitest，threads 池） | ✅ **128 文件 / 1200 用例全部通过**（111s） |
| web 测试（vitest） | ✅ **26 文件 / 168 用例全部通过** |
| sidecar cargo test | ✅ **lib 5 + grpc 5 + migrate 3 + supervisor 1 + tokenizer 2 = 16 用例全过** |
| 默认 forks 池下的 19 例失败 | ⚠️ 已证伪为**沙箱环境限制**（子进程 spawn EPERM），threads 池下 140/140 全过，非代码缺陷 |

---

## 二、核心结论摘要

| 等级 | 数量 | 说明 |
|------|------|------|
| 🔴 Critical | **1** | 生产环境功能完全不可用（3 个内置工具 100% 失效） |
| 🟠 High | **10** | 数据安全风险 / 功能主要缺陷 / 恢复闭环断裂 |
| 🟡 Medium | **约 30** | 边界健壮性 / 容量治理 / 接线缺口 / 一致性 |
| 🔵 Low/Info | **约 40** | 死代码 / 代码质量 / 文档注释漂移 |
| 📄 文档漂移 | **8 处** | 文档宣称与真实代码不符 |

**总体判断**：这是一个完成度高、工程纪律严格的项目（双模型实现+审计流程、测试 1200+ 全绿、文档可追溯）。主要问题集中在**三类**：
1. **回归缺口**——大重构（移除 code 模式）后测试矩阵未覆盖生产装配链路，3 个工具被静默打断；
2. **接线类缺陷**——"实现了但没接上"（L2 层无生产者、actions.jsonl 无写入方、image-gen 死接线、updateModel 死代码）；
3. **容量与超时治理缺失**——intermind 会话/向量索引/去重状态无界增长，多处"超时只 resolve 不 abort"。

---

## 三、Critical 级缺陷（1 个，必须立即修复）

### C1. 三个核心工具生产环境 100% 失效：`edit_file` / `run_command` / `list_files`

**证据链（git 铁证确认）**：
- commit `5d08992`（移除 chat/code 双模式）删除了 `agent-worker.ts` 中 `projectRoot: job.projectRoot` 的注入，但**未同步修改三个仍强制要求 `ctx.projectRoot` 的工具**：
  - `services/engine/src/tools/builtin/edit_file.ts:36-39`
  - `services/engine/src/tools/builtin/run_command.ts:97-99`
  - `services/engine/src/tools/builtin/list_files.ts:25-27`
  - 三处均为 `if (!projectRoot) return { success: false, error: "No project root configured" }`
- 全部生产装配点只注入 `workspaceDir`、不注入 `projectRoot`：
  - `core/agent-worker.ts:726-759`（主链路）、`subagent/puppet.ts:146-160`（傀儡）、`blueprint/engine.ts:209-214`（蓝图）
  - `core/react/tool-call.ts:81` 只是透传（恒为 undefined）
- 对照：`read.ts:10` 有 `ctx.projectRoot ?? ctx.workspaceDir` 兜底所以正常；`write.ts`、`bash.ts` 走独立路径也正常
- **为什么 1200 个测试全绿没发现**：单元测试直接构造 ToolContext 并显式传了 projectRoot（如 `tests/tools/list_files.test.ts:10-15`），**没有任何集成测试走"agent-worker → tool-call → 工具"生产链路**

**影响**：README 宣称的 13 个内置工具中 3 个（含两个核心代码协作工具）在真实运行时必然报 "No project root configured"。run_command 是"任意命令执行"主工具、list_files 是唯一免审批目录浏览工具、edit_file 是核心编辑工具。

**修复建议**：装配 toolCtx 时注入 `projectRoot`（如 `getAgentDir(agentId)`），或仿照 `read.ts` 给三工具加 workspaceDir 兜底；并补一条走生产链路的集成回归测试。

---

## 四、High 级缺陷（10 个）

| # | 模块 | 缺陷 | 证据 |
|---|------|------|------|
| H1 | 工具系统 | `actions.jsonl` 工具调用记录**无任何写入方**——`ActionRepository.append` 零调用，`GET /actions/:agentId` 恒空，与宣称"工具调用记录落库"矛盾 | `memory/repositories/action.ts:15-17`（全仓 grep 仅 bootstrap 注入 + REST 只读） |
| H2 | 配置/关停 | 优雅关停 `close` 阶段**无超时**：`app.close()` 等 WS 长连接可永久挂起，`exit(0)` 永不执行（10s 超时只保护 drain） | `shutdown.ts:26-51` + `bootstrap.ts:645-649` |
| H3 | 配置/密钥 | 主密钥文件**任何读取错误**（EACCES/EIO 等）都静默重新生成并覆盖旧文件 → 已加密的 apiKey 永久不可解密；token 文件同型问题 | `config/crypto.ts:18-38`、`config/auth-token.ts:12-18` |
| H4 | MCP | `mcp-servers.json` **单条坏配置拖垮全部**：整体 parse 失败按空配置处理，好配置全丢（"单 server 失败降级"不覆盖配置校验失败） | `tools/mcp/client-manager.ts:130-135` |
| H5 | MCP | `getTools()` 按 `status==='ok'` 过滤，与"断线保注册"宣称冲突——server 宕机期间 worker 重建（配置变更/重启）时其工具从注入列表消失 | `tools/mcp/client-manager.ts:275-277` |
| H6 | 算力平台 | **首个 per-model apiMode 覆盖热更新不生效**：`hasModelApiModeOverride` 只在 worker 创建时判定一次；`PUT /models` 不退役 worker → 创建时无覆盖的 provider 后续加第一个型号级 apiMode，进程存活期内静默不生效 | `bootstrap.ts:415-428` + `api/routes/compute.ts:469-539` |
| H7 | ReAct 核心 | `step.ts:140` 工具结果 `JSON.stringify` **无防御**：工具返回循环引用/BigInt 时整轮异常终止，已执行工具的结果全部丢失，击穿"单 call 隔离"承诺 | `core/react/step.ts:129-148` |
| H8 | Intermind | intermind 会话**永不归档/压缩**，`messages.jsonl` 无界增长，撞 100MB 读上限后私信功能整体不可用 | `intermind/service.ts:170-206` |
| H9 | 桌面/sidecar | supervisor **收编（adopted）的 engine 挂死后无法杀死**：`restart()` 的 shutdown 对 `child=None` 是空操作，新 engine 因 8848 被占 exit 2 → 永久 30s port_conflict 循环，恢复闭环断裂 | `crates/zome-sidecar/src/supervisor/mod.rs:116-124,293-323` |
| H10 | 桌面/sidecar | **sidecar 自身无重启机制**（engine 启动失败/gRPC 端口占用时整体退出，桌面端不恢复）；另 gRPC **无 embedding 长度校验**，空/异维首插永久钉死索引维度，且 gRPC 无鉴权 | `crates/zome-sidecar/src/main.rs:20,25-27`、`server.rs:19-35` |

---

## 五、Medium 级缺陷（按模块分组）

### 引擎核心（ReAct / Worker / 换班）
- **M1** 水位撞顶只在"预检 + tool_use 步后"判定，长文本/`max_tokens` 步超窗不产交接书（任务被截断即丢）— `turn.ts:601-668,677`
- **M2** `agent-worker.ts:333-340` pause/resume 死代码，且 resume 存在可破坏 FIFO 串行的并发隐患
- **M3** abort 在撞顶兜底阶段被吞，取消后换班链仍推进 — `turn.ts:691-727`
- **M4** 单步多工具无整轮总量上限（单条 20% 预算，一步 5 个工具可注入 100%）— `turn.ts:449-452`
- **M5** 空内容 stop 步静默结束回合，违反"绝不静默"承诺 — `turn.ts:580-597,670-677`
- **M6** 旧交接书（`[交接书]` system 消息）留在热存储经 L3 原样回放，无水位提醒同款过滤 — `turn.ts:722-725`

### 上下文管线
- **M7** **L2 @提及层是死输入**：`mentionDesc` 全仓仅 3 处引用（layers/pipeline），无任何生产者，生产恒为空
- **M8** ephemeral 宣称"跳过 L5 摘要与 L4"只实现一半：L5 摘要注入与 L4 检索仍对蓝图流量执行 — `agent-worker.ts:595-602,652-665`
- **M9** L4 检索每轮全量读热存储 + 全量 stat 压缩档，延迟随历史线性放大 — `memory/repositories/message.ts:124-129`
- **M10** 去重状态 `injectedBySource` 单会话 Set 无上限 + 一次性 session 挤占 64 槽 FIFO — `context/pipeline.ts:98,136-148`

### 记忆 / 心智
- **M11** 压缩档 markdown 半结构化：摘要正文若含 `## Messages Archived` 字样污染 msgIds 解析 → L4 排除失效、recall 取错档 — `memory/topic/store.ts:152,203`
- **M12** 经验沉淀先于归档：归档失败回滚后 MIND.md 留孤儿经验，重启重压缩可能重复沉淀 — `compression-task.ts:71-91`
- **M13** 压缩失败无进程内重试：LLM 长时间不可用 → 热存储无界增长 → 撞 100MB 上限 — `topic/queue.ts:13-19`
- **M14** 已压缩话题的向量永不删除，sidecar 索引无界增长 — `memory/indexer.ts`

### 工具 / MCP
- **M15** `bash.ts` 输出超 1MB 时 SIGKILL 但返回 `success: true`；spawn timeout 只杀直接子进程（孙进程残留/悬挂）— `bash.ts:47-53,75`
- **M16** `write.ts:46-54` projectRoot 分支一旦装配即绕过 files/ 子目录限制（当前靠"从不装配"幸免，隐性地雷）
- **M17** `edit_file` 无 PROTECTED_FILES 保护（与 write.ts 不对称）；`list_files` recursive 参数是桩（schema 公开但恒 not implemented）
- **M18** MCP 重试 at-least-once 重复副作用（已注释承认）；探活风暴无 single-flight 合并；`withTimeout` 定时器未清理；`listAllTools` 游标无上限防护 — `tools/mcp/wrapper.ts:107-137`、`client-manager.ts:44-62`
- **M19** MCP readOnlyHint 是第三方自报 hint（规范不可信），谎报 true 即免审批放行写操作 — `wrapper.ts:187-188`
- **M20** MCP task 化工具（taskSupport=required）调用必然失败，工具对 LLM 可见但每次报错 — `client-manager.ts:105-111`

### Plan / Subagent / Scheduler / 蓝图
- **M21** Plan `persist()` 无 try/catch：落盘失败时 step 永久 running，plan 卡死至重启 — `plan/manager.ts:47-58,117`
- **M22** Plan `/run` 无步骤硬超时，provider 流挂起 → plan 锁永久 409；断连中止依赖 `request.raw close` 时序脆弱，且中止后 in-flight step 标 failed 需人工 retry — `api/routes/plans.ts:102-119`
- **M23** swarm 限流模式**无退出条件**（一次 429 永久压制吞吐）+ 退避 3s×2^n 无封顶；`runTracked` 超时只 reject 不 abort 底层傀儡（烧 token），`AgentRunBatch.cleanup()` 不 abort 在途 attempt — `agent-run-batch.ts:148,457-471`、`background.ts:230-263`
- **M24** swarm 16 项批量 = **16 条终态通知风暴**（各触发 owner 感知回合）— `background.ts:260-261`、`notify.ts`
- **M25** 蓝图无结构校验：分支边/指向不存在节点的边被静默截断；`blueprint-workspace/<executionId>` 每次执行泄漏磁盘 — `blueprint/engine.ts:181-185,206-207`
- **M26** 蓝图 LLM 节点 30s 超时 resolve "(timeout)" 但不中止 worker job（orphan 回合继续烧 token）— `blueprint/engine.ts:117-122`（路线图自认欠账，属实）
- **M27** 定时任务失败无补偿/重试（nextRunAt 已推进，一次触发静默丢失）；非法 `nextRunAt` 静默永不执行；端点不校验 agent 存在（幽灵任务）— `scheduler/*`

### REST API
- **M28** 多个写端点缺失 body 直接 TypeError 500（blueprints.ts:17,63 / sessions.ts:17,46 / scheduler.ts:28 / config.ts:25 / compute.ts:283,454-481）；chat limit 无上限 clamp — `api/routes/*`
- **M29** `/docs`（Swagger）被 Bearer 鉴权保护，浏览器直开必 401，宣称"可用"名存实亡 — `api/server.ts:57-72`
- **M30** 群聊路由到已删除 agent 会重建幽灵数据目录；重复 @mention 不去重（同一 agent 重复入队回复）；WS 无 maxPayload、ready 后 chain 无上限 — `conductor/conductor.ts:16-22`
- **M31** 用户消息持久化失败仍继续入队：新消息不在 agent 上下文中（答非所问）— `api/ws/handler.ts:332-338`
- **M32** `PUT /agents/:id` 对不存在 agent 静默 upsert 创建；删除不存在资源一律 204（与 GET/PUT 的 404 口径不一致）
- **M33** POST /compute/providers 无重复 id 校验（落两条同 id 配置）；PUT 不校验 displayName 空串；test 端点无 apiKey 时 OpenAI SDK 构造抛错被误报 502 — `compute.ts:324-338,375,410`
- **M34** 审批审计仅落 stdout+内存环形缓冲，重启即清空，无跨重启留存 — `api/log-buffer.ts`
- **M35** 交接书全文经 `GET /handoff` REST 暴露（路线图自认欠账，属实）；`GET /subagents/background/:taskId/output` 无 owner 维度校验（持 token 可读任意任务输出）

### Intermind / 换班
- **M36** `read_private_messages` 无 before 分页、上限 200 条，"读完整来信"超长线程不成立；热存储-only 读取依赖"永不归档"事实 — `tools/builtin/read_private_messages.ts:9-20`
- **M37** `message.ts:26-29` before 游标边界 bug：`beforeIndex===0` 时返回全量（应空页）
- **M38** fused 终态未纳入闩锁分支（fused 后 currentChainId 不清除，新链沿用旧 chainId，代际区分力下降）；错误收尾路径（onJobDone/startResume）绕过 registry — `handoff/resume-loop.ts:91-107,191-197,258-270`
- **M39** 无私信频率限制/配额：任一 agent 可无限写信，每封触发接收方一轮完整感知回合（LLM 成本）— `send_private_message.ts:30-57`
- **M40** 搭车通知以 `role:user` 混入接收方主会话历史，模型可能误判为用户消息 — `intermind/service.ts:154-165`

### 前端（web）
- **M41** `hub.vue` 群聊连接**卸载后迟到建连泄漏**（sessions/[id].vue 有 alive 防护而 hub 没有），配合永不放弃的重连形成常驻连接 — `hub.vue:149-184`
- **M42** **scheduler / blueprints / settings 三页面无导航入口**（布局"行动中心/自动委托/广播站"均为 `to:""` 占位），只能手输 URL 到达 — `layouts/default.vue:44-50`
- **M43** 4401 token 失效后连接不自动重建（终端码不重连），界面停在"未连接"需手动恢复 — `useEngineClient.ts:666-672`
- **M44** 私聊/群聊历史固定最新 100 条无"加载更早"（engine 的 before 参数未暴露）；审批"超时"无前端计时器，断线时卡片永远 pending — `stores/chat.ts:41`、`utils/approval.ts:75-84`
- **M45** `updateModel` 死代码、型号级 apiMode 覆盖无 UI（"apiMode 三族"只覆盖 provider 级）；群聊会话无删除/重命名 UI（store 方法死代码）— `stores/compute.ts:58-62`、`sessions/index.vue`

### 桌面 / sidecar
- **M46** 打包链脱节：`prepare-sidecar.mjs` 未接入 `beforeBuildCommand`，仓库提交的 sidecar 二进制新鲜度不可验证 — `tauri.conf.json`
- **M47** `delete_agent` 与在飞 upsert 竞态（代码注释自认未根治，被删 agent 向量可复活）；HNSW 孤儿点会话内无界累积（compaction 仅启动时触发）— `vector/mod.rs:263-271,288-316`
- **M48** Sandbox 骨架死代码（无调用点）+ ring/base64 未用依赖；CountTokens RPC 无客户端调用（死 RPC）；`load_state` 读失败静默当空索引（记忆表现为消失无告警）

### 配置 / 关停（补充）
- **M49** `encrypt` 生成并前拼 16 字节 salt 但解密端直接跳过——salt 从未参与 KDF，纯死数据且误导 — `crypto.ts:54-74`
- **M50** drain 与停止接收新任务的顺序颠倒：scheduler.stop() 在 drain 之后执行，drain 期间新压缩段被静默丢弃（启动对账兜底）— `bootstrap.ts:641-651`
- **M51** `ZOME_LOG_LEVEL` 无合法值校验，pino 对未知 level 在 import 时直接抛错致启动失败；EADDRINUSE 路径 process.exit(2) 可能截断 pino 未刷盘日志

---

## 六、文档漂移清单（宣称 vs 真实代码）

| 漂移项 | 事实 |
|--------|------|
| 路线图声称用例数 engine 1204 / web 171 | 实测 **1200 / 168**（计入 smoke 也仅 1206，无法复现 1204） |
| 路线图「handoffMaxShifts 缺省 3 clamp 1-10」 | 代码/README/shared 均为 **5**（`handoff/types.ts:6`） |
| API.md「POST /compute/providers 重复 id 返回 400」 | 代码**无任何重复校验**，直接 push（`compute.ts:324-338`） |
| API.md/README 完全未记载鉴权 | 全部 REST（含 /docs）要求 Bearer token，浏览器直开 Swagger 必 401 |
| protocol.ts 注释「NO_REMEMBER_TOOLS 四工具」 | 实际 **5 个**（漏 `dispatch_subagent_batch`）；路线图.md:28 同漏 |
| 路线图「L2 @提及」分层 | 管线有实现但无生产者，生产恒为空 |
| 路线图「ephemeral 跳过 L5/L4」 | 只跳过写入侧，注入侧仍执行 |
| 路线图「断线保注册工具不消失」 | worker 重建场景工具消失（H5） |
| 路线图「PUT 后下一次调用即走新协议」 | 首个型号级覆盖不生效（H6） |
| 路线图「工具调用记录（actions.jsonl）」 | actions.jsonl 无任何写入方（H1） |

**加分项**：路线图"二期欠账清单"10 项经逐一验证**全部属实**（ephemeral 技能收集污染、蓝图超时不 abort、交接书 REST 全文暴露、output.log 无 owner 维度、SSRF 不做 DNS 解析等）——文档对自身缺陷的披露诚实可追溯。

---

## 七、模块级完善度评价（14 模块）

| 模块 | 宣称验证 | 完善度 | 亮点 | 主要缺口 |
|------|---------|--------|------|---------|
| ReAct 核心循环 | 9/10 ok | ⭐⭐⭐⭐⭐ | step 级落库、水位双口径、交接书四件套、chainId 多层闩锁 | JSON 序列化无防御（H7）、水位不覆盖非工具步 |
| 上下文管线 | 6/7 ok | ⭐⭐⭐⭐ | 增量 token 计数、降级循环、多轮去重 | L2 死输入（M7）、ephemeral 注入未跳过（M8） |
| 记忆与心智 | 8/8 ok | ⭐⭐⭐⭐⭐ | 原子写+写队列、启动对账、注入防御纵深 | 压缩档解析污染（M11）、向量不删（M14） |
| 内置工具 | 7/8 ok | ⭐⭐⭐（有 C1） | 审批纵深、路径双重防穿越 | **C1 三工具失效**、actions.jsonl 空壳 |
| MCP 接入 | 6/7 ok | ⭐⭐⭐⭐ | 自愈/single-flight/断线保注册、45 测试全过 | 单条坏配置拖垮全部（H4）、getTools 过滤（H5） |
| Plan/Subagent/Scheduler/蓝图 | 8/10 ok | ⭐⭐⭐⭐ | fail-closed 纵深、输出双轨、错误节流 | persist 无兜底（M21）、swarm 限流无退出（M23） |
| 算力平台 | 7/9 ok | ⭐⭐⭐⭐ | 三协议族、AES-GCM、SSRF IPv6 归一化 | 首个 apiMode 覆盖不生效（H6）、salt 死数据 |
| REST API | 7/10 ok | ⭐⭐⭐⭐ | 统一鉴权、级联清理、分页 clamp | 缺 body 防护（M28）、/docs 不可用（M29） |
| WebSocket 层 | 7/8 ok | ⭐⭐⭐⭐ | 子协议 token、免问名单单源、仲裁面 | 幽灵目录（M30）、审计不落盘（M34） |
| Intermind/换班 | 6/7 ok | ⭐⭐⭐⭐ | 状态机/闩锁/仲裁面、防环三防线 | 会话无界增长（H8）、读不全（M36） |
| 配置/鉴权/sidecar 客户端 | 5/7 ok | ⭐⭐⭐⭐ | 解密失败阻断保存、exit 2 契约 | 主密钥覆盖（H3）、关停无超时（H2） |
| Web 前端 | 7/9 ok | ⭐⭐⭐⭐ | token 三失效点收敛、代际计数防脏写 | 三页面孤岛（M42）、连接泄漏（M41） |
| 桌面/Rust sidecar | 7/8 ok | ⭐⭐⭐⭐ | 数据目录单一权威、收编不误杀 | 收编恢复断裂（H9）、无自重启（H10） |
| 测试与文档 | 4/6 ok | ⭐⭐⭐⭐ | 真实进程级集成测试、文档可追溯 | 用例数漂移、鉴权未记载 |

---

## 八、修复优先级路线图

### P0（立即）
1. **C1** — projectRoot 装配回归：三工具修复 + 补"走生产链路"的集成回归测试（防止同类回归）
2. **H3** — 主密钥/token 文件仅在 ENOENT 时重建，其余读取错误显式报错；密钥内容校验（32 字节）
3. **H2** — 关停 close 阶段加超时 + 先停 scheduler/WS 再 drain

### P1（尽快）
4. **H6** — 型号级 apiMode 热更新：模型 PUT/DELETE 时退役引用 worker，或 Router 每次按活配置重判
5. **H4/H5** — MCP 逐条 safeParse 配置 + getTools 去掉 status 过滤
6. **H1** — actions.jsonl 写入接线（runToolCallBatch 落记录）
7. **H7** — 工具结果安全序列化（try/catch + BigInt/循环引用兜底）
8. **H8** — intermind 会话容量治理（按条数归档 + 读取走 listBySessionWithArchived）

### P2（后续批次）
9. H9/H10（supervisor 收编击杀 + sidecar 自重启 + gRPC 维度校验）
10. M 级按模块分批：上下文（M7/M8）、工具（M15-M17）、swarm（M23/M24）、REST（M28/M33）、前端（M41-M45）

### 横切项
- 建立"生产装配链路"集成测试（agent-worker→tool-call→工具 全链），杜绝 C1 类回归
- 文档同步：修正路线图用例数/缺省值/工具数，API.md 补鉴权章节

---

## 九、附录：验证方法与命令

```bash
# 类型检查
pnpm --filter @mindcloud/engine typecheck
pnpm --filter @mindcloud/web typecheck

# 测试（沙箱环境需 threads 池；CI/正常环境默认 forks 池即可）
pnpm --filter @mindcloud/engine exec vitest run --config vitest.config.ts --pool=threads
pnpm --filter @mindcloud/web test -- --pool=threads
cargo test --manifest-path crates/zome-sidecar/Cargo.toml

# 关键缺陷复现线索
# C1: grep -rn "projectRoot" services/engine/src  （无生产装配点赋值）
# H1: grep -rn "ActionRepository" services/engine/src （append 无调用方）
# H6: grep -rn "retireWorkersUsingProvider" services/engine/src/api/routes/compute.ts （仅 provider 级 PUT/DELETE）
```

**被审计范围**：services/engine/src 全部 145 个文件、apps/web 全部页面/store/composable/组件、apps/desktop/src-tauri（Rust）、crates/zome-sidecar（Rust，含 proto/tests/benches）、packages/shared、docs/（API.md/路线图.md/README.md）、tests/（e2e）、.github/workflows/ci.yml。

---

*报告生成：2026-08-13。所有结论基于真实代码，关键发现均经主控二次复核（git log -S / 全仓 grep / 逐行阅读）。*
