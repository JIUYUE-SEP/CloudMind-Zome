# CMZ 全面 Review —— 第 5 块：数据持久化与生命周期

- 日期：2026-07-23
- 范围：main @ 1768e96，仅数据持久化与生命周期维度；只 review 不改代码
- 方法：通读 `services/engine/src/memory/**`、`src/mind/mind-files.ts`、`src/config/*`、`src/conductor/repository.ts`、`src/scheduler/repository.ts`、`src/blueprint/repository.ts`、`src/core/agent-worker.ts`、`src/api/ws/*`、`src/tools/builtin/*`、`crates/zome-sidecar/src/vector/mod.rs`、`src/lib.rs`、`proto/zome.proto`、`apps/desktop/src-tauri/src/sidecar.rs`，并对照 `docs/design/context-pipeline-v2.md`、`docs/架构文档.md` 的承诺逐项核验

---

## 一、数据资产清单

数据根目录：engine 侧 `CLOUDMIND_DATA_DIR || ~/.cloudmind-zome`（`services/engine/src/config/paths.ts:4-6`）；sidecar 侧 `CLOUDMIND_DATA_DIR || dirs::data_local_dir()/cloudmind-zome`（`crates/zome-sidecar/src/lib.rs:43-49`）。**两侧默认值不同**（详见删除域 M2）。

### 全局文件（DATA_DIR 根）

| 文件 | 格式 | 写入方式 | 版本字段 |
|---|---|---|---|
| `config.json` | 单个 JSON（`GlobalConfig`，apiKey 以 `enc:` AES-256-GCM 加密） | **裸 `fs.writeFile`，无 tmp+rename**（`config/repository.ts:119-121`） | 无 |
| `.master-key` | base64 主密钥（`crypto.ts:35-47`） | 一次性创建 | 无（不需要） |
| `sessions.jsonl` | JSONL（`Session`） | DocumentStore append/mutateLines | 无 |
| `blueprints.jsonl` | JSONL（`Blueprint`） | DocumentStore append/mutateLines | 无 |
| `skills/` | 目录（全局 Skill） | 人工放置 | — |
| `projects/{id}/` | 目录（code 模式项目根） | 工具写入 | — |

注：`架构文档.md:329-346` 的数据目录树未列出 `sessions.jsonl`，文档与实现有出入（小事，记录备查）。

### agents/{id}/ 下

| 文件 | 格式 | 写入方式 | 版本字段 |
|---|---|---|---|
| `agent.json` | 单个 JSON（`AgentConfig`，`packages/shared/src/index.ts:3-36`） | tmp+rename（`repositories/agent.ts:16` 经 DocumentStore.writeJson） | 无 |
| `SOUL.md` | Markdown 自由文本 | 创建时 `wx` 不覆盖（`mind-files.ts:194-208`）；之后无写入路径 | 无 |
| `MIND.md` | Markdown `##` 分块 + 块首 frontmatter（`source/created/confidence`） | tmp+rename，append-only（`mind-files.ts:305-343`） | 无 |
| `messages.jsonl` | JSONL（`ChatMessageRecord`，`repositories/types.ts:3-11`） | append + 压缩后 mutateLines 删除 | 无 |
| `messages_archived.jsonl` | JSONL（同 `ChatMessageRecord`） | **唯一写入点 append**（`repositories/message.ts:49`） | 无 |
| `_compressed/{topicId}.md` | Markdown frontmatter（`topic_id/embedding_id/label/importance/source_id/source_name/compressed_at/msg_count`）+ `## Summary` + `## Key Points` + `## Messages Archived` | tmp+rename（`topic/store.ts:47-54`） | 无 |
| `scheduler.jsonl` | JSONL（`ScheduledTask`） | DocumentStore | 无 |
| `memories.jsonl` | JSONL（`MemoryRecord`） | **当前无生产写入方**（仅接口与只读路由） | 无 |
| `actions.jsonl` | JSONL（`ActionRecord`） | **当前无生产写入方** | 无 |
| `llm_calls.jsonl` | JSONL（`LLMCallRecord`） | **当前无生产写入方** | 无 |
| `mind-failed.jsonl` | JSONL（失败经验 + `failedAt`） | 仅 MIND.md 写失败时 append（`mind-files.ts:344-360`） | 无 |
| `indices/hnsw/embeddings.jsonl` | JSONL（`{doc_id, embedding}`，`vector/mod.rs:109-113`） | sidecar append-only | 无 |
| `files/` | 目录（工具可写区） | write_file 工具 | — |
| `skills/` | 目录（agent 私有 Skill） | 人工放置 | — |

**结论：12 种落盘格式，无一携带格式版本字段；全仓 grep `schemaVersion|formatVersion|format_version` 零命中。唯一的兼容痕迹是 `AgentConfig.model // fallback for old configs`（`index.ts:13`）和 agent.json 缺 id 时以目录名强制补齐（`agent.ts:97-98, 129`）。**

---

## 二、落盘格式与版本迁移

### Major — M4：全部格式裸奔，无版本字段、无迁移机制、无旧格式探测

证据：
- 消息/归档记录 `ChatMessageRecord`（`repositories/types.ts:3-11`）、压缩档 frontmatter（`topic/store.ts:22-46`）、MIND.md frontmatter（`mind-files.ts:93-105`）、向量记录（`vector/mod.rs:109-113`）、`AgentConfig`、`GlobalConfig`——均无 version。
- 没有任何迁移代码路径；读取侧也没有"格式过旧"的探测与告警。压缩档解析（`topic/store.ts:124-148`）靠正则抠字段，key 改名或结构调整即静默读空（`compressed_at` 缺失直接判废档，`store.ts:132-133`）。
- 目前格式演进靠"只加 Optional 字段"的默契维持。对以月/年计生命周期的产品，第一次需要改语义（如 `content` 结构变化、frontmatter key 改名、embedding 维度/模型更换）就没有任何平滑路径：老数据要么静默读不出，要么需要用户手工处理。这正是 brief 点名的"格式变了老数据读不了"场景，当前完全无防线。

### Minor — agent.json 损坏时 agent 从列表静默消失

`AgentRepository.list()` 对单个 agent.json 解析失败仅 `console.error` 后跳过（`repositories/agent.ts:124-132`），用户在 UI 看到"agent 没了"，无任何提示；而 `get()` 路径（`agent.ts:27-30`）则直接抛错。两条路径的失败表现不一致，且都不可恢复（无 quarantine/备份原文件动作）。

### Minor — readJson 10MB / readLines 100MB 硬上限与只增文件相冲

`document-store.ts:59`（JSON 10MB）、`document-store.ts:121`（JSONL 100MB）超限直接 throw。`messages_archived.jsonl` 只增不减（见增长域 M9），撞线后 `getArchivedByIds`（最后防线）变为永远抛错，且无任何前置告警。

---

## 三、归档不可变性

### 验证通过：messages_archived.jsonl 确实只有 append 路径

- 全仓唯一的归档写入点是 `repositories/message.ts:48-50` 的 `archiveStore().appendLine` 循环；grep 全仓无任何对 `messages_archived.jsonl` 的改写/删除/截断路径。
- 工具层无法触碰：`write_file` 被限制在 `agents/{id}/files/` 内且挡 `..` 逃逸（`tools/builtin/write.ts:31-43`）；`bash` 工具白名单仅 `ls/cat/echo/pwd/mkdir/touch` 且拒绝全部重定向/管道元字符与斜杠（`tools/builtin/bash.ts:6-37`）；`edit_file` 仅作用于 projectRoot（`tools/builtin/edit_file.ts:47`）。`PROTECTED_FILES` 名单（`write.ts:7-15`）虽未列 `messages_archived.jsonl`，但 files/ 目录隔离已构成实际防线。

### Major — M5：设计承诺的每周审计机制完全未实现

- 设计决策 4 原文："每周校验归档消息都有对应压缩档，缺失则告警"（`docs/design/context-pipeline-v2.md:324`）。代码中不存在任何周期审计；`docs/reviews/2026-07-21-phase2-review.md:25` 已记为 Major-3，本次复核仍未补。
- 且设计口径与现状有内在矛盾：`archiveOnly` 短话题归档时**本来就没有压缩档**（`topic/types.ts:13-17`、`tracker.ts:67-82`），按设计字面执行会把所有短话题归档误报为异常。审计机制落地前需要先重定义口径（如：归档行需能被"压缩档 msgIds ∪ archiveOnly 标记"覆盖）。

### Minor — 归档 ↔ 压缩档双向对账均缺位

现有 reconcile 只覆盖"压缩档有 id、热存储有残留"一个方向（见对账域）。反方向——"归档有行但压缩档丢失"（`getArchivedByIds` 恢复路径的触发条件）、"压缩档有 id 但归档缺行"——都没有任何校验，恢复能力是否真实可用处于未验证状态（`docs/design/context-pipeline-v2.md:399` 的"用户可审计接口/恢复归档"也仍是 `[ ]`）。

---

## 四、启动对账（src/memory/reconcile.ts）

### 覆盖范围（实现与注释一致）

- 覆盖：压缩档已写入但 `archiveAndRemove` 未完成的孤儿（`reconcile.ts:20-34`）。**是修复型**（实际调用 `archiveAndRemove` 补归档），不只是报告。
- 运行时序正确：engine 启动时、scheduler/worker 产生新流量前执行（`bootstrap.ts:253-268`），单 agent 失败仅 warn 不阻断启动；`ZOME_STARTUP_RECONCILE=false` 可关。
- 无压缩档时零开销短路（`reconcile.ts:25-26`）。

### Major — M6：重启孤儿消息永不归档，且无优雅关停放大该窗口

- tracker 状态纯内存（`tracker.ts:10-13` 注释自认）：进程退出时仍在未关闭话题里的消息，没有任何压缩档指向，reconcile 明文声明不覆盖（`reconcile.ts:11-12`）。重启后 tracker 重新计数，这批消息永远留在热存储、永不压缩、永不离场。
- 放大因素：engine **没有任何 SIGTERM/SIGINT 处理**，`CompressionQueue.drain()`（`queue.ts:21`）在生产代码中零调用（grep 仅见定义与测试）——每次正常退出都丢弃压缩队列 pending 项，与崩溃同等制造孤儿。热存储因此随重启次数单调增长，与 Phase 2 验收标准"热存储消息数控制在合理范围"持续偏离（2026-07-21 review M1 已记一半，重启孤儿这半至今无解）。

### Minor — reconcile 会制造归档重复行

崩溃发生在"归档 append 完成、热存储删除未完成"之间时，reconcile 把已在归档里的消息再 append 一遍。注释（`reconcile.ts:14-16`）自认只影响体积、读取侧按 id 过滤不受影响——属实，但归档体积因此加速膨胀，且"重复行只多不少"没有任何清理路径。

### Minor — 索引孤儿不在任何对账范围

向量索引中 doc_id 指向已删除消息/已删除 agent 的条目无清理机制（sidecar 无 Delete，见删除域 M3）；L4 对已归档原文的排除依赖压缩档 msgIds 而非归档本身（`topic/store.ts:69-75`），`archiveOnly` 消息无档可被检索到（注释认定为预期行为，记录备查）。

---

## 五、写入可靠性

tmp+rename 覆盖盘点：**已覆盖** agent.json、MIND.md、压缩档、以及所有 DocumentStore `writeJson`/`mutateLines` 用户（messages 热存储删除、sessions、scheduler、blueprints、actions 更新）。**未覆盖**见下。

### Major — M7：config.json 裸写 + load() 静默吞错 = 配置可静默清零

- `ConfigRepository.save()` 直接 `fs.writeFile`（`config/repository.ts:119-121`），无 tmp+rename——全仓唯一的高价值裸写文件。
- `load()` 用一个大 catch 吞掉**所有**错误返回默认配置（`repository.ts:79-100`）：文件半截（崩溃/断电）→ 解析失败 → 静默返回"空 providers 默认配置" → UI 显示 provider 全消失 → 用户任何一次保存就把默认配置写回，**加密前的 apiKey 永久丢失**。从"写到一半"到"永久丢失"只需一次后续 save，中间无告警、无备份、无 quarantine。

### Major — M8：消息按 turn 级批量落盘，崩溃丢整轮

`runTurn` 的产出（最多 5 步的 assistant/tool 消息）在 turn 全部结束后才逐条 append（`agent-worker.ts:328-336`）。turn 进行中崩溃：用户消息安全（WS 侧先落盘，`session-handler.ts:169-177`、`handler.ts:152-158`），但整轮输出与已消耗的 LLM 调用全部丢失，且热存储里留下"用户问了、没有回答"的悬空尾。窗口 = 整轮时长（秒到分钟级）。

### Minor — append 无 fsync，且存在半行撕裂窗口

`appendLine` 走 `fs.appendFile`（`document-store.ts:82-87`），无 fsync：OS 级崩溃/断电可丢 page cache 内最近写入（全链路仅 sidecar 的 embeddings 明示接受此事，`vector/mod.rs:76-79`；消息存储未做同等声明）。进程级崩溃若恰好打在 append 中途会留半行，读取侧跳过坏行（`document-store.ts:148-152`）——数据损失限定为该一条，但只记 `console.error`，无计数无告警。

### Minor — 用户消息落盘失败仍继续对话

私聊路径 persist 失败仅报错后继续 enqueue（`api/ws/handler.ts:152-167`）：本轮对话正常进行，但这条用户消息永久不在记忆里，且 agent 上下文里有它（内存传入）、记忆里没它——后续压缩/检索出现"记得一段不存在的对话"的轻微不一致。群聊路径（`session-handler.ts:169-177`）同构。

---

## 六、删除与清理

### Major — M2：sidecar 与 engine 默认数据目录分离，删除级联漏掉向量索引

- engine 默认 `~/.cloudmind-zome`（`paths.ts:5`）；sidecar 默认 `dirs::data_local_dir()/cloudmind-zome`（`lib.rs:43-49`，Windows 即 `%LOCALAPPDATA%\cloudmind-zome`）。Tauri 启动 sidecar 时不设 `CLOUDMIND_DATA_DIR`（`apps/desktop/src-tauri/src/sidecar.rs:26-34`），全仓 grep 无任何生产设置点（仅测试与 e2e 脚本设置）。
- 后果一：`AgentRepository.delete` 的 `rm -rf agents/{id}`（`repositories/agent.ts:110-112`）在 desktop 环境下**删不到向量索引文件**，`embeddings.jsonl` 成为磁盘孤儿。
- 后果二：`架构文档.md:345` 把 `indices/hnsw/` 画在 engine 的 DATA_DIR 树下，与实际部署不符——按文档做备份/清理必然漏一份。
- 后果三：备份只拷 `~/.cloudmind-zome` 会漏掉向量索引（可重建，降级为 Minor 级影响，但无人知道它不在里面）。

### Major — M3：sidecar 无删除通路，同名重建 agent 旧记忆复活

- proto 只有 `Upsert/Search/CountTokens/Encrypt/Health`（`proto/zome.proto:4-10`），无 Delete；engine 的 `SidecarClient` 同样只有 Health/Upsert/Search（`sidecar/client.ts:32-48`）。
- sidecar 侧 `INDEX_CACHE` 进程级常驻、无失效入口（`vector/mod.rs:115-159`）。时序：删除 agent A（文件已 rm）→ sidecar 未重启 → 重建同名 agent A → 首次 upsert/search 命中缓存里的**旧向量全集**，旧的语义记忆直接复活，并随新 upsert 把旧向量重新 append 进新建的 `embeddings.jsonl`。"删除心智"在语义层不可达成。

### 已验证的级联覆盖（同树内）

agent.json、messages*.jsonl、_compressed/、MIND/SOUL、scheduler.jsonl、mind-failed.jsonl、files/、skills/ 均在 `agents/{id}/` 下，`rm -rf` 一次清净；sessions.jsonl 中残留的 agentIds 有优雅降级（`session-handler.ts:180-192` 过滤失效成员并明确报错）；`agentRepository.onChange` 会停掉存活 worker（`bootstrap.ts:66-73`）。

### Minor — DocumentStore 模块级缓存/队列的惰性清理

`readCache`/`writeQueues` 按文件路径常驻（`document-store.ts:8,17`），目录被 rm 后靠下一次 readLines 的 ENOENT 分支清缓存（`:124-127`）、写队列 settle 自清（`:49-52`）。无泄漏，但删除即刻的短暂窗口内同名重建 agent 可能读到一份陈旧的 structuredClone 缓存（需同尺寸同 mtime 才命中，概率极低，记录备查）。

---

## 七、备份与恢复

### Minor — 无备份/恢复文档，无机制

grep `docs/` 的"备份/backup/restore"无任何操作文档（唯一提及是历史 spec 的"提示用户备份后清空"，`docs/superpowers/specs/2026-06-24-js-rewrite-design.md:41`）。对"记忆连续性是命根子"的产品，用户目前只能靠口口相传自己猜要拷什么。

备份最小集（据代码推定）：`config.json` + **`.master-key`**（缺它则 config.json 中 `enc:` apiKey 永久不可解，`config/crypto.ts:35-47`）+ `sessions.jsonl` + `blueprints.jsonl` + `agents/{id}/` 整目录；desktop 下另需 sidecar 数据树（见 M2）。恢复在纯文件格式下可行（拷回即可，agent.json 缺 id 会被纠正），但没有任何验证过的流程。

### 单文件损坏降级（整体较好，已逐类验证）

- JSONL 坏行：跳过坏行继续读，记 `console.error`（`document-store.ts:148-152`）——压缩档坏一行级别的事故不会扩散。
- 压缩档 frontmatter 损坏：单档判废跳过，不影响其他档（`topic/store.ts:123-133`；`latestSummaries` 逐档 try/catch，`:171-178`）。
- embeddings.jsonl 坏行：跳过（`vector/mod.rs:142-147`）；向量索引整体故障时 L4 按空降级且**明确告知**"记忆检索暂时不可用"（`agent-worker.ts:241-271`，不静默）。
- MIND.md：纯文本 + 宽松解析，无"损坏"概念；SOUL.md 读取失败回默认模板（`mind-files.ts:71-80`）。
- 两个例外即前述 Major/Minor：config.json 损坏=静默重置（M7）；agent.json 损坏=列表静默消失。

### Minor — mind-failed.jsonl 只写不读，是坟场不是机制

MIND.md 写失败的经验批次转入 `mind-failed.jsonl`（`mind-files.ts:344-360`），注释定位是"防永久丢失"。但全仓**没有任何读取/回放/告警路径**——经验确实没丢在内存里，但也没有任何人或代码会再看它一眼。离"可恢复"差最后一公里。

---

## 八、数据增长

| 文件 | 增长曲线 | 有界性 |
|---|---|---|
| `messages.jsonl`（热存储） | 名义有界（20 条阈值/30 分钟窗压缩），实际随重启次数 +ε（M6 孤儿累积） | 弱有界 |
| `messages_archived.jsonl` | 每条消息终身进一次，只增不减；reconcile 重复行再加速度 | **无界** |
| `_compressed/*.md` | 每话题一文件，只增 | 无界（读取侧按文件名取前 N，`store.ts:165-169`，可控） |
| `indices/hnsw/embeddings.jsonl` | 每条消息一行（1536 维 float JSON ≈ 10-20KB/行），同 doc_id 重复 upsert 只加不压 | **无界，且全量入内存** |
| `MIND.md` | append-only，Jaccard 合并减缓但不封顶 | 无界 |
| `sessions.jsonl` / `blueprints.jsonl` / `scheduler.jsonl` | 随用户操作缓增 | 实际有界 |
| `memories/actions/llm_calls.jsonl` | 无生产写入方，零增长 | — |

### Major — M9：embeddings.jsonl 无界增长且首次使用全量载入内存

`get_or_load` 把整个文件读进 `HashMap`（`vector/mod.rs:140-148`），文件 append-only、同 doc_id 后行覆盖前行的去重只发生在加载时，磁盘上永不 compaction（`:76-106`）。以月/年计：10 万条被索引消息 ≈ GB 级文件 + 等量级常驻内存 + 每次启动全量解析。没有淘汰、没有压缩、没有分片。这是所有增长曲线里最先失控的一条。

### Major — M10：messages_archived.jsonl 只增不减，撞 100MB 上限后"最后防线"反转

归档是压缩档损坏时的恢复来源（设计定位），但它自身无轮转、无压缩、无清理；`readLines` 100MB 硬上限（`document-store.ts:121-123`）撞线后 `getArchivedByIds` 永远抛错——最需要它的恢复场景（多年后）恰好是它已不可用的场景。以年计的使用下这不是理论风险。

### Minor — MIND.md 每轮对话全量读+解析，无缓存

`loadMindChunks` 每轮全量 `fs.readFile`（`mind-files.ts:137-146`，调用点 `agent-worker.ts:279`），未复用 DocumentStore 的 mtime 缓存。经验 append-only 增长下，每轮 I/O 成本单调上升（量级小，优先级低）。

---

## 九、崩溃数据丢失窗口分析

按崩溃点逐一枚举（进程级崩溃，除第 8 条外）：

| # | 崩溃点 | 丢失内容 | 窗口 | 恢复路径 |
|---|---|---|---|---|
| 1 | 用户消息已落盘、turn 进行中 | 整轮 assistant/tool 输出（≤5 步）+ 已耗 token；用户消息安全，热存储留悬空问句 | 整轮时长（秒~分钟） | 无（M8） |
| 2 | `result.appended` 逐条 append 循环中 | 当前条可能半行撕裂（该条丢失），已 append 的保留；无重复风险 | 单条消息 | 坏行读取时跳过（`document-store.ts:148-152`） |
| 3 | 压缩队列有 pending 时退出/崩溃 | segment 丢失；**消息不丢**，留在热存储但永不压缩（重启孤儿） | 队列积压量 | 无（M6；`drain()` 生产无调用） |
| 4 | `writeCompressedTopic` 与 `archiveAndRemove` 之间 | 不丢数据；压缩档在 + 原文在热存储 → 摘要与原文重复注入 | 直到下次启动 | **reconcile 启动补归档，已闭环**（`reconcile.ts`） |
| 5 | `archiveAndRemove` 中途 | 不丢数据；归档重复行（体积代价） | — | reconcile 重归档（重复行无清理） |
| 6 | MIND.md 写（tmp+rename 保护本体） | 本批经验转 `mind-failed.jsonl`；若 sidecar 也写失败则本批丢失 | 单批经验 | 无回放（坟场，见上） |
| 7 | `config.json` save 中 | 文件半截 → 下次 load 静默回默认 → 再 save 永久覆盖，**provider 配置与 apiKey 全丢** | 一次 save 到下一次 save | 无（M7，全仓最危险的单点） |
| 8 | OS 级崩溃/断电 | page cache 内最近写入全部可丢（**全链路无 fsync**）：消息、归档、压缩档 rename 前的 tmp、embeddings | 秒~分钟级 | 仅 embeddings 明示接受（`vector/mod.rs:76-79`），消息存储无声明无措施 |
| 9 | 正常退出 | 无 SIGTERM/SIGINT handler，压缩队列丢弃同 #3 | 队列积压量 | 无 |

归纳：**"已提交到磁盘的数据"在进程级崩溃下基本安全**（先归档后删除、tmp+rename、reconcile 三件套有效）；真正的丢失窗口集中在三处——turn 级批量落盘（#1）、config.json 裸写（#7）、无 fsync 的 OS 级窗口（#8）——外加一个"不丢但也不前进"的压缩队列（#3/#9）。

---

## 十、总评：记忆连续性承诺目前能兑现到什么程度

**兑现到"单进程内、进程级故障"的级别；离"以月/年计"还差一整层耐久性基础设施。**

值得肯定的是核心链路的崩溃安全设计是有章法且落地的：先归档后删除（`message.ts:47-51`）、tmp+rename 普及、启动对账闭环了"压缩档已写归档未做"这一最阴险的中间态、坏行/坏档逐点降级不扩散、归档 append-only 在代码层面经得起 grep 验证。单点进程故障下，已落盘的记忆基本丢不了。

但对照"会话以月/年计"的承诺，四处硬伤都在时间维度上：

1. **格式无版本、无迁移（M4）**——12 种格式全部裸奔。第一年不出事是因为格式还没变过；第一次格式变更就是命根子事故，且届时连"哪些数据是旧格式"都探测不了。
2. **config.json 一个文件能静默清空全部 provider 配置（M7）**——裸写 + 吞错回退默认，从崩溃到永久丢失只需用户再点一次保存。
3. **向量索引在 desktop 下落错了树（M2）且删不掉（M3）**——删除级联和备份都漏它；"删除一个心智"在语义层目前不可达成。
4. **增长无治理（M9/M10）**——归档、向量索引、MIND.md 全部只增不减，读取路径上的 100MB 上限和全量入内存会在"年以计"的尺度上逐一引爆，而最依赖它们的恢复场景恰好排在引爆点之后。

次一级的缺口：每周审计承诺两年度的 review 里挂了两次仍未实现（M5）；重启孤儿 + 无优雅关停让热存储持续漏（M6）；turn 级落盘粒度（M8）；备份恢复零文档；mind-failed.jsonl 只写不读。

**分级计数：Blocker 0，Major 9（M2/M3/M4/M5/M6/M7/M8/M9/M10），Minor 11。**

无 Blocker 的含义仅是没有"今天就会丢已提交数据"的缺陷；Major 群里的每一条都直接咬在"记忆连续性"承诺上，建议按 M7（改起来最小、损失最大）→ M4（越早定义版本字段越便宜）→ M2/M3 → M6 → 其余的序处理。
