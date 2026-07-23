# CMZ 全面 Review —— 第 2 块：架构完整度

> 日期：2026-07-23 | 基线：main @ 1768e96（工作树干净）
> 基线文档：`docs/架构文档.md`（v2.1）、`README.md`、`docs/design/context-pipeline-v2.md` 模块划分节
> 方法：6 个审查域并行源码探索（全部结论带 `文件:行号` 证据）+ 构建实测（`pnpm typecheck`、`pnpm --filter @mindcloud/engine test`）
> 纪律：只 review 未改任何代码。

## 总览

| 审查域 | Blocker | Major | Minor | 一句话结论 |
|---|---|---|---|---|
| 1. 四端架构边界 | 0 | 0 | 6 | 边界干净：零 import 穿越、零循环依赖 |
| 2. 协议一致性 | 0 | 3 | 3 | WS/REST 契约两端手写，已发生 3 处实际漂移 |
| 3. 进程模型与 Worker 生命周期 | 0 | 3 | 2 | 拉起链达标；worker 失效机制有确定性卡死 |
| 4. 错误处理与可观测性 | 0 | 3 | 4 | 降级意识到位；业务日志与 LogPanel 管道脱节 |
| 5. 数据流完整性 | 0 | 4 | 3 | 主链路扎实；异常路径 `turn.end` 缺失致 UI 死态；WS 断线缺口仍在 |
| 6. 技术债扫描 | 0 | 0 | 3 | 水位极低：0 TODO、2 处合理 any、3 个 500+ 行文件 |
| 7. 构建与测试基建 | — | — | — | 全绿：typecheck 4/4，engine 527/527 测试通过 |
| **合计** | **0** | **13** | **21** | |

---

## 1. 四端架构边界与依赖方向

### 现状评估

四端边界整体干净，符合架构文档 §3.2 约定：依赖图为 `desktop → web → shared`、`engine → shared`，sidecar（Rust）独立于 pnpm 包图。运行时链路 web →(REST/WS)→ engine →(gRPC)→ sidecar，desktop 仅通过 `externalBin` 拉起 sidecar 并轮询 `/health`（`apps/desktop/src-tauri/src/sidecar.rs:63-64`），engine 由 sidecar supervisor 拉起（`crates/zome-sidecar/src/supervisor/mod.rs:74-91`）。**未发现任何 import 穿越**：`apps/` 对 `services/engine` 的引用仅 2 处注释（`apps/web/utils/approval.ts:41`、`apps/web/components/agent-edit/AgentEditor.vue:62`），engine 反向引用也仅 1 处注释。`packages/shared` 非形同虚设——engine 31 个源文件 + web 13 个文件引用，但全部为 `import type`（`packages/shared/src/index.ts` 仅 51 行 4 个类型）。sidecar 定位 engine 走 `ZOME_ENGINE_ENTRY` → 可执行文件邻近候选 → monorepo dev 路径三级解析（`supervisor/mod.rs:35-72`），无硬编码死路径。

### 问题清单

- **Minor — 跨端业务规则常量重复，靠注释人肉同步**：免询问名单 `NO_REMEMBER_TOOLS = ["run_command"]` 在 `apps/web/utils/approval.ts:43` 与 `services/engine/src/api/ws/validation.ts:43` 各存一份；Agent ID 校验正则同样在 `apps/web/components/agent-edit/AgentEditor.vue:63` 与 engine 侧重复。shared 只导出类型不导出常量，这类契约常量迟早漂移。
- **Minor — engine 地址硬编码分散在三端四处**：engine 支持 `PORT` 覆盖（`services/engine/src/bootstrap.ts:273`），但 `apps/desktop/src-tauri/src/sidecar.rs:64,79`、`apps/web/composables/useEngineClient.ts:152`、`crates/zome-sidecar/src/supervisor/mod.rs:104` 均写死 `127.0.0.1:8848`。一旦覆盖 PORT，desktop 健康等待、web 默认地址、sidecar 守护三处静默失效。
- **Minor — `pnpm-workspace.yaml:5` 含死 glob**：`crates/*` 与 `packages/skills` 无 `package.json`，虚报 workspace 成员。
- **Minor — `ensure-web-dist.mjs:10` 只查存在性不查新鲜度**：web 源码变更后 `tauri build` 可能打包过期前端产物。
- **Minor — desktop 三处版本号漂移**：`tauri.conf.json:3` 为 `2.0.0`，`Cargo.toml:3` 与 `package.json:3` 均为 `0.1.0`。
- **Minor — WS 帧契约未进 shared**：帧类型与 payload 在 web 端以裸字符串内联声明（详见第 2 节，此处不重复计级）。

### 小结

依赖方向正确、零穿越、零运行时循环，无架构级缺陷；存的都是"契约未收敛进 shared"与"硬编码/元数据分散"类 Minor。

---

## 2. 协议一致性

### 现状评估

`packages/shared` 只导出 4 个类型（`ChatMode`、`AgentConfig`、`ToolCall`、`ChatMessage`），web 实际只消费其中 2 个（`apps/web/composables/useEngineClient.ts:1`）。除此之外 **web↔engine 的全部 REST 请求/响应类型和全部 WS 帧类型都是两端各写一份**：REST 集中在 `useEngineClient.ts:5-115`（10 个手写 interface）；WS 帧 engine 侧只有 `LLMEvent` 有类型（`services/engine/src/provider/types.ts:3-46`），审批/模式切换帧连 engine 侧都是裸 object literal；web 侧 `JSON.parse` 后是 `any`，靠 switch 字符串字面量匹配。Swagger 已注册（`api/server.ts:44-58`）但 13 个 routes 文件 response schema 数为 0，无 codegen，纯文档用途。

### 问题清单

- **Major — WS 帧协议两端零共享，重命名/改字段编译期零保护**：web 侧 `useEngineClient.ts:439`（`JSON.parse` → any）+ `:440-465`、`:561-589`（switch 手写 `"text.delta"` 等字面量）+ `:121-143`（`WebSocketHandlers` 手工镜像帧字段）对 engine 的 `provider/types.ts:3-46`。这是演进最频繁的协议面，任何一侧改帧名都是运行时静默断流。
- **Major — 控制帧连 engine 侧都无类型，两端合计至少 3 份独立描述**：engine 裸 literal 见 `api/ws/handler.ts:94-100`（`tool.approval_request`）、`session-handler.ts:62-69`、`:147`（`session.mode_changed`）、`handler.ts:54,140`（`error`）；web 对应手写 `apps/web/utils/approval.ts:6-12`、`:34-38`、`stores/chat.ts:174`。没有"权威定义"可对照。
- **Major — REST 契约 8 组结构体两端重复定义，3 组已实际漂移**：
  - `ChatMessageRecord`：`memory/repositories/types.ts:3-11` vs `useEngineClient.ts:5-14` —— **已漂移**：engine 的 role 含 `"system"` 且有 `sessionId`，web 版皆无；
  - `ProviderConfig` vs `Provider`：`config/repository.ts:17-26` vs `useEngineClient.ts:27-35` —— **已漂移**：engine 多 `requestTimeout`/`maxRetries`，web 多 `hasApiKey`，连名字都不同；
  - `ScheduledTask`：`scheduler/types.ts:4-15` vs `useEngineClient.ts:61-72` —— **已漂移**：engine `createdAt/updatedAt` 必填，web 标为可选；
  - 当前一致但仍属重复：`Session`（`conductor/types.ts:3-12` vs `useEngineClient.ts:74-83`）、`ModelInfo`（`repository.ts:6-15` vs `:16-25`）、`MemorySettings`（`repository.ts:28-38` vs `:37-47`）、`Blueprint` 系列 4 个 interface（`blueprint/types.ts:3-33` vs `:85-115`）、`BufferedLogEntry`（`api/log-buffer.ts:4-8` vs `:55-59`）。
  漂移不是假设风险而是既成事实；目前方向无害，随迭代必然出现有害方向的漂移。
- **Minor — `ToolInfo` engine 侧无类型，响应硬编码字面量**：`api/routes/config.ts:41-45`（`safeToParallel: true` 写死）vs web `useEngineClient.ts:49-53`。
- **Minor — 审批安全名单两端重复实现**：`validation.ts:43-47` vs `approval.ts:43-47`；engine 是最终执行者，漂移方向失败安全，故 Minor。
- **Minor — Swagger 不承载类型信息且无生成链路（确认项）**：全部 routes 无 response schema，各 `package.json` 无 codegen 依赖；它同时也是修复上两个 Major 最顺手的抓手。

另注：`routes/plans.ts`、`routes/subagents.ts` 在 web 端无对应封装，属未消费端点，当前无漂移面。

### 小结

shared 只覆盖协议面冰山一角；WS 帧与 REST 契约实质是"两端手写、注释同步、已现 3 处漂移"。建议把 WS 帧 union 与 REST DTO 迁入 `packages/shared`（或补 response schema 后上 codegen）作为专项整改。

---

## 3. 进程模型与 Worker 生命周期

### 现状评估

拉起链实现质量尚可：Tauri `setup` 异步拉起 sidecar 并轮询 `/health` 30s（`apps/desktop/src-tauri/src/main.rs:12-20`、`sidecar.rs:63-88`）；sidecar 启动先探测已有健康 engine 直接收编避免端口冲突（`supervisor/mod.rs:74-79`），随后 30s 启动宽限 + 5s 健康检查 + 3 次失败阈值 + 2^n 指数退避重启上限 5 次（`supervisor/mod.rs:109-170`）；关闭路径 Windows 按进程树强杀、级联停 engine（`sidecar.rs:90-110`、`crates/zome-sidecar/src/main.rs:14-22`、`supervisor/mod.rs:229-270`）。sidecar 缺席时 engine 降级与文档一致：统一降级 + warn 留痕 + 可用性翻转日志（`services/engine/src/sidecar/client.ts:79-113`、`memory/indexer.ts:36-72`）。

**此前发现的 agent.json 变更删建 worker 竞态，现状结论：部分缓解，未修复，且派生出一个确定性卡死（下述 P1）。**

### 问题清单

- **Major（P1）— 私聊 WS 连接缓存 worker 引用，配置变更后消息确定性"已存不回"**：私聊 handler 每连接只取一次 worker 并固化（`api/ws/handler.ts:71-77`），之后每条消息 `agentWorker.enqueue(...)`（`handler.ts:164`）；配置变更时 `onChange` 对旧 worker `pause()` 并从缓存删除（`bootstrap.ts:66-73`）；`pause()` 仅置状态（`core/agent-worker.ts:183-185`），`enqueue` 只在 `status === "idle"` 时触发 `processQueue`（`agent-worker.ts:148-157`），running job 结束后 `status === "paused"` 不再调度（`agent-worker.ts:366-369`）；`resume()`（`agent-worker.ts:187-190`）全仓无调用方。结果：用户开着聊天页编辑 Agent 配置后，该连接后续每条消息照常落盘（`handler.ts:152-158`）但入队到已 pause 的孤儿 worker，永远不被处理、无任何错误反馈，直到断线重连。对照：群聊（`session-handler.ts:196`）、scheduler（`scheduler/scheduler.ts:74`）、blueprint（`blueprint/engine.ts:92`）均每次现取 worker，不受影响。
- **Major（P2）— 配置变更与在途 Job 的竞态仍存在（部分缓解）**：链路 `PUT /agents/:id`（`api/routes/agents.ts:59`）→ `AgentRepository.save` 同步 `onChange`（`memory/repositories/agent.ts:99`）→ `bootstrap.ts:66-73` pause + delete。`pause()` 不中断 busy 中的 `runTurn`，旧 worker 继续跑完并 append 结果（`agent-worker.ts:328-336`），其间新消息经 `getOrCreateWorker` 重建新 worker 开跑（`bootstrap.ts:124-129`）。缓解点：文件写由 `writeQueues` 按路径串行（`memory/document-store.ts:8,44-54`），不损坏 `messages.jsonl`；并发窗口压到"最多一个在途 turn"。残留问题：(a) 两个 turn 并发期间消息逻辑顺序交错，违背 §4.1 FIFO 串行不变量；(b) 两个 worker 各持内存态 `TopicTracker`（`agent-worker.ts:99`），话题边界状态分叉；(c) 变更瞬间旧 worker 队列里已排队未执行的 job 永久孤儿——`runAgentCollect` 的 Promise 永不 settle（`bootstrap.ts:88-100`），subagent 前台调用挂起。
- **Major（P3）— supervisor 收编路径不注册 SUPERVISOR，被收编的 engine 崩溃后永不重启**：`spawn_node_engine` 发现已有健康 engine 直接 `return Ok(())`（`supervisor/mod.rs:74-79`）；`restart()` 对 `None` 静默无操作（`supervisor/mod.rs:196-204`）；健康循环 3 次失败后照常退避并空调用 `restart()`，空转 5 次后放弃（`supervisor/mod.rs:133-169`）。守护链在"孤儿收编"场景完全失效。
- **Minor — engine 初次启动失败无重试，UI 无感知**：30s 宽限内未健康则记 error 直接 return（`supervisor/mod.rs:115-128`）；`EADDRINUSE` 无专门处理（`bootstrap.ts:273,284-287`）；desktop `get_backend_url` 只返回 "backend not ready"（`apps/desktop/src-tauri/src/commands.rs:6-13`）。附带：`is_node_healthy` 对任何 8848 `/health` 返回 2xx 的服务都判健康并收编（`supervisor/mod.rs:102-107`）。
- **Minor — 重启熔断可被抖动绕过**：任何一次健康检查成功即 `restart_retries = 0`（`supervisor/mod.rs:136-139`），crash-looping 的 engine 会无限重启，与文档"最多 5 次"表述不符。

### 小结

拉起链与降级路径达标，但"配置变更即弃 worker"的生命周期设计有硬伤：P1 确定性卡死、P2 竞态部分缓解、P3 收编路径重启失效，三者共同根因是 worker 失效/替换缺少"排空在途与排队 job、失效引用可感知"的协议。

---

## 4. 错误处理与可观测性

### 现状评估

engine 错误处理是"有意识的降级"风格：sidecar 调用（`sidecar/client.ts:92,109`）、向量索引（`memory/indexer.ts:47,69`）、压缩队列（`memory/topic/queue.ts:15-17`）、MIND 沉淀（`core/agent-worker.ts:125-127`）等旁路失败均有 warn 留痕。REST 错误契约统一为 `{ error }`（全路由 56 处），前端 `ensureOk`（`useEngineClient.ts:156-168`）按此解析；WS 错误帧两 handler 统一为 `{type:"error", error}`。结构性短板：**pino 只承载 Fastify 请求日志，全部业务日志走 console.\*（51 处/18 文件），LogPanel/GET /logs 看不到任何业务关键路径日志**；LLM 调用记录仓库是死代码。

### 问题清单

- **Major — 业务日志不进 pino，LogPanel 机制名存实亡**：`api/server.ts:30`（pino multistream 只接 Fastify logger）；`api/log-buffer.ts:38-40`（非 JSON 行直接丢弃，注释自认"裸 console 输出不入缓冲"）；全 engine `logger.`/`req.log` 零使用，`console.*` 51 处分布 18 个文件（`core/agent-worker.ts` 14 处、`scheduler/scheduler.ts` 4 处、`sidecar/client.ts` 3 处等）。压缩失败、sidecar 降级、调度失败等关键排障信息只留在 stdout。
- **Major — LLM 调用零记录，`LLMCallRepository` 是死代码**：`memory/repositories/llm-call.ts:15` 的 `append()` 全工程无调用方（仅 `bootstrap.ts:232` 注入 context）；`core/react/step.ts:44` 的 LLM 调用前后无日志无落档，唯一相关输出是 `provider/llm.ts:103` 的 parse 失败 console.error。模型/耗时/token/错误率零记录。
- **Major — 解密失败静默吞掉**：`config/repository.ts:65-69`（`decryptValue` catch 后 `return undefined`，无日志）；`config/repository.ts:98-100`（`load()` catch-all 静默返回默认配置）。master key 失效后所有 Provider apiKey 静默丢失，下游表现为毫无线索的 LLM 认证失败。
- **Minor — 无 Fastify 全局 error handler 与进程级兜底**：`api/server.ts:26-78` 无 `setErrorHandler`；全 engine `unhandledRejection|uncaughtException` 零匹配。路由未捕获异常返回形状与前端只解析 `body.error` 的契约不一致；Node 22 下 unhandled rejection 默认 crash 且无兜底日志。
- **Minor — agent-worker 生产路径残留调试级 console.log**：`core/agent-worker.ts:33`（模块加载即 log）、`:149,152,204,214,327,329`（每次 enqueue/turn 打 6+ 条），稀释 stdout 信噪比。
- **Minor — 私聊 WS 历史加载失败完全静默**：`api/ws/handler.ts:162`（`.catch(() => [])`，无日志无 error 帧），热存储故障时 agent 表现为"失忆"而无痕迹。
- **Minor — 前端无统一错误通知机制，WS 断线无自动重连**：错误呈现分散——聊天内嵌（`stores/chat.ts:114-126`）、store error ref（`stores/settings.ts:23-25`）、裸 `alert`（`pages/compute.vue:174`）；onClose 只置状态不重连（`stores/chat.ts:127-136`、`pages/hub.vue:213-216`）。前端多数空 catch 有注释和合理降级，不算吞错。

Rust 侧仅 3 处启动期 `expect`（`crates/zome-sidecar/src/main.rs:30,31,41`），属合理 fatal，无可指摘。

### 小结

降级设计意识到位，但可观测性有结构性断点：业务日志与 pino/LogPanel 管道脱节、LLM 调用零记录、配置解密静默失败——真实故障几乎无法从系统内部排查。

---

## 5. 数据流完整性

### 现状评估

链路主干（web 发送 → engine 落盘用户消息 → 入队 → runTurn → 按序持久化 → WS 回显）在顺利路径完整且顺序正确：用户消息先落盘再入队（`api/ws/handler.ts:152-164`），worker 按真实顺序持久化新增消息（`core/agent-worker.ts:334-336`），写盘有 tmp+rename 原子写与按文件串行队列（`memory/document-store.ts:70-104`）。**但所有异常路径的收尾都依赖 `turn.end`，而 `turn.end` 只在成功路径发出**（`core/react/turn.ts:101` 位于可能抛错的循环之后）。**此前标记的 WS 断线缺口确认仍存在，未修复。**

### 问题清单

- **Major — `turn.end` 不在异常路径发出，前端"生成中"永久卡死**：`executeLoopStep` 抛错时循环中断，`turn.ts:101` 的 `turn.end` 不执行；worker 兜底只补发一条 text.delta（`agent-worker.ts:356-358`），无 error 帧无 turn.end。前端 `isStreaming` 只在 onTurnEnd/onError/onClose 复位（`apps/web/stores/chat.ts:107-136`），socket 仍开着三者都不触发 → 输入框永久锁定（`components/ChatView.vue:25`）。群聊路径同样卡死（`composables/useGroupChatStream.ts:114-117`）。provider 报错、工具抛异常这两类最常见失败必然导致 UI 死态，只能刷新页面恢复。
- **Major — LLM 流式中断时部分生成内容不落盘不回放**：provider 出错先 yield "Provider error" delta 再 `throw`（`provider/llm.ts:109-112`）；`core/react/step.ts:44-66` 的 for-await 在 throw 处中断，已累积 textBuffer 不构造 assistantMessage → 无内容可持久化。前端已上屏的半截回复刷新后完全消失，落盘内容与用户所见不一致。
- **Major — 工具执行抛异常未兜底，审批卡片与工具状态悬挂**：`core/react/tool-call.ts:76` 的 `call.tool.execute()` 无 try/catch，异常经 `Promise.all` 上抛；该 toolCallId 的 `tool.result` 帧永不发出（对比：未知工具/参数校验失败/审批拒绝都有兜底 result，`tool-call.ts:36-39,48-52,63-66`），前端 `expireApprovalByToolCallId` 只在 onToolResult 触发（`stores/chat.ts:96-101`）→ 审批卡片永远停在"待审批"，叠加 turn.end 缺失整体卡死。同类失败分支都已有兜底，唯独 execute 没有。
- **Major — WS 断线缺口仍存在：帧只推当前连接，无缓冲无重放，前端无重连无补差**：`onEvent` 闭包只 `safeSend(socket)` 到建立连接时的那个 socket（`api/ws/handler.ts:168-172`、`session-handler.ts:213-217`），断线期间的流式帧全部静默丢失。web 三个入口（`stores/chat.ts:127-136`、`pages/sessions/[id].vue:96-99`、`pages/hub.vue:213-216`）的 onClose 均只置 `isConnected=false`，**全仓无任何 reconnect 逻辑**，也无重连后拉历史补差的代码。唯一缓解：已完成 turn 会落盘，手动刷新能找回最终回复。
- **Minor — 用户消息落盘失败被吞后仍继续入队**：`api/ws/handler.ts:152-158`（catch 只发 error 帧，流程继续 enqueue；群聊同，`session-handler.ts:171-177`）。结果：历史出现"有答无问"的残缺对话。
- **Minor — 任务队列纯内存，engine 重启丢在途/排队任务**：`core/agent-worker.ts:87-88`（`queue`/`runningJob` 均在内存），启动无队列重建逻辑。用户消息已在盘，回复无影无踪，也无"处理中断"标记。
- **Minor — 群聊 WS 消息处理不串行**：`session-handler.ts:91,101-103` 的 `void handleMessage(raw)` 并发触发；私聊用 `chain` 保证顺序（`handler.ts:49-56`），其注释自称"与 session-handler.ts 同一模式"，名不副实。快速连发时落盘顺序可能交错。

**未发现问题的环节**：审批超时收尾完整（超时 resolve(false) → "Approval denied" tool.result → turn.end 正常发出，`handler.ts:89-92`、`tool-call.ts:63-66`）；落盘原子写健全（tmp+rename+EPERM 重试 `document-store.ts:24-39`、`mutateLines` 读-改-写原子 `:111-117`、JSONL 坏行容忍 `:149-152`）；web 发送前校验 readyState 且失败不上屏（`stores/chat.ts:141-148`）。

### 小结

主链路"先落盘后入队、按序持久化、原子写"设计扎实；最大断点是异常收尾信号（turn.end）不保证必达，叠加 WS 断线丢帧缺口仍在。优先给 worker 兜底路径补发 turn.end（或 error 帧）并为工具 execute 加 try/catch。

---

## 6. 构建与测试基建（实测）

- `pnpm typecheck`：**退出码 0**，turbo 4/4 任务成功。
- `pnpm --filter @mindcloud/engine test`：**退出码 0**，71 个测试文件、527 个测试全部通过（耗时约 70s）。
- Windows 特定问题的系统性处理是到位的：`document-store.ts:24-39` 对 EPERM/EBUSY 做递增退避重试 5 次；desktop 关闭按进程树强杀防孤儿占端口（`sidecar.rs:90-110`）。
- 观察项（不计级）：engine 测试日志中出现一例 `ENOENT: ... rename '...scheduler.jsonl.tmp' -> '...scheduler.jsonl'`（scheduler 测试内，测试仍通过）。现有重试只覆盖 EPERM/EBUSY，不覆盖 rename 时 tmp 文件消失的 ENOENT（杀毒软件/索引器介入的典型特征），建议把 ENOENT 纳入重试条件观察。

---

## 7. 技术债清单（量化）

- **TODO/FIXME/HACK/XXX 注释：全仓源码 0 条**（apps/web、apps/desktop、services/engine、crates、packages 均为 0；仅 `docs/superpowers/plans/` 3 份历史计划文档各含 1 处字样，非源码债务）。
- **TypeScript `any`：全仓 2 处**，均有正当理由——`services/engine/src/sidecar/client.ts:67`（gRPC 动态加载 `as any`）、`apps/web/composables/useEngineClient.ts:180`（`(window as any).__TAURI__` 探测）。eslint：engine 侧 `no-explicit-any` 为 error（`services/engine/eslint.config.mjs:4`），web 与 shared 为 warn（`apps/web/eslint.config.js:27`、`packages/shared/eslint.config.js:14`）。
- **循环依赖：5 个模块级名义环，全部由 `import type` 切断，0 个运行时环**（api↔scheduler、api↔blueprint、core→scheduler→api→core、memory↔context、memory→context→mind→memory）。唯一值得记账：`context/semantic.ts:4`（运行时）与 `memory/topic/store.ts:6`（type）构成 context/memory 跨层双向引用，后续加运行时依赖时易退化为真环。
- **God-file（>500 行，全仓无 >800 行）**：
  - `apps/web/composables/useEngineClient.ts` — 662 行（单一 composable 承载全部 engine 通信，接近可维护性拐点）
  - `apps/web/pages/hub.vue` — 560 行
  - `apps/web/components/SystemSettingsPanel.vue` — 514 行
  - 对照：engine 侧最大 `core/agent-worker.ts` 372 行，Rust 侧最大 271 行，后端拆分健康。
- **Rust 侧**：TODO 0、`unwrap()` 0、`expect` 3 处（均在 `main.rs` 启动期，合理）。

---

## 架构健康度总评

**总体良好，偏上。** 分层边界、依赖方向、构建基建、工程纪律（0 TODO、2 处 any、零运行时环、测试全绿）都属于健康一档；架构文档与代码的一致性也高（本次抽查的设计描述均能在代码中坐实）。

扣分项高度集中在两个"系统性偏科"上：

1. **失败路径是架构的短板**：正常链路设计考究（原子写、串行队列、降级秩序），但异常收尾信号不保证必达（`turn.end` 只在成功路径发出）、worker 失效没有排空协议、supervisor 收编路径重启失效——三处 Major 都指向" happy path 优先、失败路径补丁化"的惯性。
2. **协议契约没有单一事实源**：WS 帧与 REST DTO 两端手写且已漂移 3 处，`packages/shared` 只承载了 4 个类型。四端架构的其他部分都收敛得很好，唯独最该收敛的契约面还在靠注释同步。

## 最值得还的 3 笔债

1. **异常路径收尾信号必达**（数据流域，4 个 Major 中占 3 个的直接诱因）：worker 兜底路径补发 `turn.end`/`error` 帧（`agent-worker.ts:356-358`、`core/react/turn.ts:101`），给 `tool-call.ts:76` 的 `execute()` 加 try/catch 兜底 `tool.result`。改动小、收益立竿见影——消除用户可感知的 UI 死态。
2. **Worker 失效协议**（进程模型域 P1+P2）：配置变更不再"pause 后弃置"，改为排空/转移在途与排队 job，或让失效 worker 的 `enqueue` 重定向到新实例；同时消掉私聊 handler 的连接级 worker 引用固化（`api/ws/handler.ts:71-77`）。一并解决确定性卡死与竞态残留。
3. **协议契约收敛进 `packages/shared`**（协议一致性域 P1–P3）：先把 WS 帧 union（含审批/模式切换控制帧）与已漂移的 3 组 REST DTO（`ChatMessageRecord`、`Provider`、`ScheduledTask`）迁入 shared，engine 与 web 共同引用；中期可给 routes 补 response schema 后上 codegen 一劳永逸。

次优候选（未进前三但值得排期）：业务日志接入 pino 管道 + 启用 `LLMCallRepository`（可观测性域，修复成本同样不高）；supervisor 收编路径注册 SUPERVISOR（`supervisor/mod.rs:74-79`）。
