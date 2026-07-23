# CMZ 全面 Review · 第 7 块：桌面端体验与可观测性

- 日期：2026-07-23
- 基线：main @ 1768e96
- 范围：apps/desktop（Tauri）、crates/zome-sidecar、apps/web 前端健壮性、services/engine 可观测性
- 说明：只 review 未改代码；所有结论均经代码核实，附文件:行号。

架构事实先明确：链路是三层 —— Tauri 桌面端 spawn `zome-sidecar`（gRPC :50051），sidecar 再 spawn node engine（HTTP/WS :8848）；前端（复用 apps/web 的 Nuxt 应用）直连 engine 的 8848。

---

## 一、桌面端与跨平台

### Blocker

**D-B1. engine 永久挂死：无恢复路径、无用户提示（即"Failed to fetch"事件的根因）**

两处永久放弃逻辑叠加：

- 启动 30s 宽限期内 engine 未健康，监控任务直接 `return`，此后**永不监控、永不重启**：`crates/zome-sidecar/src/supervisor/mod.rs:125-128`
- 运行中崩溃重启重试 5 次后 `break` 退出监控循环：`crates/zome-sidecar/src/supervisor/mod.rs:153-156`
- Tauri 侧监听 sidecar 退出只记一条 info 日志后 break，无重启、无事件、无对话框：`apps/desktop/src-tauri/src/sidecar.rs:51-57`；spawn 失败同样只 `tracing::error!`（release 下用户不可见）：`apps/desktop/src-tauri/src/main.rs:15-17`
- 前端唯一兜底是泛化文案"无法连接 engine，请检查 engine 是否运行"：`apps/web/utils/fetch.ts:20-22`

用户无法区分 engine 挂了、sidecar 挂了还是端口被占，只能重启应用。

**D-B2. sidecar 重启机制与前端无重连互相抵消**

即使 supervisor 在 5 次内成功重启 engine，前端 WS 断开后**没有任何重连逻辑**（裸 `new WebSocket`，onclose 仅透传：`apps/web/composables/useEngineClient.ts:429-473`，群聊连接 `:550-597` 同构；全仓 grep 无 reconnect）。engine 恢复后 UI 依然停在"未连接"，supervisor 的重启对用户不可见。两个子系统各自做了半截，合起来等于没做。

**D-B3. 打包产物缺 engine，桌面端实际不可分发**

- `tauri.conf.json:25-30` 只有 `externalBin: ["binaries/zome-sidecar"]`，**没有 `resources` 配置**，engine JS 不会进安装包；全 apps/desktop 无 `ZOME_ENGINE_ENTRY` 引用。
- 打包布局下 `engine_entry()` 在 sidecar exe 旁找 `engine/bootstrap.js`，找不到则 bail：`crates/zome-sidecar/src/supervisor/mod.rs:47-62, 69-71`。
- 即使补上 resources，sidecar spawn 用的是 `node`（`ZOME_NODE_PATH` 或 PATH）：`supervisor/mod.rs:26-28` —— 分发还要求用户机器装 Node，这与桌面应用的交付预期相悖。

### Major

**D-M1. WS 断线（含 1006）静默，无重连、无状态恢复**

- 私聊 onclose 仅置 `isConnected=false` 并 seal 流式气泡：`apps/web/stores/chat.ts:127-136`；群聊连提示都不 push：`apps/web/pages/hub.vue:213-216`、`apps/web/pages/sessions/[id].vue:96-99`。
- 1006 时唯一可见变化是头部"已连接"变"未连接"（`apps/web/components/ChatView.vue:47-49`）。
- 刷新后历史可拉回（最近 100 条），但进行态全部丢失：streaming 气泡被硬置 `isStreaming:false` 成静态半成品（`apps/web/composables/useChatRecords.ts:46`），工具徽章状态不恢复，无续传通道。

**D-M2. 断线即静默拒绝所有 pending 审批**

WS close 时 engine 把全部 pending 审批 `resolve(false)`：`services/engine/src/api/ws/handler.ts:104-110`（60s 超时同样视为拒绝：`:89-92`；群聊 `session-handler.ts:73-79` 同构）。前端审批卡片只存内存（`apps/web/utils/approval.ts:50-67`），刷新即消失。用户在审批决策中遇断线：工具被静默拒绝、卡片消失、无任何告知；"本会话不再询问"记忆（`autoApprovedTools`，`handler.ts:84`）也随连接丢弃。

**D-M3. desktop 异常退出时进程树残留**

kill 只挂在 `WindowEvent::CloseRequested`：`apps/desktop/src-tauri/src/main.rs:21-28`（Windows 上 `taskkill /T /F` 杀 sidecar 整树：`sidecar.rs:96-101`，实现本身正确）。但 Tauri 进程崩溃/被任务管理器强杀时 sidecar + engine 双孤儿，继续占 8848/50051。唯一缓解是下次启动时 sidecar "收养"健康 engine（`supervisor/mod.rs:75-78`）——副作用是旧版本 engine 可能被无限复用。engine 自身无 SIGTERM/SIGINT 处理器，完全依赖外部 taskkill。

**D-M4. 8848 被非 engine 进程占用 = 永久挂死**

engine 侧无任何 EADDRINUSE 处理，`listen` 失败直接 `process.exit(1)`：`services/engine/src/bootstrap.ts:273, 284-287`；随后进入 D-B1 的"宽限失败 → 永不监控"路径。desktop 侧端口硬编码 8848（`sidecar.rs:64, 79`、CSP `tauri.conf.json:22`、前端默认 `useEngineClient.ts:152`），而 engine 读 `PORT` 环境变量（`bootstrap.ts:273`）——设了 PORT 反而与 desktop 硬编码错位，静默失联。

**D-M5. engine 与 sidecar 数据目录不一致**

engine 用 `os.homedir()/.cloudmind-zome`：`services/engine/src/config/paths.ts:5`；Rust sidecar 用 `dirs::data_local_dir()/cloudmind-zome`：`crates/zome-sidecar/src/lib.rs:43-49`。Windows 上这是两个目录（`C:\Users\x\.cloudmind-zome` vs `C:\Users\x\AppData\Local\cloudmind-zome`），只有 `CLOUDMIND_DATA_DIR` 环境变量能对齐，而 sidecar spawn engine 时未注入该变量（`supervisor/mod.rs:81-85`，仅靠父进程环境继承，Tauri 侧也未设置）。sidecar 若按自己的 data_dir 读写（如加密密钥），两边数据分裂。

**D-M6. config 等关键文件非原子写，Windows 下可损坏**

`services/engine/src/config/repository.ts:120` 直接 `fs.writeFile` 整文件覆写 config，无 tmp+rename、无重试：写一半崩溃留截断 JSON，被杀毒/索引瞬时占用直接 EPERM。同类裸写还有 `tools/builtin/write.ts:76`、`tools/builtin/edit_file.ts:63`、`config/crypto.ts:25,29`。对照组：JSONL 落盘已有 `renameWithRetry`（EPERM/EBUSY/EACCES 退避重试 5 次，`memory/document-store.ts:24-39`）——好模式存在，但没铺到 config 链路。

**D-M7. run_command 输出在中文 Windows 上 GBK 乱码**

子进程输出 `stdout.toString("utf8")`：`services/engine/src/tools/builtin/run_command.ts:75`。中文系统 cmd 默认 GBK（CP936），中文输出全部乱码返回给模型；未设 `chcp 65001` 或注入编码环境变量。截断还在任意字节边界切 Buffer 再解码（`run_command.ts:82-83`），会产生 U+FFFD。`bash.ts:72-73` 同样。

### Minor

- **D-m1**：`document-store.ts:85` `fs.appendFile` 裸调用无重试，Windows 瞬时锁直接抛错，JSONL 仓库无兜底。
- **D-m2**：长路径（>260 字符）全项目零防御（无 `\\?\` 前缀、无 manifest longPathAware 验证）；workspace 深层嵌套 + 长用户名可触发，无解。
- **D-m3**：`tools/builtin/bash.ts` 白名单全是 POSIX 命令（`ls/cat/echo`，`bash.ts:6`），Windows cmd 下大半不可用；输出超限只 `child.kill("SIGKILL")` 杀壳不杀树（`bash.ts:64`），与 run_command 的 `killProcessTree`（`run_command.ts:51-66`，实现正确且有测试）不一致。
- **D-m4**：`memory/repositories/agent.ts:111` `fsp.rm(recursive)` 删 agent 目录无重试，句柄未释放时 EPERM/ENOTEMPTY。测试里为 scheduler 临时目录写过重试，生产代码没有。
- **D-m5**：UNC 路径、含空格/中文 cwd 无任何验证与测试覆盖；`project-paths.ts:7-17` 的盘符大小写归一是仅有的 Windows 特化（做得对）。
- **D-m6**：`bash.ts:22,32` 拒绝一切含 `/`、`\` 的参数，Windows 风格路径参数被误伤（功能受限但安全）。
- **D-m7**：`get_backend_url` 失败时前端静默回退默认 8848，不重试不提示：`apps/web/composables/useEngineClient.ts:184-193`。
- **D-m8**：开发模式 `start-tauri.bat` 手动起的 engine 不在 sidecar 进程树内，关窗不回收；`scripts/start-e2e.mjs:65-82` 杀 pnpm 壳留 node 孤儿，e2e 重复跑易端口冲突。
- **D-m9**：crypto 密钥保护两边不一致：Node 侧 `{ mode: 0o600 }` 在 Windows 基本无效（`config/crypto.ts:25,29`），Rust 侧反而做了 `FILE_ATTRIBUTE_HIDDEN` + readonly 特化。

### 启动链路失败模式表

| 环节 | 失败模式 | 用户现在看到什么 | 应该有什么 |
|---|---|---|---|
| sidecar 二进制准备 | 二进制缺失 | 构建期 exit 1 + 提示先 cargo build（`scripts/prepare-sidecar.mjs:26-32`），可接受 | 维持现状 |
| Tauri spawn sidecar | spawn 失败（二进制损坏/权限） | 仅 tracing 日志；UI 每个请求 10s 超时后"无法连接 engine" | 启动失败对话框：原因 + 日志位置 + 重试按钮 |
| sidecar spawn engine | entry 找不到（打包缺 engine，见 D-B3） | sidecar 退出；Tauri 等 30s 超时只记 error；UI 泛化报错 | 明确提示"engine 组件缺失/损坏" |
| 端口 8848 | 被其他进程占用 | engine 退出 → supervisor 永久放弃；UI 泛化报错（D-M4） | 检测占用者并提示"8848 被 X 占用"，或端口顺延 |
| engine 启动慢/崩溃循环 | 宽限 30s 失败或重启 5 次耗尽 | 无任何通知，永久挂死（D-B1） | 通知用户 + 提供"重启 engine"入口，监控永不退出 |
| 前端取 backend URL | `get_backend_url` 返回 not ready | 静默回退默认 8848（D-m7） | 加载页轮询等待 + 超时后显式报错 |
| engine 运行中崩溃 | supervisor 5 次内重启成功 | WS 断开不重连，UI 停在"未连接"（D-B2） | WS 自动重连 + 重连后拉取会话状态对齐 |
| engine 运行中崩溃 | 重启 5 次仍失败 | 同 D-B1：无提示永久挂死 | 对话框告知 + 日志导出入口 |

---

## 二、可观测性

### Blocker

**O-B1. 业务日志 52 处全部绕过日志缓冲，LogPanel 名存实亡**

基建是齐的：pino multistream（stdout + 内存环形缓冲，`services/engine/src/api/server.ts:28-32`）→ 环形缓冲（`api/log-buffer.ts`）→ `GET /logs`（`api/routes/logs.ts:8-15`）→ 前端 LogPanel 轮询。但缓冲流**只解析 JSON 行，非 JSON 直接丢弃**（`log-buffer.ts:31-40`，注释自证"启动期裸 console 输出不入缓冲"），而业务日志全是裸 `console.*`（52 处 / 18 文件），`app.log`/`request.log` 全代码库使用 0 次。结果：LogPanel 里只有 Fastify 请求日志，压缩、检索、worker、审批等业务事件一条都看不到。此前排查 WS 1006 全靠翻 engine 终端 stdout，根因在此。

**O-B2. desktop 场景日志完全没落盘，用户出问题无任何可提供的材料**

engine 只写 stdout；Tauri 侧把 sidecar 输出逐行转发给 tracing（`apps/desktop/src-tauri/src/sidecar.rs:42-49`），但 tracing 只有 `fmt::init()`（stdout），无 tauri-plugin-log、无文件输出（`apps/desktop/src-tauri/src/main.rs:7`）。desktop 用户机器上不存在任何日志文件；supervisor 的重启/放弃决策（`supervisor/mod.rs` 全程 tracing）同样随进程消失。叠加上面的 D-B1，崩溃后既无 UI 提示也无日志可查。

### Major

**O-M1. scheduler tick 错误每秒刷屏，无节流（此前刷屏案例根因未修）**

tick 默认每 1000ms 一次（`services/engine/src/scheduler/scheduler.ts:21-22`），`agentRepository.list()` 或 `repo.list()` 持续故障时 `console.error("scheduler tick failed")` 每秒一条无限刷（`scheduler.ts:51-52`），无节流无退避。次级风险：`scheduler.ts:46` 任务持续到期失败按 cron 频率刷；`memory/repositories/agent.ts:55,61,68` watcher 反复报错无节流；embedder 挂掉时每条消息一条 warn（`memory/indexer.ts:47`）。

**O-M2. 审批全链路零日志，安全敏感事件无审计痕迹**

审批请求发出、批准/拒绝/超时、remember 加入免询问名单——全链路无一条日志：`services/engine/src/api/ws/handler.ts:86-131`、`ws/session-handler.ts:53-119`、`core/agent-worker.ts:297-304`、`react/tool-call.ts:62-64`。对于一个以"审批拦截危险操作"为安全卖点的系统，这是审计空白。

**O-M3. 指标完全空白**

grep 无任何业务指标；无 `/metrics`、无 `/status` 端点。但数据全部现成，加计数即可：压缩成功率（失败点 `memory/topic/queue.ts:16` + 压缩档文件）、检索命中率（`context/semantic.ts:90-118` 的 hits/score 分布）、审批拦截率（`handler.ts:129` 批准/拒绝/超时三态齐全）、token 用量（`context/token-counter.ts` 已有 TiktokenCounter，`pipeline.ts:123` 每轮已算）。**值得加**：这些数据已经在流动，成本只是一个计数器 + 一个端点，而压缩/检索是本项目的核心记忆链路，没有成功率就是黑盒运行。建议先做内存计数 + `/status` 端点，不接外部时序库。

**O-M4. 压缩成功、检索命中零日志，核心记忆链路黑盒**

压缩失败有 warn（`memory/topic/queue.ts:16`，级别合理），但压缩成功/耗时/经验条数零日志（`compressor.ts` 全文、`queue.ts`、`tracker.ts` 关段均无）；语义检索命中数/score 分布零日志（`context/semantic.ts:81-119`）。失败能看到、成功看不见，无法判断链路是否在正常工作，也无法支撑 O-M3 的指标。

**O-M5. LLM 内部错误原文注入对话流并持久化**

`core/agent-worker.ts:358` 把 `Error: ${String(err)}` 当 assistant 文本 delta 流给前端；`provider/llm.ts:110` 同样把 `String(err)` 注入对话——内部细节（SDK 错误、路径）直接外泄给用户，且**会持久化进消息历史、污染后续上下文**。这是唯一的错误外泄点（WS error 帧写死文案不外泄堆栈，做得对）。另：`ProviderError` 只包 `String(cause)`，HTTP 状态码丢失（`provider/errors.ts`），无重试无超时配置。

**O-M6. subagent 生命周期零日志**

dispatch、前台超时/失败（吞成返回值）、后台任务失败（只记内存 `bg.error`）均无日志：`subagent/dispatcher.ts:68-72`、`subagent/background.ts:44-48`。后台失败只能靠前端轮询 `GET /subagents` 发现。

### Minor

- **O-m1**：worker 每条用户消息 5+ 条 info 级调试残留（`agent-worker.ts:149,152,204,214,327,329`：enqueue、processQueue、appended 数），应是 debug 级，且会冲掉 1000 条环形缓冲。
- **O-m2**：无 trace id/requestId 串联；Fastify 默认 `req.id` 无人使用，WS 帧无关联 id，一次对话的 HTTP + WS + 工具调用无法串起来。
- **O-m3**：HTTP 错误格式不一致：约 40 处手写 `{ error }`，但无全局 `setErrorHandler`，未捕获异常走 Fastify 默认三键格式 `{statusCode, error, message}`，message 可能含内部路径。
- **O-m4**：`/health` 只返回 `{status:"ok"}`（`server.ts:60`），不含 sidecar/LLM 依赖检查——supervisor 拿它做重启依据，engine 半死（如 LLM 全挂但 HTTP 活着）时健康检查失真。
- **O-m5**：语义检索失败重复打两条：`indexer.ts:69` warn + `agent-worker.ts:268` error，口径不一致。
- **O-m6**：`provider/llm.ts:103` 把完整 tool args 原文打进 error 日志，单条体积无上限。
- **O-m7**：前端错误呈现合格但不精细：HTTP 层统一包装文案可读（`apps/web/utils/fetch.ts:16-22`，用户不会看到原始 "Failed to fetch"）；但 WS error 帧原文直出 `Error: ${error}` 气泡（`stores/chat.ts:114-126`），`ensureOk` 拼出中英混杂的 `Failed to ${action}: ...`（`useEngineClient.ts:156-168`）。无 toast 系统，各页面就地渲染。
- **O-m8**：`GET /logs` 无级别/关键字过滤（`routes/logs.ts:8-15`），排障时只能肉眼翻。
- **O-m9**：群聊单 Agent 出错通过 onError 封掉所有 Agent 的流式槽（`apps/web/composables/useGroupChatStream.ts:114-117`），错误帧无 agentId 无法区分来源。

---

## 总评

**桌面端目前处于"demo 可用、产品不可用"状态。** 三层进程架构（Tauri → sidecar → engine）的 supervisor 思路是对的，taskkill /T、kill_on_drop、tmp+rename 这些 Windows 细节做对了不少；但三个 Blocker 正好形成闭环死局：supervisor 会放弃（D-B1）、重启成功前端也连不回来（D-B2）、打包后 engine 根本不存在（D-B3）。用户视角就是：用着用着"无法连接 engine"，没有任何解释和出路——与此前实际遇到的 Failed to fetch 事件完全吻合。修复优先级：D-B1/D-B2 联动（supervisor 永不退出监控 + 前端 WS 重连 + engine 状态变化通知 UI）> D-B3（resources + 内嵌 node 或明确运行时依赖）> D-M4（端口占用检测）。

**可观测性是"基建已建、水管没接"。** 环形缓冲 → /logs → LogPanel 的管道铺好了，但 52 处 console 业务日志全部绕开它（O-B1），desktop 下连 stdout 都没人收集（O-B2），等于排障只能靠猜。最划算的三件事：把 console 收敛到 pino（一处封装改动，LogPanel 即刻复活）、scheduler tick 错误加节流（O-M1，刷屏根因）、审批链路补审计日志（O-M2）。指标（O-M3）数据已现成，值得加一个 `/status` 内存计数端点，但优先级排在前三件之后。

**分级计数**：桌面端 Blocker 3 / Major 7 / Minor 9；可观测性 Blocker 2 / Major 6 / Minor 9。合计 Blocker 5 / Major 13 / Minor 18。
