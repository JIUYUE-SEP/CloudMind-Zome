# Phase 2（话题压缩）Review 报告

日期：2026-07-21
范围：commit `7561f29`（topic 模块 + 归档）与 `9838e61`（集成）的全部改动
方法：独立审查 agent 全量读码 + 主会话对 Major/疑点逐条复核（含 scheduler、subagent 链路验证）

## 一、架构正确性

**与设计文档的符合度（§五 Phase 2 清单 7/7 落地）**

- 规则版检测（时间窗 30min / 数量阈值 20 / 显式切换词，保守不切）✅
- LLM 单程压缩（摘要 + 关键点，解析兜底，失败不 fallback）✅
- 后台串行压缩队列（fire-and-forget）✅
- `_compressed/*.md` 落盘（frontmatter，embedding_id 预留）✅
- 热存储清理（先归档 `messages_archived.jsonl` 再移除，可恢复）✅
- L5 注入组装（`topicSummaries` → layers.l5，降级顺序不变）✅
- agent 级配置（compressionModel / topicDetectionWindowMinutes / topicMessageThreshold）✅

**偏离点（3 处良性，2 处需确认）**

- 触发点实际接在 worker `processQueue` 而非设计写的 `runTurn` 入口——更合理（能拿到 lastUser 与持久化时机），良性
- tracker 不按 session 分桶、sourceId 取"关闭时所在场景"——单流简化，良性但归属弱（见 Minor-5）
- `AgentConfig` 未暴露 `enabled` / `hotMemoryCount`——设计验收"所有阈值可调"只达成一半（Minor-8）
- 压缩模型缺省回退主模型，与决策 2"必须指定，不用主模型"表述冲突（Minor-9，需确认是有意修订还是文档未同步）
- 决策 4 的周期对账（每周校验归档↔压缩档）**完全未实现**（Major-3）

**衔接正确性**：L5 在降级序列最前（先 merge/drop 再动 L3）与 Phase 1 一致；`turn.end` 语义（P1-4）与压缩触发无冲突；`AgentConfig` 新字段全可选，web 端 typecheck 无破坏。

## 二、代码质量

模块职责单一（detector/tracker/compressor/store/queue），错误处理策略一致：坏档跳过、LLM 失败不阻断对话、先归档后删除、L5 读取失败降级为空。值得肯定的具体处理：

- `archiveAndRemove` 先写归档再删热存储，任何一步失败不丢消息
- 压缩解析失败有"（未命名话题）"+ 原文兜底，不让坏输出阻断归档
- `latestSummaries` 单档损坏跳过不中断，目录不存在返回空

主要质量缺口集中在**存储边界与配置校验**（见下节），另有若干注释/日志与实际行为不符（tracker 重启注释、queue 的 drain 注释、归档失败日志只说了一半）。

## 三、测试覆盖

新增 33 个测试（detector 8 / tracker 6 / compressor 4 / store 6 / repo 归档 4 / pipeline 3 / worker 集成 2），engine 全量 402 通过。单元层覆盖良好；集成层有实质缺口：

**发现的测试问题**

1. **空洞断言**（`tests/core/agent-worker.test.ts:556-557`）：`expect(archived.length).toBeGreaterThanOrEqual(0)` 恒真，等于没断言；且同 test 内 `archivedAssistant` 与前一行重复断言。应断言被归档的 assistant 消息 id 可通过 `getArchivedByIds` 取回
2. **user 消息归档未端到端验证**：集成测试里 u1/u2 未持久化（worker 只持久化 appended），"热存储归档"实际只验证了 assistant 消息——恰好掩盖了 Major-2 这类 id 失配 bug
3. **关键路径缺失**：压缩 LLM 失败的 worker 级测试、archiveAndRemove 失败中间态、时间窗触发的 worker 集成、多 segment 串行排队、配置边界（threshold<4、window=0）、`l5:merge` 步骤（生产默认 hotMemoryCount=2 时第一个命中的降级步骤，零覆盖）

## 四、发现的问题

**Blocker**：无。

### Major

**M1. 热存储实际无界：短话题丢弃 + 重启孤儿消息永不被归档**
`src/memory/topic/tracker.ts:64-68`
`closeSegment()` 对 <4 条的话题直接丢弃（日常闲聊大量命中）；进程重启后 tracker 内存清空，重启前的消息成为孤儿，唯一清理路径（压缩归档）永远触达不到。叠加 `listBySession`/`archiveAndRemove` 每次全量读文件（`message.ts:24,44`），每轮对话 I/O 随使用时间单调增长——与 Phase 2 验收"热存储消息数控制在合理范围"直接冲突。tracker 注释"由下一轮话题关闭时自然覆盖"对重启孤儿不成立（注释错误）。
建议：短话题不压缩但仍归档（无摘要归档或热存储行数上限）；修正注释；归档/读取路径后续改索引化。

**M2. 定时任务 user 消息 id 失配，永远无法归档（确定性 bug）**
`src/scheduler/scheduler.ts:81` vs `src/core/agent-worker.ts:110-116`
scheduler 构造的 user 消息 id 为 `sched_${Date.now()}`（tracker 跟踪此 id），但 `runScheduledTask` 持久化时另造 `randomUUID()`。压缩后 `archiveAndRemove(msgIds)` 拿 `sched_*` id 匹配热存储必然 miss——该 user 消息永远滞留，压缩档 msgIds 永久悬空。每次 scheduler 话题被压缩必现。
建议：`runScheduledTask` 持久化保留原消息 id（与 ws 路径对齐）。

**M3. "压缩档已写、归档未做"中间态无自愈，永久性 L5/L3 重复**
`src/memory/topic/queue.ts:13-18`
队列顺序为写压缩档 → 归档。归档抛错或进程在两者之间崩溃：压缩档已存在、原文仍在热存储，此后每轮 assemble 同时注入摘要与原文，且不重试；设计决策 4 的周期对账未实现，`getArchivedByIds` 无生产调用方。
建议：归档失败时隔离（删除/改名）对应压缩档；或启动时对账"压缩档 msgIds ∩ 热存储"并补归档。

### Minor

1. **`l5:merge` 在 token 计数上等效空操作**（`assembler.ts:27-31` 已 join 成单条 system 消息，merge 只省一个分隔符），且生产默认 hotMemoryCount=2 时它是第一个命中的降级步骤，零测试覆盖。建议删除或改为"逐条丢弃最旧摘要"
2. **配置无边界校验**：`topicMessageThreshold < 4` 时压缩永不发生（全部被最短条数丢弃）且无告警；`windowMinutes <= 0` 每条消息都切话题。建议 clamp + warn（`bootstrap.ts:158-166`、`tracker.ts:58`）
3. **压缩档写入非原子**：`store.ts:48` 直接 `writeFile`，未复用项目已有的 tmp+rename（`document-store.ts:82`），崩溃半截文件可能 frontmatter 完整而正文残缺，照常被注入
4. **`latestSummaries` 每轮全量 readdir + 读全部档再排序**（`store.ts:84-104`）：topicId 自带时间戳，可按文件名倒序先取 N 再读
5. **subagent/scheduler 流量混入私聊话题流**（`bootstrap.ts:89-98` 共用同一 worker）：tracker 不按 session 分桶；私聊 sourceId 恒为 "default"、`sourceName` 两处调用从不传，压缩档归属信息在生产路径上实际是死的；tracker 测试还把混桶行为当 spec 固化了。建议 subagent job 跳过 tracker，sourceName 从 session 元数据补
6. **`enabled=false` 时 tracker 内存泄漏**（`tracker.ts:31-34`）：禁用分支仍 push 且永不清空。应直接 return
7. **压缩超时未中止底层 LLM 流**（`compressor.ts:35-50`）：timeout 只 reject 外层，内部迭代继续消费 provider 流，泄漏一次 HTTP 连接
8. **`hotMemoryCount` 双份定义**：`ContextPipelineConfig.hotMemoryCount`（`pipeline.ts:14`）从未被读取，实际生效的是 `topicConfig.hotMemoryCount`；`AgentConfig` 未暴露 enabled/hotMemoryCount，设计验收"阈值全可调"只达成一半
9. **压缩模型缺省用主模型，与决策 2 表述冲突（存疑）**：决策原文"必须指定，不用主模型"；实现缺省回退主模型。有意修订则应更新设计文档
10. **进程退出不等待压缩队列**：`queue.ts:21` 注释自称"进程退出前使用"，但无退出钩子调用 `drain()`，在途任务随退出丢失（消息安全，仅白费一次 LLM 调用）
11. **`getArchivedByIds` 零生产调用方**：决策 4 的"最后防线"目前只是接口声明

## 五、建议

**合并结论**：架构与上下文路径正确，可以合并；但三个 Major 都直接削弱 Phase 2 的核心验收目标"热存储有界"，且 M1/M2 随使用时间持续放大每轮 I/O，**建议进入 Phase 3 前优先修复**。

修复优先级：

1. **M2**（一行修复，确定性 bug）：`runScheduledTask` 保留原消息 id + 补端到端归档测试（覆盖测试问题 2）
2. **M1**（设计决策）：短话题归档策略（无摘要归档或热存储行数上限），修正 tracker 注释
3. **M3**：归档失败隔离压缩档；启动对账可与决策 4 周期校验一起做
4. Minor 批量：m1 删/改 l5:merge（顺带补测试）、m2 配置 clamp、m6 禁用即 return、m4 文件名倒序取 N、m3 原子写、测试空洞断言（测试问题 1）
5. 待确认：m9 压缩模型缺省策略是否修订设计文档；m8 hotMemoryCount/enabled 是否开放 agent 级配置
