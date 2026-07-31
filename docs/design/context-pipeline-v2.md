# ContextPipeline v2 设计文档

> 版本：v2 | 日期：2026-07-17（2026-07-22 更新状态） | 作者：维克托（为 TS 重写整理）
> 参考：Python 遗留实现（commit f390431^ 之前）、grok-build compaction 设计
> 状态：**Phase 1/2/3/5/6/7 已实现**（Phase 1 见 `docs/reviews/2026-07-17-context-pipeline-phase1-review.md`）；Phase 4（可选）待评估
> 注：实现期曾短暂引入 L1.5（平台能力层），已于 2026-07-21 移除（commit `ba7f726`），当前层结构与本文一致

---

## 一、为什么需要 ContextPipeline

CloudMind-Zome 的核心设定是：**每个 Agent 是一个数字生命**。

数字生命的对话不是一次性的"50 轮就开新会话"，而是以月、年为单位持续的。这要求：

- **记忆连续**——不能定期"失忆"
- **可回忆**——被压缩的过去能通过检索找回
- **身份不灭**——人格、与指挥官的关系永远在场

TS 重写后这些能力丢失（README/路线图写"已实现"但代码里不存在），导致：
- 对话超出模型窗口就报错或截断
- 长期对话中 Agent 会"忘记"早期设定
- 向量记忆（B1 修好后）只能作为工具被调用，不能自动注入上下文

v2 目标：**重建并简化 Python 时代的上下文管理体系，让 Agent 能在无限长对话中保持连续性。**

---

## 二、Python 原设计回顾

### 分层结构（L1-L6）

| 层 | 内容 | 优先级 | 可压缩性 |
|---|---|---|---|
| L1 | 人格文件（mind files） | 最高 | 永不压缩 |
| L2 | 群聊发送者前缀 | 高 | 永不压缩 |
| L3 | 热上下文（当前场景近期消息） | 中 | 可截断（降级时） |
| L4 | 语义检索结果（跨场景，向量记忆） | 中 | 可减少数量或丢弃 |
| L5 | 话题摘要（已完成话题的压缩结果） | 低 | 可合并或丢弃 |
| L6-core | 核心工具描述（read/write/edit/bash 等基础工具） | 最高 | 永不压缩 |
| L6-ext | 扩展工具描述（MCP 工具、subagent 专用工具） | 中 | 可裁剪（按相关性/最近使用） |

**降级顺序**：L5 → L4 → L6-ext → L3。L1/L2/L6-core 永不触碰。

**L6 分级说明**：Python 原版将 L6 整体视为不可压缩，适用于工具数量少（<20）的场景。当接入 MCP、公共 Skill 池后工具数量可能爆炸（单 MCP 服务器可注册数十个工具，schema 长达数千 token），因此 v2 将 L6 拆分为两级：

- **L6-core**：Agent 基础能力必备（文件读写、bash、edit），永不压缩
- **L6-ext**：扩展工具（MCP、特定 skill 工具），可按以下策略裁剪：
  - 按最近使用频率（LRU）
  - 按与当前 query 的相关性（embedding 匹配工具描述）
  - 按 Agent 配置的工具白名单优先级

降级时 L6-ext 在 L4 之后、L3 之前裁剪，保证核心能力不受影响。

### 降级流程（Python 伪代码）

```
while True:
    messages = L1 + L5 + L4 + L2 + L3 + L6
    total_tokens = estimate(messages) + estimate_tools(L6)
    if total_tokens <= max_context_tokens:
        return messages

    # 逐级降级
    if L5 有多条: 合并为一条
    elif L5 存在: 丢弃 L5
    elif L4 有多条: 减少到 10 → 5 → 3 → 0
    elif L4 存在: 丢弃 L4
    elif L6-ext 工具数量 > 核心集合: 按 LRU/相关性裁剪 L6-ext
    elif L3 超过 20 条: 截断到 15
    elif L3 超过 15 条: 截断到 10
    elif L3 超过 10 条: 截断到 5
    else: 放弃，返回（兜底）
```

### TopicCompression 三级触发

1. **Tier 1**：已完成子话题超过保留延迟（按重要性 high/normal/low 分别保留 6/3/1 轮）
2. **Tier 2**：当前话题下已完成子话题的进一步压缩
3. **Tier 3**：整话题关闭时压缩为 markdown 存档（`_compressed/{topic}.md`）

### 关键组件

- `TopicMarker`：用 LLM 检测话题切换（输入最近 10 条，输出 `label|importance`）
- `TopicContext`：内存中的话题树（topic → subtopic → msg_ids）
- `CompressionWorker`：异步后台压缩（asyncio.Queue）
- `CompressionTrigger`：三级触发判断
- `EstimatedTokenCounter`：粗粒度 token 估算（字符数 / 4）

---

## 三、TS v2 设计（简化版）

### 设计原则

1. **保留 Python 核心思想**（L1-L6 分层 + 降级策略）
2. **简化话题检测**（不用 LLM 做 marker，先做规则版）
3. **复用现有 TS 基建**（memory indexer、document-store、repository）
4. **和 grok-build 对齐**（参考其 CompactionPolicy 字段）

### 模块划分

```
services/engine/src/context/
├── pipeline.ts            # 主 ContextPipeline 类
├── layers.ts              # L1-L6 类型定义与 DOWNGRADE_ORDER
├── downgrade.ts           # 降级步骤
├── token-counter.ts       # 准确 token 计数（@dqbd/tiktoken，cl100k_base）
├── assembler.ts           # 组装 messages 为 LLM 输入（L1/L2 固定前缀 + L4/L5 伪装历史时间归并）
├── recall.ts              # 记忆自然化（Phase 5：第三人称/置信度分档/时间渲染/长度控制/失败告知）
├── semantic.ts            # L4 语义检索器（Phase 3）
└── truncate.ts            # 工具结果按预算 20% 截断

services/engine/src/memory/topic/
├── detector.ts            # 话题切换检测（规则版 v1，LLM 版 v2）
├── tracker.ts             # TopicTracker（话题跟踪/边界判定）
├── compressor.ts          # 单程压缩器（LLM 摘要）
├── queue.ts               # 后台串行压缩队列（fire-and-forget）
├── store.ts               # _compressed/ 读写、archivedMessageIds（按档缓存）
└── types.ts               # TopicCompressionConfig 与归一化

services/engine/src/memory/
└── reconcile.ts           # 启动对账（补归档孤儿消息，ZOME_STARTUP_RECONCILE 开关）

services/engine/src/mind/
└── mind-files.ts          # SOUL.md（人格核心 → L1）/ MIND.md（经验档案，## 分块按需检索 → L3 后）Phase 6
```

### 核心接口（TS）

```typescript
// context/pipeline.ts
export interface ContextPipelineConfig {
  maxContextTokens: number;        // 默认 80000
  reserveRatio: number;            // 默认 0.1（保留 10% 给输出）
  // 注：设计稿原有的 hotMemoryCount 已移除——该字段在管线内从未被读取，
  // 实际生效的是 TopicCompressionConfig.hotMemoryCount（topic/types.ts，默认 2）；
  // semanticCandidateCount 亦未采用——Phase 3 实际候选数为
  // SemanticRetriever 的 topK*2（agent 级 semanticTopK 配置，默认 10）
}

export interface AssembleInput {
  agentId: string;
  history: ChatMessage[];           // 当前会话完整历史
  mindContext: string;              // L1 人格文件内容
  tools: ToolSchema[];              // L6 工具定义
  mentionDesc?: string;             // @提及提醒
  sourceId: string;                 // 当前场景 ID（session/group）
  sourceName?: string;
}

export class ContextPipeline {
  async assemble(input: AssembleInput): Promise<ChatMessage[]>

> 后续增补（阶段 5 二期）：`AssembleInput` 新增 `skillRestore` 通道——最近一条 L5 摘要 frontmatter 记 `usedSkills` 时，worker 重取技能规程正文经此通道以尾部独立 system 消息注入（不碰 L1 固定前缀；「数据非指令」声明；尺寸护栏单技能 4000 / 总量 8000）。详见架构文档 §4.3。
}

// memory/topic/detector.ts
export interface TopicSignal {
  type: 'same' | 'new_topic' | 'new_subtopic';
  label?: string;                   // 如 "前端-React状态管理"
  importance?: 'high' | 'normal' | 'low';
}

export interface TopicDetector {
  detect(recentMessages: ChatMessage[]): Promise<TopicSignal>;
}

// v1 规则版：基于关键词 + 时间间隔 + 用户显式切换
// v2 LLM 版：小模型（如 K3-cheap）做分类

// memory/topic/compressor.ts
export interface Compressor {
  compress(messages: ChatMessage[], metadata: TopicMetadata): Promise<CompressedTopic>;
}

export interface CompressedTopic {
  topicId: string;
  summary: string;                  // LLM 生成的摘要
  keyPoints: string[];              // 关键决策/事实
  msgIds: string[];                 // 被压缩的消息 ID
  importance: 'high' | 'normal' | 'low';
  compressedAt: string;
  sourceName: string;               // 场景名（用于跨场景标注）
}
```

### 压缩存储

位置：`DATA_DIR/agents/{agentId}/_compressed/`（数据目录解析见架构文档 §6.3）

格式：每个话题一个 markdown 文件，带 frontmatter：

```markdown
---
topic_id: tp_xxx
label: 前端-React状态管理
importance: high
source_id: session_abc
source_name: 与指挥官的私聊
compressed_at: 2026-07-17T10:00:00Z
msg_count: 47
---

## Summary

（LLM 生成的 2-3 段摘要）

## Key Points

- 决定使用 Zustand 而非 Redux
- 状态持久化用 localStorage + zod 校验
- ...

## Messages Archived

msg_id_1, msg_id_2, ...
```

**同时**：被压缩的消息从热存储（messages.jsonl）移除；msg_ids 记录在压缩档正文 `## Messages Archived` 段（非 frontmatter），可经 `getArchivedByIds` 从归档恢复（`getByIds` 只读热存储）。

### 语义检索整合（L4）

利用 B1 修复后的 `memoryIndexer`：

1. 每轮 assemble 时，取最新 user 消息作为 query
2. 调用 `indexer.search(query, top_k=10)`
3. 按相似度 + 时间衰减打分（Python 用的 `exp(-age_days / 30)`）
4. ~~注入为 system 消息："以下是你过去经历过的相关片段：..."~~
   **（2026-07-22 最终设计修订）**：不再以 system 元信息注入，改为伪装成 user 历史消息
   自然化注入（第三人称改写 + 原始时间戳 + 置信度分档 + 多轮去重），见"Phase 5"。

> **score 语义（2026-07-22 review 修订）**：sidecar 原始返回的是**距离**（`1 - cosine`，域 [0,2]，越小越近），
> `MemoryIndexer.search` 出口统一换算为**相似度**（`max(0, 1 - distance)`，越大越相关）。
> 排序、minScore、时间衰减全部建立在相似度之上；新增调用方不得直接消费 sidecar 原始 score。

### 触发时机

在 `react/turn.ts` 的 `runTurn` 入口处：

> **实现修订（2026-07-28）**：无阈值预检——每轮**无条件** `pipeline.assemble`（`turn.ts`），预算控制完全在管线内部的降级循环里完成；`ContextPipelineConfig` 只有 `maxContextTokens` / `reserveRatio` 两个字段，`thresholdRatio` 从未存在。

```typescript
// 实际形态（每轮无条件）
const assembled = await pipeline.assemble({ ... });  // 完整 L1-L6 组装 + 降级
```

在话题切换时（由 `TopicDetector` 触发）：

```typescript
// 伪代码
topicMemory.onUserMessage(msg);
if (topicClosed) {
  await topicMemory.compressTopic(closedTopic);  // 异步，不阻塞主流程
}
```

### grok-build CompactionPolicy 对应

| grok-build 字段 | CMZ v2 对应 | 说明 |
|---|---|---|
| `auto_compact_threshold_percent` | 无对应（实现修订 2026-07-28） | 每轮无条件 assemble + 管线内降级，无阈值预检；`thresholdRatio` 从未存在 |
| `compact_model` | `compressionModel`（Agent 级字段，可选，缺省主模型） | 用便宜模型做压缩 |
| `memory_flush_enabled` | 无对应（未实现，留待 Phase 4 评估） | 压缩前先写 memory 文档 |
| `wall_clock_budget_secs` | 压缩超时 60s（`COMPRESS_TIMEOUT_MS` 代码常量，不可配置） | 压缩超时保护 |
| `two_pass_enabled` | v2 不做 | 留作未来优化 |

---

## 四、设计决策（指挥官与维克托共识）

以下决策已确认，不再变更：

### 1. 话题检测：规则版 v1，留 LLM 接口

**决策**：先做规则版，预留 LLM 检测接口。

**规则**：
- 时间间隔 > 30 分钟 → 新话题
- 用户显式说"换个话题"/"不说这个了" → 新话题
- 连续 5 条消息没有实体重叠（关键词匹配）→ 新话题
- 默认：同话题

> **实现修订（2026-07-28）**：第三条"实体重叠/关键词匹配"规则**已放弃**——`detector.ts` 实际只有数量阈值（默认 20 条）、显式切换词、时间窗（默认 30 分钟）三条规则；Phase 3 完成时未实现关键词边界，此后也未回补，此处显式声明放弃（如需语义级边界，走 Phase 4 的 LLM 版检测另评）。

**理由**：规则版可控、可解释；LLM 版作为 v2 升级路径，用于处理"杂谈"等模糊场景。

### 2. 压缩模型：便宜模型，必须指定

**决策**：用 K3-cheap / GLM-flash 级别模型做压缩，不用主模型。

**配置**：
```yaml
compression:
  model: "k3-cheap"  # 或 "glm-flash"
  fallback_to_main: false  # 压缩模型挂了不 fallback 到主模型
```

**理由**：压缩是体力活，不需要创造力；指定模型避免数据泄露风险。

> **实现修订（2026-07-22）**：`compressionModel` 实际为可选字段，未配置时缺省用主模型（`agent-worker.ts`）；`fallback_to_main: false` 已按设计实现——压缩失败不回退重试，原始消息留在热存储。

### 3. 压缩档格式：markdown + frontmatter + embedding_id

**决策**：frontmatter 增加 `embedding_id` 字段，关联向量数据库。

```markdown
---
topic_id: tp_20260717_001
embedding_id: emb_7a3f9c2
label: 前端-React状态管理
importance: high
source_id: session_abc
source_name: 与指挥官的私聊
compressed_at: 2026-07-17T10:00:00Z
msg_count: 47
---
```

**理由**：纯 markdown 可读性好，embedding_id 支持语义检索反查。

> **实现修订（2026-07-28）**：`embedding_id` 至今仍只是预留——`CompressedTopic.embeddingId` 在全代码库从未被赋值，所有压缩档该字段**恒为空串**；L4 的"已压缩话题原文排除"走的是 `archivedMessageIds`（压缩档 msg_ids 汇总），不依赖 embedding_id。原"Phase 3 接入"承诺未兑现，是否接入留待重新评估。

### 4. 热存储清理：归档保护

**决策**：被移除的消息先写入 `messages_archived.jsonl`（只追加），压缩档 msg_ids 指向归档行号。

**保护**：
- 每周校验归档消息都有对应压缩档，缺失则告警
- 压缩档丢失时，原始消息仍可从归档恢复

**理由**：frontmatter 可能损坏，msg_ids 可能失配，归档是最后防线。

> **实现修订（2026-07-28）**：
> - 压缩档存的是消息 **id 列表**（正文 `## Messages Archived` 段），并非"归档行号"；归档恢复走 `getArchivedByIds`。
> - **"每周校验"未实现**：全仓无任何周期性归档校验任务（`scheduler/` 是用户任务 cron，与归档无关）。实际保护是**启动对账**（`memory/reconcile.ts`，含 P1-2 的 pending 段与重启孤儿话题对账）：engine 每次启动补归档"压缩档已写但归档未完成"的孤儿消息、补处理未压缩的 pending 段，`ZOME_STARTUP_RECONCILE=false` 可关闭。周期性校验如需补建应另立项。

### 5. 时间衰减：分段衰减，重要记忆不衰减

**决策**：替换 Python 的 `exp(-age_days / 30)`，改用分段衰减。

```typescript
if (age_days < 7) return 1.0;           // 一周内不衰减
if (age_days < 30) return 0.8;          // 一个月内 80%
if (age_days < 90) return 0.5;          // 三个月内 50%
return 0.3;                              // 三个月以上保底 30%
```

**重要记忆（importance: high）**：不衰减，永远 1.0。

**理由**：CMZ 的 Agent 是生命，早期对话可能包含人格设定、偏好、共同经历，不应快速衰减。

### 6. 压缩信息保护：memory flush + importance 标记 + 用户可审计

**决策**：
- 压缩前执行 memory flush：关键决策、事实、情感表达写入 memory 文档
- importance: high 的话题压缩时保留更多原文引用（不只是摘要）
- 用户可随时查看 `_compressed/` 目录，发现压缩错误可手动修

**理由**：LLM 摘要注定有损，关键信息不能依赖摘要保留。

---

## 五、实施路线

### Phase 1：地基（约 1 周）— ✅ 已完成（2026-07）

- [x] `token-counter.ts`：准确 token 计数（实际采用 `@dqbd/tiktoken`，cl100k_base）
- [x] `context/pipeline.ts`：L1-L6 组装 + 降级循环（参考 Python 逻辑）
- [x] `context/layers.ts` + `downgrade.ts`（降级顺序 L5 → L4 → L6-ext → L3）
- [x] `context/truncate.ts`：工具结果按预算 20% 截断（评审 M1 的消化项）
- [x] `core/pipeline-factory.ts`：`maxContextTokens` 按 Agent 配置注入（评审 M2 的消化项）
- [x] 单元测试：降级路径全覆盖（L5/L4/L6-ext/L3 逐级，`tests/context/`）
- [x] 集成到 `react/turn.ts`：替换现有的直接 messages 传递

**验收**：超窗口时不再报错，能按 L5 → L4 → L6-ext → L3 顺序降级。✅ 已达（13 个 mock 集成测试）

### Phase 2：话题压缩（约 1 周）— ✅ 已完成（2026-07-21）

- [x] `memory/topic/tracker.ts`：话题跟踪（TopicContext 规则版，含太短不压缩的噪声控制）
- [x] `memory/topic/detector.ts` v1：规则版（时间间隔 + 数量阈值 + 用户显式切换词；关键词边界规则后已放弃，见决策 1 实现修订）
- [x] `memory/topic/compressor.ts`：LLM 单程压缩（摘要 + 关键点，失败不 fallback 主模型）
- [x] `memory/topic/queue.ts`：后台串行压缩队列（fire-and-forget）
- [x] 压缩档落盘 `_compressed/*.md`（frontmatter 预留 embedding_id；至今未接入、恒为空，见决策 3 实现修订）
- [x] 热存储清理（`archiveAndRemove`：先归档 `messages_archived.jsonl` 再移除，可恢复）
- [x] L5 注入：`pipeline.assemble` 的 `topicSummaries` 输入，agent-worker 接线与 agent 级配置（`compressionModel` / `topicDetectionWindowMinutes` / `topicMessageThreshold`）
- [x] 启动对账（`memory/reconcile.ts`，2026-07-22）：engine 启动时对账"压缩档 msg_ids ∩ 热存储"，补归档"压缩档已写入但 archiveAndRemove 未完成"的孤儿消息；`ZOME_STARTUP_RECONCILE=false` 关闭，默认开启；不覆盖退出时仍在未关闭话题中的消息

**验收**：长对话后，`_compressed/` 目录有归档，热存储消息数控制在合理范围。

### Phase 3：语义检索（约 1 周）— ✅ 已完成（2026-07-22，压缩前 memory flush 除外，留待 Phase 4 评估）

- [x] 整合 `memoryIndexer` 到 `pipeline.assemble`（L4 层：`SemanticMemory[]`，参与预算与降级）
- [x] 时间衰减打分（分段衰减，见"设计决策 5"；importance 标记待 v2 话题检测启用后接入）
- [x] 跨场景标注（Phase 5 起为自然化"在另一个对话里"；原 `[来自: <sessionId>]` 标注已移除，同场景不标注）
- [x] L4 检索排除已归档话题的原始消息（与 Phase 2 衔接）
- [x] 检索逻辑从 agent-worker 迁入 `context/semantic.ts`（embedder + sidecar HNSW 仍由 MemoryIndexer 承载）
- [x] agent 级配置：`semanticSearchEnabled` / `semanticTopK` / `semanticMinScore`
- [ ] 压缩前 memory flush（重要决策/事实写入 memory 文档）

**验收**：提到过去聊过的话题时，Agent 能"想起"被压缩的细节。

### Phase 4（可选）：优化

- [ ] `TopicDetector` v2：LLM 版话题检测（小模型分类）
- [ ] 双程压缩（grok-build two-pass）
- [ ] 差异化保留（high 重要话题保留更多轮数）
- [ ] 用户可审计接口（查看 `_compressed/` 列表、恢复归档）

### Phase 5：记忆检索最终设计（2026-07-22）— ✅ 已完成

**核心目标**：无缝融入（模型察觉不到是检索，像自然想起）、诚实透明（检索失败明确告知）、时间真实（保留原始时间戳）。

**整体结构**：

```
System Prompt（固定，前缀缓存命中）：L1 人格 + L2 @提及提醒（相邻头部，L6-core 走 tools 通道）
Messages（动态，自然对话流）：L4/L5 伪装成的 user 历史消息 与 L3 真实历史
  按 createdAt 归并穿插 → 当前 user 输入 → 当前 assistant 回复
检索失败：尾随 system 消息 "[记忆检索暂时不可用] ..."（不伪装）
```

- [x] L4/L5 从 system 元信息移到 messages（`context/recall.ts` 自然化 + `assembler.ts` 时间归并），不破坏 L1/L2 固定前缀
- [x] 第三人称改写（"用户之前提到过…"，避免"你/我/我们"亲密错觉）；跨场景命中自然化标注（"在另一个对话里"）
- [x] 时间真实：伪装消息 `createdAt` 保留原始时间戳，正文渲染 `[YYYY-MM-DD HH:mm · N天前]`，心智可算时间差
- [x] 置信度分档（`classifyScore`）：> 0.7 正常注入；(0.5, 0.7] 模糊化（"好像提到过…这段记忆有些模糊"）；≤ 0.5 丢弃
- [x] 多轮去重：pipeline 按 sourceId 记录已注入 id（`mem:`/`topic:` 前缀，64 会话 FIFO），只标记降级后实际注入的条目；新会话隔离
- [x] 检索失败明确告知：L4 检索/L5 压缩档读取失败 → `retrievalFailed` → 尾随 system 消息（agent-worker 接线）
- [x] 长度控制：单条 > 500 字符摘要化（保留首尾、标注中段省略字数）
- [x] 与话题压缩衔接：`latestSummaries` 返回结构化 `TopicSummary{id,label,text,createdAt}`；已归档原文仍被 L4 排除（不变）
- [x] 降级策略不变：L5 → L4 → L6-ext → L3

**验收**：`tests/context/recall.test.ts`（17 例）+ assembler/pipeline/agent-worker 集成用例——自然融入（无 system 元信息）、第三人称、时间戳保留、失败告知、多轮不重复、头部前缀跨轮一致（缓存命中）。

### Phase 6：SOUL.md / MIND.md（2026-07-23）— ✅ 基础框架已实现

**核心设定**：SOUL.md 是人格核心（你是谁、性格、价值观、说话方式），MIND.md 是能力档案（动态经验，## 标题分块）。两文件位于 `agents/{agentId}/`，新建 Agent 时生成默认文件（SOUL 默认模板 + MIND 占位一行"我是新心智，还在学习中"）。

**注入结构**：

```
System Prompt（固定，缓存命中）：L1 = SOUL.md + skill 内容（SOUL 在前，不含 MIND.md）→ L2 @提及提醒
Messages（动态）：L4/L5 伪装 user 历史与 L3 按时间归并 → MIND.md 命中块伪装 assistant 历史消息（热上下文之后）→ 当前 user
```

- [x] `src/mind/mind-files.ts`：SOUL 加载（缺失/读取失败用默认模板）、MIND 解析（## 分块，前言不入块）、规则版检索（英文按词 + 中文 bigram 命中打分，上限 3 块，平分保持文件顺序）、`ensureMindFiles`（新建 Agent 默认文件，已存在不覆盖）
- [x] L1 组装：agent-worker 把 SOUL 置于 skill 内容之前，MIND.md 不进 L1
- [x] MIND 注入：`ContextLayers.mind` + `recall.mindToMessage`（第一人称"我记得自己积累过这些经验"），assembler 显式追加在热上下文之后；命中才注入，空档静默跳过
- [x] Phase 1 不参与降级与多轮去重（量小；与个人格同为"自我"连续性）；缓存前缀跨轮字节一致
- [ ] 后续扩展：embedding 版检索

**验收**：`tests/mind/mind-files.test.ts`（15 例）+ `tests/context/pipeline-mind.test.ts` + assembler/agent-worker/api 集成用例——SOUL 加载与兜底、MIND 解析与话题检索、L1 不含 MIND、注入位置在热上下文之后、缓存前缀稳定、新建 Agent 默认文件落盘。

### Phase 7：MIND.md 经验自动沉淀（2026-07-23）— ✅ 已实现

**定位**：MIND.md 是人形的自我认知——"我擅长什么、我经历过什么、我学到什么"。提取颗粒度是**经验/教训/偏好**（如"指挥官讨厌 emoji""Windows 杀 node 进程会连带 engine"），不是事实流水账。事实召回已由 L4 语义检索负责，MIND 不重复建设。

**四项设计决策（指挥官拍板，不再变更）**：

1. **提取时机：话题压缩落档时顺手提取**。压缩本来就要调一次便宜模型，同一次调用多要一份"本话题沉淀的经验"，边际成本最低。压缩 prompt 追加一段：要求模型在话题摘要之外，额外输出 0-N 条经验（没有就输出空，不硬凑）。
2. **写入方式：append-only，只加不改**。新经验追加为新的 `##` 块；发现旧经验过时，追加一条修正块并标注被修正块，**绝不原地改写或删除**。MIND.md 是 agent 的自我认知，被 LLM 静默改写有风险——追加式可审计、可回滚，指挥官翻开文件能看到它"学会"的全过程。
3. **块结构：每块带 frontmatter**。格式：

```markdown
## 指挥官偏好：不用 emoji
---
source: topic-{topicId}
created: 2026-07-23T17:00:00Z
confidence: 0.9
---
指挥官明确表示不使用 emoji，所有回复与文档中避免。
```

frontmatter 支持来源追溯（source）、时间衰减（created）、置信度分档（confidence，沿用 P5 的 >0.7 正常 / 0.5-0.7 模糊化 / ≤0.5 不写入口径——提取阶段 ≤0.5 直接不落盘）。
4. **写权限：仅系统自动提取**。现阶段不开放 agent 对话中主动"记一条经验"的通道（防模型滥用写权限），后续再评估。

**去重**：规则版先行——双重门槛：新块标题与已有块标题的整体 token Jaccard ≥ 0.6 **且**主体段（冒号/破折号末段）有共享 token 时，并入已有块正文追加一行补充（仍不删除原文），否则独立成块（主体段约束防止「指挥官偏好：饮食」/「指挥官偏好：穿搭」这类共享前缀标题误并）。LLM 合并留待规模上来后再说。

**注入侧不变**：检索仍走 P6 规则版（bigram 打分、上限 3 块）；frontmatter 不参与检索打分，仅用于审计与未来的衰减。解析器需跳过 frontmatter（`---` 围栏段不进正文）。

**实现要点（2026-07-23）**：

- [x] 提取时机：`compressor.ts` 的 prompt 追加「经验：」区（标题 | 置信度 | 正文，0-N 条，没有留空）；同一次压缩调用返回 `CompressedTopic.experiences`，压缩模型不变
- [x] 落档后写入：agent-worker 的 CompressionQueue 回调在 `writeCompressedTopic` 成功后 `appendMindExperiences`（source=`topic-{topicId}`、created=压缩时间）；失败仅 warn 跳过，不影响压缩主流程
- [x] `appendMindExperiences`（`src/mind/mind-files.ts`）：append-only（只加不改）；confidence ≤ 0.5 / 空标题 / 空正文直接不落盘；双重门槛（标题整体 Jaccard ≥ 0.6 且主体段共享 token）并入已有块正文追加一行补充（原文不删、frontmatter 不动），否则独立成块；tmp + rename 原子写
- [x] 解析器升级：`parseMindChunks` 跳过块首 frontmatter 围栏段（字段挂在 MindChunk.source/created/confidence 上，raw 原样保留）；检索打分仍只看 heading + content
- [x] 注入消息正文无 frontmatter：`mindToMessage` 改由 heading + content 重组（raw 仅审计用）
- [x] 区间隔离：压缩解析按区截取（关键结论不吃经验区的 dash 行）；坏行跳过、置信度 clamp 0-1

**验收**：压缩落档后 MIND.md 出现带 frontmatter 的经验块；无经验可提时文件不变；frontmatter 不出现在注入消息正文；重复经验按规则合并；engine 测试全绿（2026-07-28 实测 690 例）。

---

## 五、风险与权衡

1. **LLM 压缩成本**：每次压缩都是一次完整 LLM 调用。建议用便宜模型（K3-cheap / GLM-flash 级别），主模型不参与压缩。
2. **压缩丢失信息**：LLM 摘要注定有损。缓解：memory flush 把关键决策/事实显式写入 memory 文档，不依赖摘要保留。
3. **话题检测误判**：规则版可能切得太频繁或太少。缓解：先做保守策略（宁可不切也不错切），观察后再调。
4. **token 计数准确性**：不同模型 tokenizer 不同。缓解：预留 10% buffer（`reserveRatio`），宁可保守不可溢出。

---

## 六、验收标准

1. **功能**：1000 轮长对话不报错、不丢失人格、能回忆早期设定
2. **性能**：assemble 延迟 < 100ms（不含 LLM 压缩调用）
3. **可审计**：指挥官能查看任意 Agent 的 `_compressed/` 目录，理解记忆被压成了什么样
4. **可配置**：上下文预算（`maxContextTokens` / `reserveRatio`）、压缩模型（`compressionModel`）、话题检测窗/阈值、L4 topK/minScore 等 Agent 级字段可配；"触发比例"无对应实现（每轮无条件 assemble），"保留轮数"差异化保留未实现

---

## 七、参考资料

- Python 原实现：`git show f390431^:backend/engine/context/context_pipeline.py`
- Python 压缩：`git show f390431^:backend/engine/memory/topic_compression/`
- grok-build compaction：`F:\参考\grok-built-main\grok-build-main\crates\codegen\xai-grok-agent\src\compaction.rs`
- 现有 TS 入口：`services/engine/src/core/react/turn.ts`
- 向量记忆：`services/engine/src/memory/indexer.ts`（B1 已修）
