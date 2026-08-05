# Intermind 一期：人形间私信（设计定案 2026-08-03）

## 背景与线程哲学

人形对人形通讯。现有两条派发通道都不是对话：

- **delegate**（借用）：她是调用方的工具，借用目标按简报执行任务；
- **puppet**（分身）：她是调用方自己的一次性分身，无人格无记忆。

Intermind 是**两个独立人形作为「她和她」说话**——对方是另一个主体，不是工具、不是分身。

地基：`enqueueSystemNotice` + 感知回合链路（E2E 已验证）；`Session.type` 已有 `"intermind"` 占位值。

线程哲学：**意识单线程**——每个 agent 一个串行队列，一个回合只有一个主人；并行给手脚、不给灵魂。私信唤醒因此必须是「入队一轮感知」而不是并行打断：信到→进接收方队列→按队列顺序触发感知回合。

## 六条决策

1. **送信 = 写信型 + 唤醒混合**：信写入接收方 intermind 会话后，触发接收方一轮感知回合即时读信；感知回合里她的回信走【搭车】——进对方队列但**不触发对方唤醒**（防连环惊醒，机制上不可能连环）。
2. **记忆分开存**：`Session.type="intermind"` 独立会话空间，按对端一个会话（`intermind:<peerAgentId>`），不参与主对话历史；交情可检索、可审计。一期会话为**派生空间**（由消息记录按 `sessionId` 前缀推导，不写 `sessions.jsonl`），不做会话生命周期管理。
3. **免审批 + 审计留痕**：私信是社交动作不是危险操作，`requiresApproval: false`；但谁给谁写了什么必须留痕（warn 级，内容摘要）。
4. **傀儡硬禁邮**：`send_private_message` 对 puppet 上下文不可用（返回「傀儡无社交权」）——傀儡无人格无社交权，防 swarm 轰炸。
5. **免打扰开关 = 待办**：本期不做（见待办清单），设计上留位置（将来按 agent 开关抑制唤醒、只落信）。
6. **监护权**：REST 可读取人形间对话（`GET /agents/:id/intermind` 与会话消息端点）；前端 UI 后续单。

## 会话空间结构

每个 agent 的 intermind 空间按对端一个会话，sessionId = `intermind:<peerAgentId>`（peer = 对端 id）。

发送语义（**邮箱对称双写**）：A 给 B 写信时，消息写入两处——

- 接收方 B 的空间：`intermind:A`（B 收到 A 的来信）；
- 发送方 A 自己的空间：`intermind:B`（A 与 B 的来往线程留底）。

两侧各自持有与对端的完整来往线程，任意一侧的 REST 都可读全量往来；消息记录带 `agentId`（发送方）归属，REST 可区分方向。来信原文不参与主对话历史（`default`/普通 session），只落在 intermind 线程；唤醒通知注入主会话，作为接收方可读的一条通知消息。

## 唤醒 / 搭车机制

### 唤醒

信写入后，接收方有可用 worker 时调用 `worker.enqueueSystemNotice(通知文本, sourceId, { intermindRide: true })`：

- 通知文本：`【来自 {发送方 name} 的私信】{content 摘要（截 200 字）}——可用 send_private_message 给 ta 回信（to: {发送方 id}）`——回信指引必须带发送方 id，真机实证接收方被唤醒后不知道回信通道，直接开口说话会让发送方永远收不到；
- sourceId：`default`（接收方主会话，与前端私聊 WS/REST 缺省会话同口径）——主会话只见这一条通知，来信原文只进 intermind 线程（防同一封信双注入）；
- 感知回合经既有串行队列入队：忙碌排队、空闲即感知，不插队、不并行。

### 搭车（ride）

由私信触发的感知回合带 `intermindRide` 标记（`Job.intermindRide` → `ToolContext.intermindRide`）。该回合内 `send_private_message` 只写信入队，**跳过唤醒**（`wake=false`）。

### 连环唤醒不可能（语义钉死）

三条防线：

1. 搭车标记：私信感知回合内的回信不唤醒对方（B 回 A 不会再惊醒 A）；
2. 感知回合**无审批通道**（`enqueueSystemNotice` 的 job 不带 `onApprovalRequest`）：写类/派发类工具一律 fail-closed——私信感知回合内无法 dispatch subagent/puppet，不存在「感知回合里派分身去送信」的旁路；
3. `send_private_message` 免审批但受工具白名单控制（agent 未授权不可用），且傀儡上下文硬拒。

因此任何链路下，一条私信最多触发接收方一轮感知；回复以搭车方式送达，不会再次唤醒。

## 失败语义

- 目标 agent 不存在：明确错误，不写信、不唤醒；
- 傀儡上下文调用：明确错误「傀儡无社交权」，不写信；
- 给自己写信：明确拒绝（与「不能借用自己」同一哲学）；
- 写消息落盘失败：抛错返回，不静默（任一侧写入失败即失败）；若接收方已落盘而发送方留底失败（双写分叉），额外落「私信双写分叉（部分落盘）」补偿审计（含 persistedSide），分叉状态有账可查；
- 接收方无可用 worker：信照常落盘，唤醒跳过并 warn（信不丢，感知延后/由用户会话自然读到）；
- 审计/日志失败：只记 warn，不影响写信（与既有审计同策略）。

## 安全与既有哲学

- 工具需 agent 白名单显式授权（`agentConfig.tools` 含 `send_private_message` 才可用），fail-closed 不变；
- 免审批只针对私信本身；感知回合内其他危险工具仍受「无审批通道 fail-closed」约束；
- 傀儡硬禁邮，swarm 批量派发（全傀儡）天然无法轰炸；
- 蓝图显式禁邮：`send_private_message` 在蓝图工作流中直接拒绝（蓝图不是人形，无社交权），不依赖服务注入的偶然结果；
- PUT 合并语义、审计脱敏风格沿用既有约定。

## REST

- `GET /agents/:id/intermind` — 列出该 agent 的 intermind 会话：`[{ peer, lastMessageAt, count }]`，按最后消息时间倒序；对端集合由消息前缀扫描推导，与 messages 端点同口径（已删除 agent / 历史非人形对端也列出）；
- `GET /agents/:id/intermind/:peerId/messages?limit=&before=` — 分页读取与对端的来往消息（`sessionId = intermind:<peerId>`，消息带 `agentId` 归属，limit 默认 100、上限 200，`before` 必须是会话内真实消息 id，未知游标返回 400）。

## 待办清单（本期不做）

- 免打扰开关（按 agent 抑制唤醒、只落信）；
- 前端 UI（会话列表 / 对话视图 / 写信用）；
- `sessions.jsonl` 显式会话记录与生命周期（删除/归档）；
- 未读计数 / 已读回执；
- 私信对 ContextPipeline 的可检索性（交情检索）深化。
- 收信箱读取工具（二期）：感知回合目前只注入 200 字摘要，完整来信无工具可读——加 read 类工具（如 `read_private_messages`）让 agent 能取全文。
