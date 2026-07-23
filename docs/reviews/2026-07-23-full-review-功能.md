# 全面 Review 第 1 块：功能实现完整性

- 日期：2026-07-23
- 范围：main @ 1768e96；以 README.md、docs/路线图.md、docs/架构文档.md、docs/design/context-pipeline-v2.md（P1–P7）为验收单，逐项核对 services/engine/src 与 crates/zome-sidecar 的实现证据
- 评审人：kimi（只读审查；两个 explore 子代理分查 ReAct+审批流、sidecar+skill，关键发现已由本人亲自回读源码复核）
- 诚实声明：本次未运行测试套件与 cargo test；engine 527 用例在本会话 c12a912 时点全量运行为绿

## 一、ContextPipeline（P1–P7）：已实现（L2 除外，见问题 Minor-2）

| Phase | 结论 | 证据 |
|---|---|---|
| P1 分层装配+降级+计数 | 已实现 | `pipeline.ts:98-142`（assemble+降级循环）、`layers.ts:57`（L5→L4→l6Ext→l3）、`token-counter.ts:22`（tiktoken cl100k 单例）、`truncate.ts:13`（20%）、`pipeline-factory.ts:11-13`（maxContextTokens 按 agent） |
| P2 话题压缩 | 已实现 | `detector.ts:16,25-44`（切换词/时间窗/阈值）、`tracker.ts:67-82`（archiveOnly 短话题）、`compressor.ts`（LLM 单程+超时+兜底）、`queue.ts`（串行）、`store.ts`（压缩档+按档缓存）、`message.ts:41-52`（先写归档再删热存储） |
| 启动对账 | 已实现 | `reconcile.ts:20-34`、`bootstrap.ts:256-268`（ZOME_STARTUP_RECONCILE 开关） |
| P3 L4 语义检索 | 已实现 | `semantic.ts:70-119`（候选×2/去重/归档排除/分段衰减/minScore/topK）、`indexer.ts:67`（距离→相似度 max(0,1-d)） |
| P5 检索自然化 | 已实现 | `recall.ts`（第三人称/置信度分档/相对时间/500 字摘要化/失败告知）、`pipeline.ts:76-96`（多轮去重 seen-set，64 会话 FIFO） |
| P6 SOUL/MIND 框架 | 已实现 | `mind-files.ts`、`agent-worker.ts:216-225`（L1=SOUL+skill）、`assembler.ts`（MIND 注入热上下文后） |
| P7 经验沉淀 | 已实现 | `compressor.ts`（经验区）、`mind-files.ts:280+`（append-only/frontmatter/Jaccard 双重门槛/≤0.5 过滤/sidecar 兜底） |

## 二、ReAct 核心：已实现但有缺陷（Major-2、Major-3）

- maxSteps=5（`agent-worker.ts:309`）、六类事件分帧（`llm.ts:74,77,105,108`、`tool-call.ts:37,50,65,78`、`turn.ts:101`）、工具结果 20% 截断（`turn.ts:56-59`→`step.ts:88,95-99`）、appended 链路持久化（`turn.ts:88-92`→`agent-worker.ts:334-336`）、tool-scheduler 冲突分批（`tool-scheduler.ts:10-47`）——均属实。
- 缺陷见问题清单 Major-2/Major-3、Minor-3/4。

## 三、审批流与工具安全：私聊完整，群聊有安全缺陷（Major-1）

- requiresApproval 标记齐全（write/edit/bash/run_command）；WS 内联确认 + 60s 超时拒绝 + 断连兜底（`handler.ts:18,86-102,121-131`、`session-handler.ts:53-71`）。
- 旁路逐条核查全部"拒绝"无放行：scheduler（`scheduler.ts:77-89` 无通道）、subagent（`bootstrap.ts:90-99`）、blueprint（`engine.ts:162-166` 显式拦截）；全局门 `bootstrap.ts:148` 恒 true，唯一实质防线 `agent-worker.ts:302-304`（无通道即拒绝）逻辑正确。
- 工作区限制与关键文件保护到位：write_file 限 `files/`、PROTECTED_FILES 按 basename 拦截、`../` 拦截（`write.ts:17-43`）；code 模式走 `project-paths.ts:47-71`（绝对路径/词法 ../ /realpath 符号链接逃逸三重拦截）；bash 白名单+禁元字符+禁斜杠（`bash.ts:6,11,22-35`）。未发现路径穿越漏洞。
- 缺陷：Major-1（群聊 run_command 免问旁路）、Minor-5/6。

## 四、记忆子系统：已实现

- DocumentStore：tmp+rename 原子写、EPERM 退避重试、JSONL 读缓存（mtime+size 指纹）、mutateLines 原子读改写（`document-store.ts:24-39,44-52,111-117`）。
- 话题压缩归档：`_compressed/*.md` frontmatter 含 msg_ids（`store.ts:18-55`）、归档可恢复（`message.ts:54-59`）、启动对账补归档孤儿（`reconcile.ts`）。
- 向量记忆：embedder + sidecar HNSW、静默降级、embed 5s 超时（`indexer.ts:36-49,57-72`）、已压缩原文排除（`semantic.ts:95-105`）。

## 五、Agent 管理 API：已实现但有缺陷（Minor-1）

- CRUD 完整（`agents.ts:10-70`：list/create/get/update/delete，id 校验、目录名即 id 强制写回）。
- 缺陷：POST/PUT 无 body 校验，未知/错误字段静默落盘（见已知坑复查）。
- 新建 Agent 生成默认 SOUL/MIND（`agents.ts:27-30`）。

## 六、Skill 加载：三来源已接线，打包有缺陷（Major-4）

- 三来源接线属实：`bootstrap.ts:46-59`（内置 packages/skills → 全局 DATA_DIR/skills → agent 私有，后者覆盖前者）；manifest 解析（`loader.ts:58-73`）；注入 L1（`agent-worker.ts:219-222`）。
- 内置 skills 仅 `core` 一个（`packages/skills/core/SKILL.md`）。
- 缺陷：Major-4（打包后内置源静默丢失）、Minor-8/9。

## 七、Sidecar：已实现（B1 未回潮）

- HNSW（`vector/mod.rs:161-172` 构建、`:37-56` 检索，线性兜底）、append-only JSONL 增量持久化 + dirty 惰性重建（`:33,38-42,80-106`）、加载去重后行覆盖（`:142-148`）。
- tiktoken-rs 按 model 单例缓存（`tokenizer/mod.rs:7-18`，失败回退 chars/4）。
- AES-256-GCM（`crypto/mod.rs:7,16-36`；master key 环境变量或自动生成落盘带权限保护）。
- gRPC 五方法（`server.rs:18-89`）、agent_id 校验（`lib.rs:16-28`）。
- supervisor 守护：30s 宽限、5s 间隔、连 3 失败重启、2^n 退避、上限 5 次（`supervisor/mod.rs:109-170`）。
- sandbox 骨架（`sandbox/mod.rs:12-15` 返回空串）与"预留"声明一致。
- cargo test 14 用例（源码计数，未实际运行）。
- 缺陷：Minor-7/10。

## 八、其他功能宣称快查

- 群聊 @mention 路由（`conductor.ts:10-33`：@all/@所有人广播、按 id/name 精确路由、无 @ 全员回复）——已实现。
- 定时任务：cron 解析 + 5s 轮询（`scheduler/scheduler.ts:21`、`bootstrap.ts:251`）——已实现。
- 蓝图：start/llm/tool/end 线性链（`blueprint/engine.ts`）——已实现（与"无分支/并行"声明一致）。
- 算力平台：AES-256-GCM `enc:` 前缀（`crypto.ts:6`、`repository.ts:109`）、baseUrl SSRF 校验含 hex IPv4 解析（`compute.ts:20,36`）——已实现。
- Plan（REST 内存态）、Subagent（前台 120s/后台）——已实现，与"内存态重启丢失"声明一致。

## 九、已知坑复查

| 已知坑 | 结果 | 证据 |
|---|---|---|
| POST /agents 静默忽略错误字段名（provider vs providerId） | **未修复**（Minor-1） | `agents.ts:16-28` 无任何字段校验，错名直接落盘；聊天时 `ErrorLLMProvider` 报"尚未配置算力 Provider"（`bootstrap.ts:185-189`），非完全静默但误导 |
| bootstrap 对 undefined tools 崩溃 | **未修复**（Major-5） | `bootstrap.ts:134` `agentConfig.tools.includes(...)` 无判空（skills 有 `?? []` 于 `:47`，tools 没有）；AgentRepository 加载层亦无归一化 |
| B1（proto-loader keepCase 致向量记忆静默失败） | **修复仍在，未回潮** | `sidecar/client.ts:65` `keepCase: true` + 注释；回归测试 `tests/sidecar/client.test.ts:25,52-67` 断言 agent_id/doc_id/top_k 完好 |

## 十、问题清单

### Blocker（0 条）

无。

### Major（5 条）

- **M1（安全）群聊通道 run_command 可被"本会话免问"，引擎侧排除名单失效** — `session-handler.ts:54,61,116` × `validation.ts:43`
  rememberKey 构造为 `${agentId}:${toolName}` 并存入 pending.toolName，`:116` 用该复合键调 `isApprovalRememberable`，判定对象变成 `"agentX:run_command"`，永远不在 `NO_REMEMBER_TOOLS={"run_command"}` 内 → guard 恒通过，`:117` 记入免问名单，`:55` 后续直接放行。run_command 恰恰只能在群聊 code 模式通道执行（`run_command.ts:97-100` 需 projectRoot，仅 session-handler 提供），保护在最需要的地方失效。目前仅靠前端 UI 不给 run_command 显示"不再询问"兜底；任何自发帧客户端带 `remember:true` 即可本连接放行任意 shell 命令。私聊通道（`handler.ts:93,126` 存裸 toolName）无此问题。
  建议：免问判定与存储统一用裸 toolName（或 `isApprovalRememberable` 前先剥离 agentId 前缀），补引擎侧回归测试。
- **M2（稳定性）异常/abort 路径无 turn.end 也无 error 帧，前端"生成中"永锁** — `turn.ts:101`（唯一发出点）、`types.ts:34,40-46`、`agent-worker.ts:356-358`
  turn.end 只在 ReAct 循环正常退出后发出；provider 抛错、工具抛错、abort 都走不到它；agent-worker catch 只补发 text.delta；LLMEvent 联合里根本没有 error 类型，但 types.ts:34 注释承诺前端在 turn.end/error/close 复位。前端确只在三者复位（`apps/web/stores/chat.ts:107-136`）→ provider key 失效/断网等常见错误下输入框永久锁定（需重连）。
  建议：agent-worker catch 补发终帧（turn.end 或新增 error 事件），并让前端对 text.delta 中的 Error 文本不依赖。
- **M3（健壮性）工具/审批异常无隔离，一处抛出整轮崩溃且当轮消息不落库** — `tool-call.ts:60-83`（`ctx.approve` 于 `:62`、`tool.execute` 于 `:76`）
  Promise.all 内无 per-call try/catch：任一 reject → 整批/整轮抛出 → 当轮已产出消息全部不落库（`agent-worker.ts:334` 在 runTurn 成功后才执行）、失败及排队的 toolCallId 无 tool.result 帧（OpenAI 协议下孤儿 toolCalls 还会污染后续轮次）、无 turn.end。当前 7 个内建工具均内部 catch，属潜在风险，任何新工具/审批通道抛错即触发。
  建议：单 call 级 try/catch 转为 `{ error }` ToolResult（与审批拒绝同构），并给终帧兜底。
- **M4（发布）内置 skills 目录打包后静默丢失** — `bootstrap.ts:32-43` × `apps/desktop/src-tauri/tauri.conf.json:29`
  `findBuiltinSkillsDir` 仅从 cwd 向上找 monorepo 的 packages/skills；打包配置只有 `externalBin: ["binaries/zome-sidecar"]`，无 resources，全仓库无任何环节把 packages/skills 放入产物；且无 env 兜底（对比 `sidecar/client.ts:14-27` 的 ZOME_PROTO_PATH）、`loader.ts:25-27` 把目录不存在静默吞掉。内置 `core` skill 在生产包中等于不存在。
  建议：打包把 packages/skills 纳入 resources 并在 engine 侧支持 env 指定内置目录；加载失败打 warn。
- **M5（已知坑未修）agentConfig.tools 无判空，缺字段即崩溃** — `bootstrap.ts:134`
  `agentConfig.tools.includes(t.name)` 对缺 `tools` 字段的 agent.json（手编/旧配置/裸 API 创建）直接 TypeError，getOrCreateWorker 抛错，该 Agent 聊天全挂。skills 已有 `?? []`（`:47`），tools 漏了。
  建议：`agentConfig.tools ?? []`，并在 AgentRepository 加载层做字段归一化。

### Minor（7 条）

- **Minor-1（已知坑未修）POST/PUT /agents 无 body 校验** — `agents.ts:16-58`：错误字段名（provider、模型名错拼等）静默落盘，失败延迟到聊天时才以误导性文案暴露。建议 zod/JSON Schema 校验并拒未知字段或至少 warn。
- **Minor-2 L2 @提及提醒无生产端** — `pipeline.ts:31,105`：全仓库无任何调用方传 mentionDesc，群聊提醒实际由 conductor 路由承担（`conductor.ts:10-33`），L2 为管线预留。建议接入或在设计文档标注预留。
- **Minor-3 maxSteps 耗尽静默** — `turn.ts:67-97`：模型可能停在工具链中段，无任何提示。建议耗尽时补一条系统告知。
- **Minor-4 `turn.ts:105` `assistantMessage!` 非空断言**：显式 maxSteps=0 会崩（当前无调用方）。建议兜底。
- **Minor-5 edit_file 无 PROTECTED_FILES 检查** — `edit_file.ts:34-64`（write_file 有，`write.ts:7-15,50-53`）：projectRoot 内同名关键文件行为与 write_file 不一致。建议对齐。
- **Minor-6 write_file 工作区分支无 symlink 防护** — `write.ts:31-40`（project 分支有 realpath 检查，`project-paths.ts:62-68`）：`files/` 内预置 symlink 可写出界（需前置条件，理论链）。建议对齐 realpath 校验。
- **Minor-7 杂项**：
  - `vector/mod.rs:80-106` embeddings.jsonl append-only 无压实，同 doc_id 反复 upsert 文件无限增长（加载正确性有测试保障，仅体积问题）；
  - `loader.ts:66-73` manifest 裸行前缀匹配，正文 "Name:" 开头行会污染字段；
  - `tests/skills/loader.test.ts` 仅 1 用例，坏文件/三来源优先级/缺省字段未覆盖；
  - `vector/mod.rs:51-53` HNSW 空结果不回退线性扫描（理论边角）；
  - 工具结果落库为截断后文本（`step.ts:95-99`），完整输出无存档（信息性备注）。

## 十一、功能完整度总评

**核心功能链完整可用，无 Blocker；设计文档宣称的 P1–P7 全部有实现证据，README/路线图的功能宣称未发现虚构。** 五个 Major 里两个是真实失效：群聊 run_command 审批免问旁路（M1，安全，建议最优先）与错误路径无终帧致前端永锁（M2，稳定性）；M3 异常隔离、M4 打包丢内置 skill、M5 判空缺失均属低成本的健壮性补课。两个此前记录的已知坑（provider 字段名、undefined tools）确认未修，B1 keepCase 确认未回潮且有回归测试。建议下一阶段按 M1 → M2 → M3 → M5 → M4 顺序消化，Minor 随排期带走。
