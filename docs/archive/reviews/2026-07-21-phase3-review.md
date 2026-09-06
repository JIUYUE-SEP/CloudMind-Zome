# Phase 3（L4 语义检索迁入管线）Review 报告

日期：2026-07-21
范围：commit `e8e13ed`（Phase 3 全部改动）
方法：独立审查 agent 全量读码（含 sidecar Rust 源码）+ 主会话对关键发现逐条复核

## 一、架构正确性

**迁移本身是正确的**：分层类型（`SemanticMemory[]`）、预算计数、降级顺序（L5→L4→L6ext→L3 不变）、与 Phase 2 归档的衔接（归档原文不进 L4）、AgentConfig 透传、bootstrap 条件构造（Mock embedder 不建 indexer）都处理得当；旧的 prepend 检索块删除彻底，检索结果从"占消息位、不进预算"变为"system 注入、参与预算与降级"是正确方向。

**与文档符合度**：Phase 3 清单（`context-pipeline-v2.md:363-371`）逐项可对应（memory flush 除外，已标注留 Phase 4）。

**但存在一个文档与底层由来已久的错位**：文档、注释、测试全部假设 sidecar 返回"相似度"，而 sidecar 实际返回**距离**。这在 Phase 3 之前无害（旧代码只用 hit id、从不读 score），Phase 3 首次消费 score，把它从"无害"变成"功能反转"（见 Blocker）。

## 二、代码质量

检索器职责清晰（候选 → 去重 → 归档排除 → 打分 → 过滤 → topK），错误处理与项目惯例一致（indexer 全路径吞异常返回 []、worker 层 catch 静默降级）。excludeIds 与 L3 精确对齐（job.messages 恰为 listBySession(limit:20)），不存在与 L3 重复注入；repo 查无此条的路径静默跳过，行为正确。

主要质量缺口：score 语义未在边界处定义/换算（Blocker）；新增了一次无界增长的每轮全量读（Major）；若干小防御缺失（Minor）。

## 三、测试覆盖

新增 18 个测试，断言质量本身尚可（有精确数值断言与 search 入参验证），但存在一个系统性问题：

1. **全部 mock 编码了错误的 score 语义**（`semantic.test.ts:82-97,139-151`、`agent-worker.test.ts:700-703`）：测试把"大 score = 好结果"当前提，与真实 sidecar 完全相反——这是 Blocker 能穿过全部测试的直接原因。修复后这批用例的期望必须同步翻转，并加"sidecar score = 距离"注释防回归
2. 缺"索引命中但 repo 查无此条"的部分缺失用例
3. 缺 sidecar 不可用 / indexer 抛异常 / repo 抛异常路径
4. 边界值未测：minScore=1、topK=1、normalize 的 NaN 输入
5. 工具消息（role=tool 的大文本）被索引并被注入 L4 的场景未测

## 四、发现的问题

### Blocker

**B1. 打分管线整体反转：sidecar 返回的是距离，不是相似度**

证据链（主会话已逐条复核）：

- `crates/zome-sidecar/src/vector/mod.rs:17-19`：`Point::distance = 1.0 - cosine_similarity`
- `vector/mod.rs:39-42`：HNSW 路径返回 `result.distance`（就近迭代取 top_k）
- `vector/mod.rs:62-66`：线性兜底同样算 `1.0 - cosine` 并**升序**排序取 top_k（`sort_by(|a,b| a.1.partial_cmp(&b.1))`）
- `server.rs:52`：原样透传为 `SearchResult.score`；`sidecar/client.ts` 原样映射，无任何换算

即 score 域为 [0, 2]，**0 = 完全相似，越小越好**。而 `semantic.ts:101-111` 把它当相似度用，三重反转叠加：

1. **排序反转**（`:111`）：sidecar 已按距离升序返回最近邻，`sort(desc)` 后 `slice(0, topK)`——实际注入的是候选集中**最不相似**的 topK 条
2. **minScore 过滤反转**（`:102`）：用户设 `semanticMinScore=0.5` 时，距离 < 0.5（相似度 > 0.5）的最佳命中全部被丢弃（仅默认 minScore=0 时恰好无害）
3. **时间衰减方向反转**（`:101`）：衰减系数乘在距离上，越旧的记忆距离越小 = 排得越靠前，与设计决策 5"早期记忆不应快速衰减"意图正好相反

**修复**（很小）：在 `MemoryIndexer.search` 出口换算 `similarity = 1 - distance` 并改注释（该边界目前只有 SemanticRetriever 一个消费者，旧代码从未读过 score，无其他影响面）；或在 `SemanticRetriever.retrieve` 内换算。换算后现有打分/过滤/排序/clamp 全部自然成立；测试期望同步翻转。

### Major

**M1. 每轮两次全量文件读，归档文件无界增长**

`semantic.ts:88-91` 每轮检索调用 `getByIds` + `getArchivedByIds`，两者都是全量 `readLines`（`message.ts:34-39, 54-59`）。归档只追加不清理，随时间线性膨胀；叠加每轮 L5 `latestSummaries` 与 `listBySession`，单聊天 turn 的 JSONL 全量解析达 3-4 次，对验收标准"assemble 延迟 < 100ms"构成现实风险。

建议：归档排除改用压缩档 frontmatter 的 msg_ids 做索引（不必读归档全文），或给 MessageRepository 加 id→offset 缓存。属既有模式的技术债，但归档全量读是本 Phase 新增的唯一无界项，建议至少留 issue 跟踪。

### Minor

1. **死配置 `semanticCandidateCount`**（`pipeline.ts:16,23`）：全 src 仅声明处出现，实际候选数是 `SemanticRetriever` 的 `topK * 2`。建议删除或接线
2. **检索命中的超长内容无截断注入**（`semantic.ts:50-56`）：索引侧 embed 有 MAX_INDEX_CHARS=2000 截断，注入侧没有；role=tool 的工具结果（可达数十万字符）会被全量注入。建议注入前同样按 2000 字符截断
3. **`normalizeSemanticSearchConfig` 不防 NaN / 非整数**（`semantic.ts:28-33`）：NaN 穿透比较，非整数 topK 会以 float 传给 gRPC。一行 `Number.isFinite` + 取整可解决
4. **`enabled=false` 只关检索、不关索引**（`agent-worker.ts:300-311`）：功能"关闭"时每轮 embed 成本仍在发生。建议字段注释写明，或 enabled 同时门控 `indexMessage`
5. **同场景命中无来源标注（观察项）**：prepend 改 system 注入后丢失 role 信息，模型无法区分"窗口外同场景记忆"与 L3。可接受，建议 assembler 头注说明

## 五、建议

**结论：不可合并于现状，需先修 B1。** 修复前 L4 在真实 sidecar 下注入的是候选集中**最不相关**的片段，且 minScore 越高效果越差——比没有检索更糟。但修复量很小，修复后本 Phase 即可达到设计意图。

修复顺序：

1. **B1**（立即）：`MemoryIndexer.search` 出口换算 `similarity = 1 - distance`（或 retriever 内换算）+ 翻转全部受影响测试期望 + 统一注释口径（indexer/client/shared/设计文档注明 sidecar 原始返回为距离）
2. Minor 同批顺手：语义转换后补上 minScore=1/topK=1/NaN 边界测试；注入前 2000 字符截断；删 `semanticCandidateCount` 死字段
3. **M1** 可合并后跟踪：归档排除改压缩档索引或 repo 缓存（与 Phase 2 review 的 M1 热存储 I/O 同属 JSONL 全量读技术债，建议合并为一个 issue）
4. 观察项：`enabled` 是否同时门控索引、同场景命中的标注形态，作为产品决策单独确认
