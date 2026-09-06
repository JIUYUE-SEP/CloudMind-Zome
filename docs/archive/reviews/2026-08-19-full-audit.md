# CloudMind-Zome 全项目终审报告

> 审计日期：2026-08-19
> 审计方式：工程基线验证（pnpm build/verify/e2e 检测）+ 16 路并行只读审计代理逐模块核查（每条结论带 文件:行号 证据）+ 主控逐项存在性复核（High 与关键 Medium 亲读代码）+ 独立交叉复核（17/17 成立、0 误报）
> 对照基准：2026-08-13 模块审计报告的修复终态（C1、H1–H10、M 级 41 项）、Cordis 迁移 P0–P9 + 第二阶段 E1–E4、欠账清单 D1–D5（commit 区间 4034ec6..9bc3162）
> 审计对象：services/engine、apps/web、apps/desktop（Tauri）、crates/zome-sidecar（Rust）、packages/shared、docs、tests

---

## 一、验证基线（真实运行结果）

| 验证项 | 结果 |
|--------|------|
| `pnpm verify`（CI 对齐总闸：turbo lint → typecheck → vitest → cargo fmt/clippy/test） | ✅ **全绿**（engine 166 文件 / 1495 用例、web 29 文件 / 195 用例、sidecar cargo 59 用例） |
| `pnpm build`（shared/engine/web） | ✅ 通过 |
| desktop 构建 / desktop cargo test | ⚠️ 本机环境受限（缺 GUI/dbus 系统库，WSL 无法装）——非代码缺陷；打包链 M46 修复后 sidecar 腿已实证可构建（release 二进制产出） |
| e2e（Playwright） | ⚠️ 本机缺浏览器系统库（libnss3/libnspr4/libnssutil3/libasound），未跑——浏览器二进制已就位，装系统库后即可跑 |
| 仓库卫生 | ✅ 工作树干净、端口/进程无残留、/tmp 清场 |

## 二、核心结论摘要

**修复回归核实（专项 16 路）**：8-13 审计的 C1、H1–H10 与 M 级 41 项修复在最终代码上**全部成立、零行为破坏性副作用**，每项带行为级测试钉住；路线图 §五 欠账销项与 commit 一一对应。大重构（P7–P9/E1–E4/D1–D5）未引入 Critical 级回归。

**新发现**：0 Critical / **1 High** / 16 Medium（含 4 项交叉复核加重/清单外发现）/ 约 30 Low（多为注释漂移与小口径不齐）。

| 等级 | 数量 | 说明 |
|------|------|------|
| 🔴 Critical | 0 | — |
| 🟠 High | 1 | resume 浮空 promise 可崩引擎进程（H-1） |
| 🟡 Medium | 16 | 见第四节详表 |
| 🔵 Low/Info | ~30 | 注释漂移、口径不齐、文档滞后 |
| 📄 文档漂移 | 7 处 | 见第五节 |

**总体判断**：迁移与修复浪潮的代码质量经受住了全面复审——新架构（插件体系/事件缝/断言/外部插件）地基扎实。遗留问题集中在三类：① 修复批次的口径残留（「做了一半」型：compute DELETE 404 漏修、M27 只覆盖入队期、M40 归因只覆盖搭车路径、M14 对账路径未接钩子）；② 新面的边界未防（registerExternal 空 parameters、perception waterfall 吞守卫）；③ 桌面打包/CI/dev 首跑的流程缺口（无自动化兜底）。

---

## 三、High 级缺陷（1 个，建议立即修复）

### H-1 REST resume 的 completion 浮空——重跑失败 = unhandled rejection，引擎进程崩溃

- **证据链**：`api/routes/subagents.ts:94` 裸调 `manager.resume(taskId)` 丢弃返回值；`subagent/background.ts:227-251` resume → retryTracked → runTracked，失败路径 `:298 throw err` 使 completion promise 拒绝；全引擎无 `unhandledRejection` 兜底（`shutdown.ts` 只有 SIGTERM/SIGINT）；`.nvmrc`=22，Node ≥15 默认 throw 模式
- **对照**：swarm 路径在 `agent-run-batch.ts:346` 有 await+catch，REST resume 是唯一泄漏点
- **影响**：任一 resume 重跑失败（LLM 故障/agent 已删/超时）→ 引擎进程崩溃，桌面端全会话中断
- **修法**（一行级）：REST 层 `void manager.resume(taskId).completion.catch(err => logger.warn(...))`；测试补 resume 失败路径不崩进程

---

## 四、Medium 级缺陷（16 项）

| # | 模块 | 缺陷 | 证据 | 交叉复核校准 |
|---|------|------|------|------------|
| F1 | 上下文管线 | agent `maxContextTokens` 全链无数值校验：≤0/NaN 时预算降级打到底 + 水位提醒/撞顶永不触发（双失效），用户无 400 提示 | `api/routes/agents.ts:84,134`（只校验 handoffMaxShifts）、`core/pipeline-factory.ts:20-22`、`context/pipeline.ts:140`、`agent-worker.ts:764-765` | 维持。修法：POST/PUT 加正整数校验（照 handoffMaxShifts 模板） |
| F2 | 记忆 | topic-state 损坏隔离把「高版本」当「损坏」rename 走，违 `versioning.ts`「高版本不改文件」契约（D1 引入；**handoff/state.ts 同病**，交叉复核清单外发现） | `memory/topic/state.ts:101-126`、`handoff/state.ts:21-43`；正确范式在 `config/repository.ts:110-126`（版本检查在 catch 外） | 维持。当前无 v2 野外文件，属已装引信的潜伏缺陷 |
| F3 | 工具 | registerExternal 对 undefined/null parameters 探测 `.safeParse` 即 TypeError → 整个外部插件 apply-failed（报错文案无指引） | `plugins/tools/index.ts:109`；fail-closed 由 `plugins/external/index.ts:277-283` 兜底 | 维持。无参工具是常态形态，易踩；修法一行 |
| F4 | 工具/MCP | MCP server 启动期连接失败后 tools=[] 永久失声——自愈仅在工具调用失败时触发，而工具列表空则永不可见永不会调用；无 REST/定时器恢复通道 | `tools/mcp/client-manager.ts:271-277`；`reconnect` 仅两处引用 | 维持。修法：启动失败挂退避重试或 REST 重连端点；短期可先文档化 |
| F5 | 调度 | M27 修复口径缺口：重试只覆盖入队期失败；执行期失败（最常见：LLM/provider）仍静默丢失——runScheduledTask 入队即返回，job 无 onDone；退役 worker 丢弃也伪装成功 | `scheduler/scheduler.ts:124,143-162`、`scheduler/types.ts:6-11`、`agent-worker.ts:386-408` | 维持。修法：ScheduledTaskJob 加 onDone，补偿扩到执行期 |
| F6 | Plan | plans 插件 planManagers 缓存不随 agent 删除失效：删除后 plans REST 仍 200 出旧数据；同 id 重建/僵尸 manager persist 会重建幽灵目录 | `plugins/plans/index.ts:35-52`（缓存先于存在性检查、无逐出钩）、`memory/repositories/agent.ts:140-148` | 维持。修法：删除时逐出（worker 有 retire 钩，plans 是孤例） |
| F7 | 蓝图 | 环校验漏网（M25 残留）：A→B→A 环经 visited 静默截停且报 completed；**加重情节**：节点动作在父帧执行、visited 检查在子帧，环入口节点会被执行两次 | `blueprint/engine.ts:73-89,99,108-117` | 维持（含加重）。修法：validateBlueprint 加环检测 |
| F8 | 算力 | Anthropic 适配器原生端点低估 completionTokens：message_delta 守卫要求 input+output 双 number，原生端点 message_delta 只带 output_tokens → usage 停在 message_start 初值（≈1），llm_calls/usage 聚合失真 | `provider/protocols/anthropic-messages.ts:287`；测试按 DeepSeek 端点建模所以全绿 | 维持。修法：守卫放宽为 output_tokens 单 number 即更新（合并而非整体替换） |
| F9 | REST | 打包桌面端 REST 被 CORS 拦截风险：WS 侧显式放行 `tauri://`/`*.tauri.localhost`，CORS 白名单只有 localhost 系；带 Bearer 头的 REST 在 webview 起源下预检失败（dev 走 localhost:3000 感知不到） | `api/server.ts:35-43` vs `api/ws/validation.ts:26-29`；`tauri.conf.json` CSP connect-src 直连 8848 | 维持（真机未验证）。修法：desktop spawn 注入 CLOUDMIND_ALLOWED_ORIGINS（不动默认面）或白名单并入 tauri 起源（两起源仅本机 Tauri 可持有，安全）；修后真机验证 |
| F10 | REST | compute 两个 DELETE 恒 204（A3 漏修）：DELETE provider/model 不存在也 204，与同文件 PUT 的 404 自相矛盾 | `api/routes/compute.ts:459-468,627-639` 对照 `:442,561-562` | **降为 Low**（纯口径）。修法两行照 PUT 模板 |
| F11 | WS | 私聊 close 竞态：首个 await（getAgentWorker 冷创建窗口）在 attachConnection 与 close 监听注册之前——窗口内断连则 close 事件丢失，僵尸 loop 永驻注册表 + 缓冲消息入队到死 socket（白烧 token 至保险丝） | `api/ws/handler.ts:105` 先于 `:121,:149`；预存（非插件化回归） | 维持。修法：close 监听前移 + attach 前查 readyState。附带清单外发现：`handler.ts:48` 的 `await getAuthToken()` 也早于 message 监听注册，与 :62-65 注释自述矛盾（稳态仅微任务延迟，窗口窄） |
| F12 | Intermind | perception waterfall 被吞时裸 TypeError：中间件不调 next() → resolved=undefined → `resolved.targetAgentId` 炸；信已落盘已审计但工具返回失败 → 模型重试造成重复信；且注释所称「P8b 断言兜底」不存在（invariants 无 perception 断言） | `plugins/perception/index.ts:87-90`；cordis `lib/index.js:327-336` 实证 | 维持（陷阱类：一行守卫绝后患）+ 注释修正 |
| F13 | 前端 | 私聊流式零文本直接 tool.call 时工具徽章静默丢失（last 是 user 气泡不挂徽章）；群聊侧 slotFor 自动建槽——两入口口径分裂 | `apps/web/stores/chat.ts:165-171` vs `composables/useGroupChatStream.ts:27-45,97-99`；预存非本轮引入 | 维持。修法：无槽时自动建槽（照群聊 slotFor） |
| F14 | 桌面/sidecar | 打包产物资源定位不覆盖 macOS .app/deb 布局（node_bin/engine_entry 候选只有 exe 旁/resources/..；.app 需 Contents/Resources 路径）；tauri.conf targets=all 必出 mac 包 | `crates/zome-sidecar/src/supervisor/mod.rs:48-54,84-88` | 维持。deb 不命中 2026-07-23 已在案，本次补 macOS |
| F15 | 桌面/sidecar | desktop crate 不进 CI（6 单测含 desktop↔sidecar data_dir 同源契约无人跑；本机实测缺 libdbus 无法编译）；打包链只在人工打包时验证 | `.github/workflows/ci.yml:44-50,65-67` | 维持（流程类） |
| F16 | 桌面/sidecar | 全新克隆 desktop dev 首跑断链：binaries//resources/ 被 gitignore 且 dev 链无 prepare 步骤无文档指引，首跑 sidecar spawn 失败前端永停 not ready | `.gitignore:36,38`、`tauri.conf.json:6`（beforeDevCommand 无 prepare） | 维持（流程类）。修法：beforeDevCommand 接入 prepare 或文档补前置 |
| （专项） | 工具/审计 | **M34 审批审计无跨重启留存——8-13 在案项分诊漏网，从未被修**：approval-audit 只走 logger（stdout + 内存环形缓冲 1000 条，重启即清）；git 全史实证无修复 commit；且不在任何搁置清单 | `plugins/approval-audit/index.ts`、`plugins/log/log-buffer.ts:1-2`；desktop 托管下 sidecar 捕获 stdout 落盘有缓解（7 文件轮转），standalone dev 无留存 | 维持。修法：审计追加文件 sink（approval.jsonl）或明确搁置入档 |

### Low 级摘要（约 30 项，择要）

- 私聊 processQueue 自续链调用缺 .catch（`agent-worker.ts:1019`，结构性不对称）；retire 对在途 turn 无超时/无 abort（排空等待无上限，设计取舍建议登记）
- 非私聊路径撞顶只落交接书不续跑（scheduler/notice/群聊，注释未明说边界）
- MCP task 化工具、readOnlyHint 信任面等既有口径不变；`tools/registry.ts` 生产死代码
- 归档 createdAt 有序性前提可被孤儿补归档破坏（reconcileHotStorage 追加末尾，归并读乱序）；复核拆段崩溃窗口产 msgIds 重叠的孤儿压缩档（噪声级）
- intermind：H8 双向同刻 trim 可产重复归档行（窗口极窄）；listSessions count 只数热存储；read_private_messages 翻到尽头 hint 误报「没有来往私信」
- M40 归因只覆盖搭车路径，唤醒路径同格式通知无 agentId
- provider：上游错误体经主链路进日志/落盘（500 截断兜底，与 test-connection 脱敏口径不对称）；ModelApiModeRouter 活配置缺 models 字段守卫；responses 适配器缺 output_item.added 时丢 tool.call；providerType 无白名单
- REST：PUT providers 不防 "***" 掩码回写（与 config.ts 口径不对称）；skills 两路由缺 isValidAgentId；PUT /sessions 可清空 agentIds；config 跨请求 read-modify-write 竞态
- 群聊历史加载无降级（单 agent 读失败饿死后续目标）；群聊透传 handoff.book 帧；session-handler 回放后不清 pendingMessages
- 前端：hub 切群旧消息残留至加载完成；list-loader isLoading 并发提前复位；managed-ws 初始建连链无 .catch；群聊流缺 delta 类型防御
- sidecar：Unix 纳管 child 关停 SIGKILL-only（无优雅关停窗口）；gRPC 无鉴权（H10 第三子项，未修未记档）；vector 两处注释漂移 + tombstones 字段只写不读；dev 回退 project_root 命中 apps/desktop/package.json
- 关停：drain 失败与超时同文案；M51 冲刷只覆盖 exit(2)，通用启动失败路径（bootstrap main catch）无冲刷
- `tests/placeholder.test.ts` 恒绿占位残留（建仓遗留）

## 五、文档漂移清单

| 项 | 事实 |
|---|---|
| 路线图用例数 | 同日再漂移（写 165/1481、27/179、56；实际 166/1495、29/195、59） |
| 路线图 M35-交接书 | 「搁置 6 项」与「已收（D1）」自相矛盾（代码已修，搁置清单滞后） |
| 路线图 M 级计数 | 「在案 41 + 搁置 6 + 已修 1 = 48 ≠ 51」；M34 漏网（既不在案也不搁置）；M44 双重计入 |
| 架构文档 §4.3 行号锚点 | D5 拆分后失效（turn.ts:708-715 越界；四件套已迁 handoff-book.ts） |
| 架构文档 SSRF 表述 | 双重漂移：hex 绕过 2026-07-17 已修仍写成威胁；D3 的 DNS 逐记录判定未写入 |
| 开发指南 §3/§2.3/§6 | §3 启动流程写 21 插件与 §2.3 的 22 矛盾；§6 测试目录清单缺 tests/plugins 等 4 个目录 |
| E4 示例插件 | 无测试防漂移（已被人工抓过一次 inject 缺 tools） |

## 六、模块完善度评价（16 模块）

| 模块 | 完善度 | 主要缺口 |
|------|--------|---------|
| ReAct 核心 | ⭐⭐⭐⭐⭐ | 无功能性缺陷 |
| AgentWorker/handoff | ⭐⭐⭐⭐⭐（偏弱） | 浮空 promise 不对称、retire 无上限 |
| ContextPipeline | ⭐⭐⭐⭐½ | F1 校验缺口 |
| 记忆/心智 | ⭐⭐⭐⭐ | F2 高版本误隔离、对账路径未接 M14 钩子 |
| 工具系统 | ⭐⭐⭐⭐½ | F3 空 parameters、F4 启动失败失声 |
| Plan/Subagent/Scheduler/蓝图 | ⭐⭐⭐⭐ | **H-1**、F5/F6/F7 口径残留 |
| 算力平台 | ⭐⭐⭐⭐ | F8 usage 失真、F9 CORS |
| REST API | ⭐⭐⭐⭐½ | F9/F10「做了一半」型残余 |
| WebSocket 层 | ⭐⭐⭐⭐ | F11 close 竞态 |
| Intermind/感知总线 | ⭐⭐⭐⭐ | F12 waterfall 守卫、M40 半覆盖 |
| 配置/鉴权/关停 | ⭐⭐⭐⭐ | 收尾一致性（冲刷/掩码/注释指针） |
| 插件体系 | ⭐⭐⭐⭐½ | serial 截断语义未入契约、外部插件运行期事件面无护栏说明 |
| Web 前端 | ⭐⭐⭐⭐½ | F13 徽章丢失、hub 切群残留 |
| 桌面/sidecar | ⭐⭐⭐⭐ | F14/F15/F16 打包/CI/首跑无自动化兜底 |
| 测试与文档 | ⭐⭐⭐⭐ | 文档维护「最后一棒」纪律（行号/用例数/清单漂移） |
| 修复回归专项 | ⭐⭐⭐⭐ | 45 项修复全部真实成立；扣一星因 M34 漏网 + 计数不自洽 |

## 七、修复优先级路线图

### 立即修（改动小、收益直接）

1. **H-1** — resume 路由接 completion.catch（一行级消除进程崩溃面）+ 失败路径测试
2. **F3** — registerExternal parameters null-safe（一行）
3. **F12** — perception waterfall `resolved ?? payload` 守卫 + 修正「P8b 断言兜底」注释
4. **F1** — agents POST/PUT 加 maxContextTokens 正整数校验
5. **F2** — topic-state 与 handoff-state 两处的 quarantine 排除 UnsupportedSchemaVersionError（照 config/repository.ts 范式）
6. **F10** — compute 两个 DELETE 补 404（两行）
7. **F6** — plans 缓存挂 agent 删除逐出
8. **M34（专项）** — 审批审计加文件 sink（approval.jsonl）或明确搁置入档；同步修正路线图计数与搁置清单

### 短期（下一批次）

9. F5（ScheduledTaskJob 加 onDone，补偿扩到执行期）
10. F11（close 监听前移 + attach 前 readyState 检查 + getAuthToken 次序）
11. F7（蓝图环检测）
12. F8（message_delta 守卫放宽合并）
13. F13（私聊工具徽章自动建槽）
14. 文档漂移 7 处统一回填（含架构文档 §4.3 行号、用例数、测试目录清单）

### 可缓/记录即可

15. F9（CORS 修法低风险，修后需真机验证一次）
16. F14/F15/F16（桌面打包布局/macOS 真机/desktop CI/dev 首跑 prepare 指引）
17. F4（MCP 启动失败恢复通道需设计；短期文档化「需重启 engine」）

---

*报告生成：2026-08-19。方法：16 路并行审计 + 主控存在性复核 + 独立交叉复核（17/17 成立、0 误报）；所有结论基于真实代码，关键发现均经双人复核。*
