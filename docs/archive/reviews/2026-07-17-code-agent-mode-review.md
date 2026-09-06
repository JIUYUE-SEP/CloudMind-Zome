# Code Review：feat/code-agent-mode → main

> **编者注（2026-07-21）**：本文所述问题的事后状态——B1（proto-loader keepCase）已修复（`services/engine/src/sidecar/client.ts` 现设 `keepCase: true`）；B2/M13 所述前端 CodeWorkspace / Monaco / FileTree 组件已从代码库移除（code 模式仅保留引擎侧 `session.set_mode` + projectRoot 工具），相关条目不再适用于当前代码。

- 日期：2026-07-17
- 分支：`feat/code-agent-mode`（21 commits） vs 基线 `main`
- 规模：102 files，+6275/-393
- 威胁模型前提：engine 绑定 `127.0.0.1`（bootstrap.ts:228），本地单用户桌面应用，HTTP/WS 无鉴权
- 评审方式：主评审精读工具层与审批链（tools/、agent-worker、ws/*），5 个分区评审覆盖其余模块；所有 🔴/🟡 发现已回到源码逐条抽查验证。引擎 248 个测试 + Web 51 个测试实测全绿（vitest run）；e2e 未运行（需 Playwright 环境）。

## 总评

**不可按现状合并 main。** 分支的工程骨架是扎实的：审批链 fail-closed 设计正确、路径校验跨平台、测试底座厚实且全绿。但存在两个"整个特性静默失效"级问题——向量记忆因 proto-loader 缺 `keepCase` 而 100% 不工作且无任何报错；CodeWorkspace 前端是无引擎配套的断头路，还会向聊天流注入错误消息——以及一组安全相关 Major（审批 remember 粒度过粗、symlink 逃逸、Windows 杀不净进程树、blueprint 旁路审批门等）。修完 2 个 Blocker，并处理安全向 Major（建议至少 M1–M9）后即可合并；其余可转跟进 issue。

## 🔴 Blocker（必须修）

- **B1. `services/engine/src/sidecar/client.ts:43` — 向量记忆 Upsert/Search 全量静默失效**
  `protoLoader.loadSync(protoPath, { longs: Number, defaults: true })` 未设 `keepCase: true`，proto-loader 默认把字段名转 camelCase，而 proto 定义是 snake_case（`agent_id`/`doc_id`/`top_k`）。后果：`:74`/`:81` 发送的 `{ agent_id, doc_id, top_k }` 键被整体丢弃（序列化为空串/0），`:83` 读取响应 `r.doc_id` 也永远是 `undefined`（实际字段为 `docId`）。已实测验证：roundtrip 后 `agentId` 为空串。由于 `Health` 无字段不受影响，`isAvailable()` 返回 true，整条索引/检索链路"看起来正常"但从未写入或命中任何向量，且零日志。新特性"跨会话语义检索"实际不工作。
  建议：`loadSync` 增加 `keepCase: true`，一处修复收发两侧；补一个 upsert→search 的最小集成测试或启动自检，避免再次静默死亡。

- **B2. `apps/web/pages/hub.vue:289` — CodeWorkspace 是无数据源的断头路，且污染聊天流**
  `fileTreeEntries`（hub.vue:141）全代码库只有声明和 `resetIdeState()`（:278）两处赋值，永远为 `[]`；`onOpenFile` 发送的 `{type:"code.file_open"}` 帧在引擎端没有任何处理器（已全仓 grep 确认），会穿透到聊天路径 `sanitizeInput(undefined)`（session-handler.ts:149），引擎回 `{error:"text must be a string"}`——**用户每点一次文件树，群聊消息流就被注入一条错误消息**（hub.vue:250-259）。`onFileOpened`/`onCommandOutput`（:243-249）监听的帧引擎从不发送，编辑器和终端永远空白。
  建议：合并前二选一——补齐引擎端文件列表/打开/命令输出帧协议，或将 CodeWorkspace 从 hub 下线（至少对未知帧类型在引擎侧静默忽略，不要落入聊天错误路径）。

## 🟡 Major（建议修）

- **M1. `services/engine/src/tools/project-paths.ts:32-39` — 纯词法校验，symlink 可逃逸 projectRoot**
  `resolveProjectPath` 只做 `path.resolve` 词法比较，无 `realpath`。项目根内存在一个指向外部的 symlink（依赖包、仓库自带均可）时，`read_file`（**无审批**）可被诱导读取根外敏感文件，内容直接进入 LLM 上下文并发送给第三方算力平台；`edit_file`/`write_file`/`run_command(cwd)` 同理（有审批兜底）。测试也只覆盖 `..` 和绝对路径，无 symlink 用例。
  建议：对 root 与 target 做 `fs.realpath` 后比较；或文档化接受该风险，并给 read_file 加敏感文件黑名单（`.env`、`*.pem`、`id_rsa` 等）。

- **M2. `services/engine/src/tools/builtin/run_command.ts:90,98-104` — Windows 上杀不掉进程树**
  `spawn(command, [], { shell: true })` 在 Windows 经 cmd.exe 启动，`child.kill()` 只杀壳进程，超时/输出超限后孙进程继续运行并占用 projectRoot 目录。测试已被迫打补丁绕行（run_command.test.ts 里 `process.chdir(tmpdir)` 避免 afterEach 删除失败），等于承认了该行为。
  建议：win32 用 `taskkill /pid <pid> /T /F`，POSIX 用 `detached: true` + 进程组 kill。

- **M3. `services/engine/src/api/ws/handler.ts:58,102` + `session-handler.ts:116` — 审批 remember 粒度过粗**
  "本会话不再询问"按 `toolName` 记忆：对 `run_command` 点一次 remember，本连接内后续**所有任意命令**都不再询问，审批门对该工具形同虚设（bash.ts 的白名单尚可兜底，run_command 是裸 shell）。黑名单（run_command.ts:16-25）本身易绕过，代码注释也自认只是兜底。
  建议：`run_command` 不参与 remember（每次必问），或按命令前缀/参数哈希记忆；UI 勾选 remember 时明示风险。

- **M4. `services/engine/src/api/routes/compute.ts:27` — IPv4-mapped IPv6 的 SSRF 拦截是死代码**
  WHATWG URL 会把 `[::ffff:127.0.0.1]` 归一化为 hex 形式 `[::ffff:7f00:1]`，正则 `/^::ffff:(\d+\.\d+\.\d+\.\d+)$/` 只匹配点分形式，永远命中不了（已实测）。`http://[::ffff:127.0.0.1]/`、`http://[::ffff:169.254.169.254]/`（云元数据）、`http://[::127.0.0.1]/`、`http://[::]/` 全部绕过。provider apiKey 会随请求发往该地址。
  建议：对 `::ffff:` 前缀按 hex 段解析后走 `isPrivateV4`，并拦截 `::`/兼容形式；或改白名单思路（仅允许域名/显式公网 IP）。

- **M5. `services/engine/src/api/routes/plans.ts:48-51,127-129` — body 缺运行时校验**
  无 body/无 content-type 时 `request.body` 为 `undefined`，`body.goal` 抛 TypeError；`{"goal":123}` 时 `.trim()` 抛 TypeError，均为不友好的 500。goal 无长度上限（WS 侧 sanitizeInput 有 10000 字符先例，HTTP 侧没有）。retry 的 `stepId` 同病。
  建议：zod schema 或手工 `typeof` 校验 + 长度上限。

- **M6. `services/engine/src/api/routes/plans.ts:75-98` — `/run` 无并发锁、无超时/中止**
  两个并发 `/run` 请求会让 B 跳过 A 已置 running 的 step、并发执行后续 pending step，破坏注释声明的顺序语义；整轮计划是 N 次完整 agent 对话串在单个 HTTP 请求里，客户端断连不取消，token 持续消耗。
  建议：plan 级运行锁（running 返回 409）+ 向下传 AbortSignal。

- **M7. `services/engine/src/bootstrap.ts:77-94` — runAgentCollect 无超时无取消**
  dispatcher/background 的 `Promise.race`（dispatcher.ts:60-71）超时只是放弃等待，worker 内 job 继续跑（token 照烧、闭包常驻）；worker 队列一旦卡住（LLM 流挂起），返回的 Promise 永不 settle，派发任务永久挂起。
  建议：AbortSignal 传入 worker/turn，超时真正取消本轮。

- **M8. `services/engine/src/blueprint/engine.ts:153-176` — blueprint 直调工具，旁路审批门**
  `executeTool` 以 `approve: () => true` 构造 ctx 并直接 `tool.execute()`，`requiresApproval` 检查只存在于 agent-worker/tool-call 层。当前因 ctx 无 projectRoot（run_command/edit_file 拒绝执行）且 bash 有白名单而未构成直接 RCE，但违反 types.ts"无审批通道一律拒绝"的契约——一旦日后给 blueprint 注入 projectRoot 或新增无内部防护的危险工具，即刻变成无确认执行。且 blueprint 用 `getBuiltinTools()` 全量注册，不受 agent 的 tools 白名单约束。
  建议：`executeTool` 拒绝 `requiresApproval` 工具（或接入审批通道后再放行）。

- **M9. `services/engine/src/memory/indexer.ts:28-37` + `core/agent-worker.ts:140` — 检索阻塞聊天主链路**
  `search()` 在每轮对话中被 await，`embedder.embed()` 走 OpenAI SDK 默认超时（分钟级且带重试）。嵌入服务 hang 时整轮对话卡在检索阶段。
  建议：embed 包 3–5s `Promise.race`，超时降级返回 `[]`。

- **M10. `services/engine/src/bootstrap.ts:104-152` — 懒创建 check-then-act 竞态**
  `getPlanManager`/`getOrCreateWorker` 均为"查缓存 → await → set"：并发首调各建实例互相覆盖。两个 AgentWorker 并行消费同一 agent 会破坏串行不变量，游离实例也不受 `onChange` 的 pause 控制（后者是存量问题，本分支新增的 runAgentCollect 并发入口放大了它）。
  建议：缓存创建 Promise 而非实例（crypto.ts 的 keyCache 已是正确范式）。

- **M11. `crates/zome-sidecar/src/supervisor/mod.rs:74-79` — adopt 路径监管失效**
  "已有健康 engine"时直接 `return Ok(())`，`SUPERVISOR` 始终为 `None`：被收养的 engine 之后挂掉，`restart()` 空转 5 次后 watch 任务退出；`shutdown()` 也杀不掉它。
  建议：adopt 时记录足够状态让 restart 能重新 spawn，或禁止在该路径跳过监管。

- **M12. `crates/zome-sidecar/src/main.rs:15-17` — serve() 出错跳过清理**
  `res?` 直接从 main 返回（典型场景：50051 被占），跳过 `:22` 的 `supervisor::shutdown()`，刚 spawn 的 node engine 成孤儿占用 8848（Child 存于 static，`kill_on_drop` 不触发）。
  建议：错误路径同样走完 shutdown 再返回。

- **M13. `apps/desktop/src-tauri/tauri.conf.json:21` + `apps/web/components/code/CodeEditor.vue:52` — Monaco 运行时从 CDN 加载**
  `loader.init()` 未 `loader.config({ monaco })`，默认从 jsdelivr 远程加载 Monaco，CSP 为此开了 `script-src 'unsafe-inline' https://cdn.jsdelivr.net`——桌面 webview 运行时执行远程 JS（供应链风险），离线即坏，且 `await loader.init()` 无 `.catch`（加载失败即 unhandled rejection）。`package.json` 新增的 `monaco-editor` 依赖实际只作了类型导入。
  建议：`import * as monaco from "monaco-editor"` + `loader.config({ monaco })` 本地打包，收紧 CSP 去掉 CDN 源。

- **M14. `apps/web/pages/hub.vue:283-287` — setMode 乐观更新，失败不回滚**
  `sessionMode.value = mode` 先于 `sendRaw`，且忽略返回值：socket 已关闭或引擎回 error（如 Invalid project id）时 UI 停在 code 模式而引擎仍是 chat，两侧状态永久失谐（`session.mode_changed` 不会到达）。
  建议：检查返回值失败回滚，或以 `onModeChanged` 为唯一状态源。

- **M15. `services/engine/src/api/ws/session-handler.ts:101-105` — 群聊消息无串行化**
  单聊 handler.ts 本分支新增了 chain 串行处理，群聊没有：`void handleMessage(raw)` 并发执行，快速连发时 A 的持久化未完成 B 就开始读 history，B 的上下文可能漏掉 A；审批/set_mode 帧与普通消息也会交错。
  建议：对齐 handler.ts 的 chain 模式。

- **M16. 关键安全链路测试缺口**
  - `session-handler.ts:46-80,111-120` 的 WS 审批全链路（approvalId 关联、60s 超时自动拒、socket 关闭拒全部 pending、并发多笔、remember）**零用例**，全仓 grep 不到 `tool.approval`——"WS 断连时 pending approval 是否 fail-closed"这一人审核心行为未验证。
  - symlink 逃逸无拒绝用例（对照 M1）。
  - `tests/scheduler/repository.test.ts` 删掉了 SchedulerRepository 全部 CRUD 直测（update/delete/更新不存在抛错），只留两个并发用例，覆盖率回退。
  建议：补 ws-session 级审批用例与 symlink 用例，恢复被删直测。

## 🟢 Minor（可选）

- `run_command.ts:42-46` — 截断在任意字节处切断 UTF-8 序列，输出末尾出现乱码替换符。建议按字符边界截断。
- `list_files.ts:8,33-35` — `recursive` 参数暴露在 schema 里却固定返回"未实现"（LLM 会反复尝试）；条目无排序无上限；`String(err)` 把绝对路径带进模型上下文。建议移除该参数或实现之，错误只回 `err.message`。
- `edit_file.ts:47-63` — 读-改-写非原子（TOCTOU，本场景可接受但值得注释）；对非 UTF-8/二进制文件会写坏；文件不存在/路径是目录的错误路径无测试。
- `indexer.ts:19,30` + `sidecar/client.ts:56-62` — `isAvailable()` 在 try 外被 await，而 `call()` 的 Promise 执行器内同步抛错会 reject，叠加 `void indexer.indexMessage(...)` 存在理论上的 unhandled rejection 路径；所有降级完全无日志，排障困难。建议 isAvailable 也纳入 try，降级处加 debug 级日志。
- `background.ts:15` — `tasks` Map 永不淘汰，已完成任务的完整 output 永久驻留内存，`GET /subagents/background` 无分页。建议保留最近 N 条。
- `config.ts:27` / `compute.ts:107` — `"***"` 脱敏哨兵可被客户端回显写入覆盖真实 key，服务端写入侧应显式跳过该值。
- `bootstrap.ts:81` — 每个 subagent 任务以 `subagent_<uuid>` 为 sessionId 持久化，历史文件只增不减。建议不持久化或定期清理。
- `bootstrap.ts:54-57` — SKILL.md 全文无长度上限注入 system prompt，超大技能文件会挤爆上下文窗口。建议截断或告警。
- `scheduler.ts:67` — cron 失效的任务置 `enabled=false` 后本周期仍执行一次。建议禁用后直接 return。
- `conductor.ts:14,22` — 返回 `session.agentIds` 活引用，调用方修改会污染 Session；名为 `all`/`所有人` 的 agent 永远无法被单独 @。建议返回拷贝。
- `message.ts:30` — `getByIds` 每次全量扫描历史文件，检索命中时 O(n)；返回值是文件顺序而非入参 ids 顺序（当前调用方不依赖）。
- `validation.ts:23` — `NODE_ENV === "e2e"` 时 WS Origin 校验全放行，注意约束 e2e 环境不进入生产构建。
- `hub.vue:248` — `terminalOutput` 无长度上限且每 chunk 触发整个 `<pre>` 重渲染，长输出拖垮页面。建议环形截断（保留末尾 ~64KB）。
- `FileTree.vue:5` / `CodeWorkspace.vue:45` — `entry.name` 同时作 `:key` 和打开路径：嵌套目录同名文件 key 冲突，打开路径丢失父目录前缀。
- `CodeEditor.vue:68-75` — 外部回写走 `setValue` 清空撤销栈并重置光标；编辑器内的修改没有任何回传引擎的保存通道，切换文件即静默丢失。建议至少加只读提示。
- `useEngineClient.ts:430` — `setMode` 经对象字面量方法 + 解构调用丢失 `this`，建议改闭包。
- `utils/approval.ts`（及三处调用方）— WS 断开时点击审批按钮（sendRaw 返回 false）卡片保持 pending 且无任何提示。建议失败 toast 或恢复可点状态。
- `sidecar.rs:98-107` — Windows 关闭路径在 async 上下文用阻塞 `std::process::Command::output()`，Unix 固定睡 2s，都会卡窗口关闭。建议 tokio Command + 按退出轮询。
- `supervisor/mod.rs:259` — Unix 关闭仅 SIGKILL node 本体，engine 的子进程不在清理范围（Windows 的 `taskkill /T` 反而更彻底）。
- `prepare-sidecar.mjs:13` — `rustc -vV` 解析失败时 triple 为空串仍退出 0，产出 `zome-sidecar-.exe`，Tauri 运行时找不到。建议空 triple 时 fail fast。
- `plans.ts` — plans 纯内存存储，无持久化无上限，重启即丢（若属预期请在 API 文档注明）；`resolveManager` 的 reply 参数是手写结构类型而非 `FastifyReply`，与其他路由风格不一。
- `skills.ts` + `bootstrap.ts:214-221` — `listSkills` 每次请求重新扫盘，无缓存；`loadSkills` 失败直接 500。建议缓存或降级 `[]`。
- 测试卫生：`plans.test.ts:66`/`subagents.test.ts:57` env 恢复在原值 undefined 时写成字符串 `"undefined"`；`run_command.test.ts:145-159` 真实定时器断言时长区间，过载 CI 有 flaky 风险；`hub.test.ts:203-206` 触达 VTU 内部结构 `__vueParentComponent`，升级易碎；`stores/chat.ts:133` respondApproval 与 e2e 审批/code-mode 无覆盖。

## 👍 亮点

- **审批链 fail-closed 设计正确**：agent-worker 双门（全局策略门 + `requiresApproval` 且无 `onApprovalRequest` 一律拒绝），subagent/plan 链路天然无审批通道即拒；`tool.approval` 超时视为拒绝、socket 关闭拒绝全部 pending。agent-worker.test.ts 对三态（无通道拒/批准执行/显式拒）断言扎实。
- **project-paths 跨平台严谨**：Windows 小写归一化防盘符/段大小写绕过，POSIX 用 `path.relative`；测试以 it.each 覆盖 `..`、`sub/../..`、`..hidden`、盘符大小写、跨盘符矩阵。
- **edit_file 细节到位**：用函数 replacer 规避 `String.replace` 的 `$` 替换陷阱（commit bd4195c），oldString 空串拒绝 + 唯一性校验，错误信息携带出现次数。
- **bash 白名单收紧有安全叙事**：`./` 相对脚本执行通道被反转为拒绝并注释逃逸史（write_file 写脚本再 `./` 执行即可绕白名单）；输出边收边超限即杀，避免海量输出撑爆内存。
- **CSWSH 防护与配置收敛**：WS 握手 Origin 校验（无 Origin 的非浏览器客户端放行，tauri 协议特判），HTTP CORS 与 WS 共用 `getAllowedOrigins()` 一处配置，消除两处硬编码漂移。
- **document-store.ts** 模块级按文件串行写队列 + `mutateLines` 原子读-改-写，修掉 repository update/delete 的丢更新竞态；**crypto.ts** 以 Promise 缓存密钥消除并发首调互相覆盖导致密文不可解的问题；**config/repository.ts** `structuredClone` 堵住调用方 mutate 污染全局默认配置。
- **Tauri capabilities 权限最小化**：删除 `shell:allow-execute`，`shell:allow-spawn` 限定 `binaries/zome-sidecar`（与 externalBin 名称一致）。
- **utils/approval.ts** 把私聊/群聊/会话页三处审批状态机收敛为纯函数，settle 前先 findPendingApproval 守卫，重复点击与"已在它端处理"竞态被干净拦截，remember 语义与后端逐条核对一致。
- **密钥脱敏测试扎实**：config.test.ts 同时断言 API 返回 `***`、落盘为 `enc:` 密文且可解回原文。
- **持久化顺序修复**：tool 消息按真实顺序随 assistant toolCalls 一起落库，避免孤儿 tool 消息；单聊 handler 新增消息串行化 chain；群聊空路由目标（@了不存在的成员）从静默消失改为显式报错。
- **测试底座**：引擎 248 个测试、Web 51 个测试实测全绿，新增工具/API 均有配套用例。
