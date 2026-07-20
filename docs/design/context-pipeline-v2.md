# ContextPipeline v2 设计文档

> 版本：v2-draft | 日期：2026-07-17 | 作者：维克托（为 TS 重写整理）
> 参考：Python 遗留实现（commit f390431^ 之前）、grok-build compaction 设计
> 状态：待实现（TS 重写）

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
| L1.5 | 群聊行为指令（stay-silent 等） | 高 | 永不压缩 |
| L2 | 群聊发送者前缀 | 高 | 永不压缩 |
| L3 | 热上下文（当前场景近期消息） | 中 | 可截断（降级时） |
| L4 | 语义检索结果（跨场景，向量记忆） | 中 | 可减少数量或丢弃 |
| L5 | 话题摘要（已完成话题的压缩结果） | 低 | 可合并或丢弃 |
| L6-core | 核心工具描述（read/write/edit/bash 等基础工具） | 最高 | 永不压缩 |
| L6-ext | 扩展工具描述（MCP 工具、subagent 专用工具） | 中 | 可裁剪（按相关性/最近使用） |

**降级顺序**：L5 → L4 → L6-ext → L3。L1/L1.5/L2/L6-core 永不触碰。

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
    messages = L1 + L1.5 + L5 + L4 + L2 + L3 + L6
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
├── layers.ts              # L1-L6 类型定义与优先级
├── downgrade.ts           # 降级策略
├── token-counter.ts       # 准确 token 计数（基于 gpt-tokenizer 或类似）
├── assembler.ts           # 组装 messages 为 LLM 输入
└── __tests__/

services/engine/src/memory/topic/
├── detector.ts            # 话题切换检测（规则版 v1，LLM 版 v2）
├── context.ts             # TopicContext（话题树）
├── trigger.ts             # 压缩触发
├── compressor.ts          # 单程压缩器（LLM 摘要）
├── worker.ts              # 后台 worker（Node EventEmitter / setImmediate）
└── __tests__/
```

### 核心接口（TS）

```typescript
// context/pipeline.ts
export interface ContextPipelineConfig {
  maxContextTokens: number;        // 默认 80000
  reserveRatio: number;             // 默认 0.1（保留 10% 给输出）
  hotMemoryCount: number;           // 默认 2（注入最近 2 个压缩档）
  semanticCandidateCount: number;   // 默认 10（向量检索候选数）
}

export interface AssembleInput {
  agentId: string;
  history: ChatMessage[];           // 当前会话完整历史
  mindContext: string;              // L1 人格文件内容
  tools: ToolSchema[];              // L6 工具定义
  personalityDesc?: string;         // L1.5 群聊行为指令
  mentionDesc?: string;             // @提及提醒
  sourceId: string;                 // 当前场景 ID（session/group）
  sourceName?: string;
}

export class ContextPipeline {
  async assemble(input: AssembleInput): Promise<ChatMessage[]>
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

位置：`~/.cloudmind-zome/agents/{agentId}/_compressed/`

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

**同时**：被压缩的消息从热存储（messages.jsonl）移除，但 msg_ids 保留在 frontmatter 中，可通过 `getByIds` 从归档恢复。

### 语义检索整合（L4）

利用 B1 修复后的 `memoryIndexer`：

1. 每轮 assemble 时，取最新 user 消息作为 query
2. 调用 `indexer.search(query, top_k=10)`
3. 按相似度 + 时间衰减打分（Python 用的 `exp(-age_days / 30)`）
4. 注入为 system 消息："以下是你过去经历过的相关片段：..."

### 触发时机

在 `react/turn.ts` 的 `runTurn` 入口处：

```typescript
// 伪代码
const estimatedTokens = tokenCounter.count(messages);
if (estimatedTokens > threshold) {
  messages = await pipeline.assemble({ ... });  // 完整 L1-L6 组装 + 降级
}
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
| `auto_compact_threshold_percent` | `config.thresholdRatio` (0.8) | 触发压缩的窗口占比 |
| `compact_model` | `config.compressModel` (可选) | 用便宜模型做压缩 |
| `memory_flush_enabled` | `config.flushBeforeCompress` (true) | 压缩前先写 memory 文档 |
| `wall_clock_budget_secs` | `config.compressTimeoutSecs` (60) | 压缩超时保护 |
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

### 4. 热存储清理：归档保护

**决策**：被移除的消息先写入 `messages_archived.jsonl`（只追加），压缩档 msg_ids 指向归档行号。

**保护**：
- 每周校验归档消息都有对应压缩档，缺失则告警
- 压缩档丢失时，原始消息仍可从归档恢复

**理由**：frontmatter 可能损坏，msg_ids 可能失配，归档是最后防线。

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

### Phase 1：地基（约 1 周）

- [ ] `token-counter.ts`：准确 token 计数（用 `@dqbd/tiktoken` 或类似）
- [ ] `context/pipeline.ts`：L1-L6 组装 + 降级循环（参考 Python 逻辑）
- [ ] `context/layers.ts` + `downgrade.ts`
- [ ] 单元测试：降级路径全覆盖（L5/L4/L3 逐级）
- [ ] 集成到 `react/turn.ts`：替换现有的直接 messages 传递

**验收**：超窗口时不再报错，能按 L5 → L4 → L3 顺序降级。

### Phase 2：话题压缩（约 1 周）

- [ ] `memory/topic/context.ts`：话题树数据结构
- [ ] `memory/topic/detector.ts` v1：规则版（时间间隔 + 关键词 + 用户切 session）
- [ ] `memory/topic/compressor.ts`：LLM 单程压缩（摘要 + 关键点）
- [ ] `memory/topic/worker.ts`：后台 worker
- [ ] 压缩档落盘 `_compressed/*.md`
- [ ] 热存储清理（被压缩消息从 messages.jsonl 移除）

**验收**：长对话后，`_compressed/` 目录有归档，热存储消息数控制在合理范围。

### Phase 3：语义检索（约 1 周）

- [ ] 整合 `memoryIndexer` 到 `pipeline.assemble`（L4 层）
- [ ] 时间衰减打分（`exp(-age_days / 30)`）
- [ ] 跨场景标注（`[来自: 与XX的群聊]`）
- [ ] 压缩前 memory flush（重要决策/事实写入 memory 文档）

**验收**：提到过去聊过的话题时，Agent 能"想起"被压缩的细节。

### Phase 4（可选）：优化

- [ ] `TopicDetector` v2：LLM 版话题检测（小模型分类）
- [ ] 双程压缩（grok-build two-pass）
- [ ] 差异化保留（high 重要话题保留更多轮数）
- [ ] 用户可审计接口（查看 `_compressed/` 列表、恢复归档）

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
4. **可配置**：所有阈值（触发比例、保留轮数、压缩模型）可在 config 里调整

---

## 七、参考资料

- Python 原实现：`git show f390431^:backend/engine/context/context_pipeline.py`
- Python 压缩：`git show f390431^:backend/engine/memory/topic_compression/`
- grok-build compaction：`F:\参考\grok-built-main\grok-build-main\crates\codegen\xai-grok-agent\src\compaction.rs`
- 现有 TS 入口：`services/engine/src/core/react/turn.ts`
- 向量记忆：`services/engine/src/memory/indexer.ts`（B1 已修）
