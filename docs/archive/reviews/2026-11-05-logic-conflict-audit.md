# 逻辑冲突专项审计（2026-11-05）

> 范围：`services/engine`（core / context / memory / api / tools / provider / subagent / handoff / scheduler / plugins）、`apps/web`、`packages/shared`、`crates/zome-sidecar`、`docs`。
> 方法：**只查 logic conflict（逻辑冲突）**，不做安全/性能泛扫——同一语义多处实现不一致、状态机竞态、跨模块归属错位、文档声称与代码实际背离、测试覆盖的是被绕过的路径。
> 分工：8 个并行审计代理（core / memory / api / tools / orchestration / web / crosscut / plugins），其中 4 份完整交付（core、memory、tools、orchestration），其余 4 个因上游 429 中断；中断模块由主控用脚本化扫描补做契约与装配面（见 §五）。
> 复核：主控对 P0/P1 逐条回代码验证，并裁决了两份报告之间的分歧（§四）。**复核推翻 5 条代理结论**（1 条 P0 降级 + 4 条误报，见 §四-1 至 §四-5），故本报告只收录已验证条目。
> 结论：基线全绿（189 文件 / 1829 用例，1 skipped）。发现 **1 P0 / 9 P1 / 若干 P2**，其中 1 条推翻上次审计结论，1 条是本轮记忆召回改动自身带出的新缺口。
> **本报告是下限，不是全貌**：8 个审计面只有 4 个完整交付（core / memory / tools / orchestration），其余 4 个因上游 429 中断，仅由 §五 的脚本化扫描补了契约与装配面。`apps/web` 流式状态、crosscut 横向重复、`plugins/invariants` 三块**未审**。不要拿「1 P0 / 9 P1」当全仓缺陷总数。
>
> **对后续审计的提醒**：代理报告必须复核后再落档。本轮 tools-auditor 4 条 P0/P1 中 3 条不成立（把已登记的设计取舍当缺陷、引用了不存在的代码、漏看了已有的截断实现），orchestration-auditor 亦有 1 条信号处理误报。误报的共性是**只读了调用点、没读被调方的完整实现**。

---

## 一、基线

| 检查 | 结果 |
|------|------|
| `pnpm test` | ✅ 189 文件 / **1829 用例**（1 skipped），4m16s |
| 工作区 | 干净，起点 `edd5cb8` |

静态闸门全绿，说明问题全部落在**语义面与生命周期接缝**，与历次审计结论一致。

---

## 二、P0

### P0-1 swarm 在持久 429 下无限重试，批次永不 settle → 焊死 agent 串行队列

`subagent/agent-run-batch.ts:403-411`（唯一出口）与 `:449-453`（重排）：

```ts
} else if (this.isOnlyUnfinishedTask(attempt.state)) {
  // 最后一个任务不重排：限流也直接 failed（避免无限续跑拖住整批）
  this.results[attempt.state.index] = { ...status: "failed" };
} else {
  this.requeueRateLimited(attempt, outcome.agentId);   // 无重试上限
}
...
state.retryCount += 1;                                  // 只用于算退避
const retryDelay = rateLimitRetryDelayMs(state.retryCount - 1);  // 30s 封顶
this.pending.unshift(state);
```

**冲突**：退出条件是「批次里只剩这一个未完成任务」。≥2 个任务时互相视对方为未完成，`retryCount` 无上限，批次永不 settle。`dispatch_subagent_batch` 的 `await swarm.run()` 不返回；而 `ToolContext` 无 signal（见 §四-1，属已登记取舍），turn 即使被看门狗中断，批次仍在后台按 30s 间隔无限重试并继续烧 token。

**主控复核**：属实。`retryCount` 仅用于退避计算，无任何上限判断。

**修法（已定案，不再留选项）**——两件事都要做，缺一不可：

1. **per-task 重试次数硬上限**：`retryCount` 到顶（建议 5）直接判 `failed`，并把「限流重试耗尽」写进 `error`。**不要只加「总时长上限」**：`RATE_LIMIT_RETRY_MAX_MS` 已把单次退避封在 30s，总时长上限要么与次数上限等价、要么得另起一套计时器，不如直接数次数。
2. **永久 429 分类**：`insufficient_quota` / `billing_hard_limit_reached` 这类不可恢复错误直接判 `failed`，不进重排队列——重试一万次也不会成功，只会烧光时间与 token。

两者是互补的：分类解决「本来就不该重试」的，次数上限兜住「该重试但永远不成功」的。

---

## 三、P1

### P1-1 话题台账是 per-agent 单桶，不是 per-session：跨会话混压 + 压缩档归属错标

`memory/topic/tracker.ts:79-93`：

```ts
onUserMessage(msg, sourceId, sourceName?) {
  this.lastSourceId = sourceId;          // 先覆盖归属
  ...
  if (boundary === "new_topic") {
    const closed = this.closeSegment();  // 再用新会话的 source 造 segment
```

`tracker.ts:199` `makeSegment()` 取 `this.lastSourceId` → `store.ts:40` 写进 frontmatter `source_id`。

**为什么这是最危险的一条**：`AgentWorker` 是 per-agent 单实例、服务全部通道，而入队方至少有私聊（`default`）、群聊（`api/ws/session-handler.ts:288`）、subagent（`plugins/subagents/index.ts:87,108`，sessionId=`subagent_<uuid>`，**非 ephemeral**，只跳过 blueprint）、定时任务、intermind 感知通知（`agent-worker.ts:603`）、交接桥。后果四条：

1. 被关闭的段被打上**后到消息**的 source → recall「上阁楼」与 P4-d 审计视图里话题挂错会话。
2. `current` 混装多会话消息后按 20 条 / 30 分钟统一收段 → 私聊话题被子任务顶到阈值提前压缩；L5 摘要把不同场景压进同一档，子任务内部内容回流到私聊上下文。
3. 时间窗串味：`detectTopicBoundary` 的 prev 取 `current` 尾部（任意会话）→ 群聊/通知重置私聊的 30 分钟计时。
4. 持久化放大：`openTopic` 与 `topic-state.json` 只有一个 open 槽，`restoreOpen` 只带一个 sourceId → 错归属跨重启与配置热更固化。

同源：`agent-worker.ts:416` 的 `currentTopicSkills` 也是 worker 级单桶 → subagent 用过的技能被记进退出的私聊话题，`skillRestore` 把技能正文注入无关会话。

**旁证**：`context/pipeline.ts:118` 已有 `ONESHOT_SESSION_PREFIXES = ["subagent_", "blueprint:"]` ——「会话种类」这个概念在管线侧被识别，唯独 tracker 不识别。

**修法**：per-source 分桶。注意不止 tracker——`topic-state.json` 的 `open` 需由单对象改数组（带 schema 迁移），`reconcileOrphanedTopic` 的「保留 N 条」也要按 source 计。这是本轮改动量最大的一条。

### P1-2 看门狗心跳粒度 = step，持续流式输出的正常长回答会被误杀

心跳 `lastActivityAt` 全仓仅 3 个写入点（grep 确认）：`agent-worker.ts:849`（turn 开始）、`:479`（工具活动）、`:1204-1206`（`onStepAppended`，**一步完成后**）。而 `agent-worker.ts:1157` 是 `emit: job.onEvent` —— **流式 delta 直连前端，不刷新心跳**。

`plugins/watchdog/index.ts:262-272` 到阈值无条件 `abortCurrentTurn("watchdog")`，语义审查缺省关闭，硬阈值（缺省 600s）是唯一防线。

**冲突**：`provider/protocols/shared.ts:249-252` 明写「语义是『多久没数据』，不是『总共花了多久』——用总时长会在正常任务上误杀」。L0（180s 无 chunk）保证不了这一点：一个持续吐 token 的正常长回答可跑数十分钟而 L0 永不触发，却被 L1 在 600s 整杀掉。后果不是降级而是**回合终止**：半截内容落成 `incomplete`，不产兜底总结、不产交接书、不重试。

**修法**：`emit` 包一层带节流（≥5s）的 `lastActivityAt = Date.now()`，一行级改动。**性价比最高的一条 P1。**

### P1-3 retire 不接管后台压缩 → 两代 worker 并发压缩同一 agent

- `agent-worker.ts:687-694 retire()` 只置 `retired/paused` + 清 turn 队列；`waitForIdle()`（:700-704）的不变量是「两个 turn 不并发交错」，**不覆盖 `compressionQueue`**。
- `enqueueCompression`（:755-773）fire-and-forget，压缩任务（LLM 调用 + 归档 + MIND 写）可活过 retire。
- `drainCompression()`（:715）只在进程优雅关停用，且 `bootstrap.ts:157` 只遍历 `workerRegistry.all()` —— 退役 worker 已出表，**不会被 drain**。

**后果**：配置热更（agents PUT / compute PUT 的 `retireWorkersUsingProvider`）期间若有压缩在途，旧队列与新 worker 的新队列对同一 agent 并发执行 `runCompressionTask`：归档交错/重复；MIND 无写队列且共用同一个 `.tmp` 路径（`mind-files.ts:398`）→ 并发写互相截断。

配置编辑是常见操作，窗口不窄。

### P1-4 归档非幂等 + 读取侧不做归档内去重（**推翻 2026-11-04 审计结论**）

`memory/repositories/message.ts:162-195`：

```ts
const all = await this.store().readLines();            // 快照读在写队列之外
const archived = all.filter((m) => wanted.has(m.id));
for (const record of archived) await this.archiveStore().appendLine(record);  // 无「已存在」校验
await this.store().mutateLines(...)                     // 最后才删热存储
```

读取侧：`recall.readByTopicId`（`memory/recall.ts:96`）→ `getArchivedByIds` → `readLinesWhere` 只按 id 过滤；`listBySessionWithArchived`（`message.ts:132`）只判 `hotIds`（**归档 vs 热存储**去重）。

**主控复核**：`listBySessionWithArchived` 确有去重预扫，但仅覆盖「热存储已有同 id」的情况；归档内部重复行两条都会进结果。`readByTopicId` 则完全不去重，且 `total` 偏大。

**推翻**：2026-11-04 审计第四节写「归档行重复……读取侧按 id 去重、不影响正确性，只涨文件体积」。该假设不成立——崩溃在 append 循环与 mutate 之间时，重启 `reconcileHotStorage` 按压缩档 id 再归档同一批，产生重复行，recall 工具与历史接口会原样返回重复消息。

### P1-5 重试链被测试逃生舱绕过：`retryDelaysMs: []` 让真实行为零覆盖

`memory/topic/queue.ts:19,37` 生产退避 `[5_000, 15_000, 45_000]`；`tests/core/agent-worker.test.ts:1940` 注入 `{ retryDelaysMs: [] }`，`tests/topic/queue.test.ts` 注入 `[1,2,3]` 并 stub sleep。

**冲突**：`compression-task.ts` 是分步收尾的（MIND 沉淀 → 归档 → 删向量 → 压缩档落盘），每一步失败的处理都在「重试耗尽」的语义下才成立；而测试把重试链整个跳过，等于只测了「一次就成功」与「一次就失败」两个端点。本次 P1-3/P1-4 的并发与重复问题恰好都发生在重试窗口内。

**已核实**（复核补做，原先挂的「待确认」至此关闭）：全 `services/engine/src` 搜 `retryDelaysMs` 仅两处命中——`memory/topic/queue.ts:23,37` 的选项定义（缺省回落 `RETRY_DELAYS_MS`）与 `core/agent-worker.ts:183` 的一行注释，**无任何生产注入点**。生产恒为 `[5_000, 15_000, 45_000]` 三段退避，空数组只存在于测试。故本条的定性确定：**问题在测试覆盖，不在生产配置**。

### P1-6 `generate_image` 无 `timeoutMs` 声明，且 provider 层无超时——唯一兜底缺失

- `tools/builtin/` 15 个工具中仅 5 个声明 `timeoutMs`（bash、dispatch_subagent、dispatch_subagent_batch、run_command、web-search），`generate_image` 不在其中。
- `provider/image-gen.ts:24-31` 走 OpenAI SDK `images.generate`，**未传 timeout、未传 signal**（SDK 默认 10min × 内置重试）。
- 工具自身只有「下载结果图」的 15s 超时（`generate_image.ts:108`），生成请求本身无兜底。

**冲突**：`docs/design/watchdog.md` §六 把「工具自己的 `timeoutMs`」登记为中断失效的唯一兜底；而本工具连这个兜底声明都没有，看门狗因此不为它放宽阈值（`effectiveThresholdMs`），600s 即判停滞，而真实生成可能更久。用户点停止后界面最长再挂约 30 分钟，期间仍在写盘。

**修法**：补 `timeoutMs`（一行）+ provider 传 `timeout` 与 `signal`。

### P1-7 `aborted.reason="timeout"` 全仓不可达，前端中断归因失真

`agent-worker.ts:269-284` 的白名单含 `"timeout"`，但：
- `api/routes/plans.ts:131` 用 `AbortSignal.timeout()`，其 reason 是 `TimeoutError` DOMException（非字符串、无 `.reason`）→ 落 `"user"`；
- `provider/protocols/shared.ts:294` 流空闲超时走 `mapError → StreamIdleTimeoutError` **抛出**，从不 abort `params.signal` → 这类超时终帧不带 `aborted`；
- 蓝图 `abort()` 无 reason → 同样落 `"user"`。

**冲突**：`docs/架构文档.md:334` 宣称终帧带 `user/watchdog/stalled/timeout/shutdown` 五值，`docs/design/watchdog.md` 验收项 1 也断言 `reason="timeout"`——实际全仓无任何一处产出该字面量，计划步骤超时在前端显示为「用户已中断」。`"shutdown"` 同理不可达（关停只 drain 压缩队列，不 abort 在途 turn）。

### P1-8 scheduler 迟到的 `onDone` 用旧快照整条覆写任务

`scheduler/scheduler.ts:148-156` 的回调闭包持有发起时的 `task` 对象，`repo.update(task)` 是整条覆盖写；后续 tick 已把 `nextRunAt` 推进并写盘，迟到回调把它改成 `now+60s` 并把 `lastRunAt` 回退。效果 = 一次计划外提前触发 + 审计时间线倒流。代理已用脚本实证（`lastRunAt` 回退 172ms）。

**机制**：`tick()` 每轮从 `repo.list()` 取**新对象**，`runTask(task)` 就地改的是本轮对象（`:112-113`）；`onDone` 闭包捕获的正是这个对象。补偿路径 `scheduleRetryOnce` 只改 `nextRunAt` 一个字段，但落盘走整条 `repo.update(task)`——陈旧字段被一起写回。

**修法**：补偿只改该改的字段（`repo.patch(id, { nextRunAt })`），或落盘前重读再合并。**不要**改成「onDone 时重新取快照」——那会引入新的读-改-写竞态。

### P1-9 scheduler `runningTasks` 只覆盖入队窗口，长任务被 cron 反复入队

`scheduler/scheduler.ts:105-106,162-164`：`runningTasks` 在 `runTask` 入口 add、`finally` delete，而 `await worker.runScheduledTask(...)` 是**入队即返回**（`:141-142` 注释自述），执行期完全落在占槽窗口之外。

**后果**：cron 周期短于任务实际耗时的任务，每个 tick 都会再入队一次。注意**不是并发执行**——`AgentWorker` 队列是串行 FIFO，重复入队表现为排队堆积与延迟执行，而非同时跑。这与同文件 `:110-111` 的注释「advance schedule before execution so a long-running job does not pile up」直接矛盾。

**修法**：`runningTasks` 的释放点从 `runTask` 的 `finally` 移到 `onDone`（执行期结束），或直接以「该任务上一轮是否已结束」作为入队闸。

**为什么与 P1-8 分开**：P1-8 是落盘竞态（陈旧字段写回），P1-9 是生命周期窗口（占槽过早释放）。两者机制、修法、触发条件都不同，混成一条会让修的人以为改一处就够了。

---

## 四、主控裁决与推翻

### 1. 「abort 打不断工具」**不是 P0**——已登记的产品取舍

tools-auditor 判 P0；core-auditor 反驳。主控裁决：**降级为已知限制**。

`docs/design/watchdog.md` §六 原文：「**abort 打不断正在执行的工具**：`ToolContext` 没有 signal，工具无法感知取消。看护中断后，长跑工具仍会跑到自己返回为止……真正的兜底是工具自己的 `timeoutMs`，看护的作用是「不再无限等」而非「立即掐断」。」`agent-worker.ts:232` 的 `Job.signal` 注释亦写明「运行中在步骤边界中止」。

主控复核 `tools/types.ts:39-50` 与 `core/react/tool-call.ts:139-156` 确认实现与文档一致。**但由此推出的「兜底缺失」成立**，已单列 P1-6（generate_image 无 timeoutMs 且无内部超时）。

### 2. tools-auditor 的 `startsWith(provider.id)` 前缀匹配**不成立**

主控全仓 grep `startsWith(provider.id)` / `startsWith(p.id)` / `startsWith(providerId)` 无命中；`provider/image-gen.ts:19-22` 的 `supportsModel` 是 `return true`（刻意不做白名单，注释写明）。该条从清单移除。

### 3. 「工具结果未截断」**不成立**（误报）

`core/react/step.ts:173` 调用 `truncateToolResultText`，`turn.ts` 同样引入；`context/truncate.ts:47-52` 的实现是**按 token 截断**（经 `TokenCounter`，非字符数），并预留省略标记的 token 预算。该条从清单移除。

### 4. 「批次运行中信号被丢弃」**不成立**（误报）

`subagent/agent-run-batch.ts:213` 注册 `addEventListener("abort", this.batchAbortListener, { once: true })`；`:183-188` 的 listener 会 `this.controller.abort(...)` 并按取消类型走 `finishWithUserCancellation()` 或 `fail()`。信号链路完整。该条从清单移除。

### 5. 「resilient 重试与降级顺序不当」**不成立**（把正确设计当缺陷）

`provider/resilient.ts:93-155`：内层 `for (attempt…)` 有 `maxRetries` 上限、退避有 `MAX_BACKOFF_MS` 封顶，外层 `while (fallbackIndex < fallbackIds.length)` 逐级切换——这是标准的「每 provider 独立重试预算 + 降级链」。「总耗时 = (1+maxRetries) × (1+fallback 数)」是任何降级链的固有性质，不是缺陷。

### 6. 2026-11-04 审计「归档重复行不影响正确性」**不成立**

详见 P1-4。这是本轮唯一推翻既有审计结论的条目，影响是 recall 与历史接口可能返回重复消息。

### 7. 本轮记忆召回改动自身带出的新缺口（自报）

- **L4/L5 键空间分裂**：`pipeline.ts:220-221` 的去重键是 `mem:<msgId>` 与 `topic:<topicId>`，互不感知。highKept 放行的原文与同话题 L5 摘要会同时进上下文（同一内容两遍），且 L4 的 topK 名额不因「已被摘要覆盖」而让位。属 highKept 改动的预期内代价，当时判断「接受重叠、不预设降权」，此处登记为待观察项。
- **`semanticMinScore` 在 (0, 0.5] 区间静默无效**：`semantic.ts:148` 按 `minScore` 过滤后，`pipeline.ts:221` 仍按硬编码 `CONFIDENCE_DROP = 0.5` 再丢一次。用户把 `semanticMinScore` 调到 0.2/0.4 不会增加任何召回。配置面与生效语义不一致，需补文档或改判定（取两者较大值并写入注释）。

---

## 五、主控补做：中断模块的脚本化扫描

| 扫描项 | 结果 |
|--------|------|
| **API 契约漂移**（73 个注册路由 × `docs/API.md`） | **路径/方法零漂移**：路径全部有文档记录，HTTP 方法全部一致。**边界**：只比对了路径与 HTTP 方法，**未比对响应体字段**——契约漂移若发生在响应体形状上，本次扫描看不见。不得把本行当作「API 文档与实现一致」的依据 |
| **写端点校验**（17 个无 zod 的写端点逐个看） | 无缺陷：多为 run/pause/resume 等无 body 动作；有 body 的（config / blueprints / scheduler）均有手工校验 + `?? {}` 兜底 |
| **插件装配**（23 插件 × bootstrap） | 无同名覆盖：cordis 显式 inject + `assertServices` fail-fast；`watchdog` 刻意不进 assert 列表有注释说明 |
| **`AgentConfig` 29 字段消费面** | 全部有消费；`codename` / `tags` / `representColor` 为纯前端展示字段，引擎零消费属合理 |
| **proto ↔ TS 客户端字段** | 一致（`keepCase` 已注意 snake_case） |
| **落盘格式版本链** | 全部 v1，4 条 MigrationChain 注册表为空属预期，无历史包袱 |
| **e2e-mock 路由** | 双闸（注册处 + handler 各查一次 `NODE_ENV`），生产不可达 |
| **Nuxt server 两端点** | `engine-token` 仅 dev 下发 + no-store；`agent-file` 有词法路径校验 + engine 侧 resolve 兜底 |

**未覆盖**（429 中断，留待下轮）：`apps/web` 的流式状态与乐观更新深度审读、全仓横向重复实现比对（crosscut）、`plugins/invariants` 声明的不变量是否真被调用。

---

## 六、建议修复顺序

按「收益 / 改动量」排序。前两条是 1~5 行级、改完即封顶的；第 3 条是唯一 P0，改动量中等但必须先定方案：

| 序 | 项 | 改动量 | 理由 |
|----|----|--------|------|
| 1 | P1-2 心跳按 delta 节流刷新 | ~1 行 | 直接消除「正常长回答被看门狗砍掉」 |
| 2 | P1-6 `generate_image` 补 `timeoutMs` + provider 超时 | ~5 行 | 唯一兜底缺失，补上即封顶最坏情况 |
| 3 | P0-1 swarm 重试上限 + 永久 429 分类 | ~30 行 | 唯一 P0，会烧钱并焊死队列 |
| 4 | P1-4 归档幂等（append 前按 id 过滤）+ 读取侧去重 | ~20 行 | 数据一致性，且推翻过既有结论 |
| 5 | P1-3 retire 时 drain 压缩队列 | ~20 行 | 消除两代 worker 并发写 MIND |
| 6 | P1-5 重试链测试覆盖 | 测试 | 让 P1-3/P1-4 类问题可被回归捕获 |
| 7 | P1-7 超时归因统一 | ~30 行 | 影响排障方向 |
| 8 | P1-1 话题 per-source 分桶 | 大（含 schema 迁移） | 影响面最大，但改动量最大，需单独立项与 spec |
| 9 | P1-8 scheduler 补偿只 patch `nextRunAt` | ~10 行 | 低频，但迟到回调会倒流审计时间线 |
| 10 | P1-9 `runningTasks` 占槽改到执行期结束 | ~10 行 | 低频，长任务反复入队 |

> P1-8 与 P1-9 同处 `scheduler.ts`，但**不要合成一个补丁**：前者改落盘粒度，后者改生命周期释放点，混着改会让回归定位失去参照。

> P1-1 建议单独立项：它牵动 `topic-state.json` 的 schema、`reconcile`、`skillRestore`、L5 归属标注，不适合混进「修 bug」波次。

---

## 七、备注

- 本轮未修改任何源码；审计过程仅读文件、跑测试、执行只读脚本。
- 4 份代理报告原始结论已在文中标注来源；主控对 P0/P1 逐条回代码复核，未复核的 P2 级条目未写入本报告正文（避免把未验证的怀疑固化进档案）。
- `docs/design/watchdog.md` 的「已知限制」章节质量很高——本轮两条看似缺陷的发现（abort 打不断工具）在那里已有明确登记，建议后续审计先读该节再下结论。
- **2026-11-05 复核修订（针对本报告自身，未改源码）**：① 头部推翻计数 4→5（§四 实列 5 条，原摘要漏计 §四-5）；② P1-5 的「待确认」已核实关闭（生产无 `retryDelaysMs` 注入点）；③ P0-1 修法由选项菜单收敛为定案（次数上限 + 永久 429 分类）；④ 原 P1-8 拆为 P1-8（落盘竞态）与 P1-9（生命周期窗口），故 P1 总数 8→9；⑤ §五 契约漂移结论补「未比对响应体」边界；⑥ 头部补「本报告是下限非全貌」声明。
- **2026-11-05 事实订正**：P1-6 原文「`tools/builtin/` 16 个工具」有误，实际 **15** 个（`tools/builtin/index.ts` 的 `getBuiltinTools()` 返回 15 项）。已改正文，不影响该条结论（「仅 5 个声明 `timeoutMs`」经复核仍准确）。
