# 长期记忆召回对齐设计规格

> 版本：1.0 | 日期：2026-11-04
> 状态：设计定案（指挥官拍板选项「补齐到全量，按设计初衷」）
> 前置侦察：`context/semantic.ts:45,126,129`（衰减/归档排除/打分）、`context/recall.ts:15`（CONFIDENCE_DROP）、`context/pipeline.ts:219`（入层过滤）、`memory/topic/compression-task.ts:139,180,197`（三处删向量）、`memory/topic/store.ts:358`（归档 id 全集成扁平集合）、`memory/repositories/message.ts:150,198`（getByIds 只读热存储 / getArchivedByIds 流式读归档）

## 1. 背景

L4 语义检索的实现与三处设计意图反向：

1. **决策 5**（`design/context-pipeline-v2.md`）原文：「CMZ 的 Agent 是生命，早期对话可能包含人格设定、偏好、共同经历，**不应快速衰减**」。实现结果却是硬悬崖：`timeDecay` 在 30–90 天给 0.5，而准入门槛是 `score > 0.5`，`similarity` 上限 1.0 → `1.0 × 0.5 = 0.5` 恰好不过线，**30 天以上的消息数学上不可能注入**（≥90 天衰减 0.3，更不可能）。旧公式 `exp(-age/30)` 在 30 天还有 0.37 能过线，新公式比它更狠。

2. **决策 6** 原文：「importance: high 的话题压缩时保留更多原文引用（不只是摘要）」。实现是 `compression-task.ts` 三处无条件 `deleteArchivedVectors`，与「保留更多原文引用」正相反。

3. **Phase 3 验收标准** 原文：「提到过去聊过的话题时，Agent 能"想起"被压缩的细节」。但压缩即删向量 + L4 排除归档 id，被压缩的细节恰恰是 L4 永远取不到的部分。现有 `tests/context/recall.test.ts` 17 例只覆盖格式（第三人称/时间戳/去重/失败告知），**无一条验证"能不能真的想起一个月前的事"**——验收标准实质从未被验证。

**根因**：`score = similarity × timeDecay` 一个数同时承担「排序权重」与「准入门槛」两种语义。后者要求 `decay ≤ 0.5` 时无论内容多相关都归零。

**连带缺陷**：`classifyScore` 对同一个混合分分档，于是「三个月前聊过的事」被渲染成「这段记忆有些模糊」——**旧 ≠ 不确定**，两个概念被一个乘法揉在一起。

**为什么不换库**：瓶颈不在此。换成 sqlite-vec / useach、冷启降到 0ms、索引扩到十万级，上述三条逻辑仍会让 31 天前的消息进不来。库的选型留给 `架构文档.md §9.1` 的触发条件。

## 2. 已定决策（不翻案）

1. **拆开准入与排序**：`SemanticMemory` 新增 `similarity` 字段，与 `score` 并存。
   - `similarity` = sidecar 返回的余弦相似度（`MemoryIndexer.search` 出口已换算为 `max(0, 1 - distance)`）；
   - `score` = `similarity × timeDecay`，**仅用于排序**，不再作准入判定。
2. **所有准入门槛统一看 similarity**：`CONFIDENCE_DROP`（0.5，注入/丢弃线）、`semanticMinScore`（用户可配，默认 0）、`classifyScore` 三档，全部改判 `similarity`。
   - 语义变更须知：`semanticMinScore` 从「过滤混合分」变为「过滤相似度」。默认 0 时无行为差异；非 0 配置的门槛实际放松（不再被衰减连坐）。`docs/API.md` 与 Agent 配置说明需注明。
3. **时间衰减退化为排序权重**，不再决定生死。分档值不变（`<7d 1.0 / <30d 0.8 / <90d 0.5 / ≥90d 0.3`）——它现在只回答「同样相关时谁排前面」，这正是决策 5 想表达的「别太有分量」。
4. **importance=high 的话题归档时保留向量**：`compression-task.ts` 三处 `deleteArchivedVectors` 中，正常压缩落档与注入检测降级两条路径按 `compressed.importance === "high"` 跳过删除；`archiveOnly` 短话题路径**不变**（不调 LLM、无 importance 来源）。
   - 依据：决策 6「high 话题保留更多原文引用」的兑现；
   - 代价（已知并接受）：high 话题向量永久驻留。按 10–20% 话题判 high、2000 话题/年、20 条/话题估：2000–4000 条 × 13.3KB ≈ **27–53MB/年**，远未触及 §9.1 的 1.3GB 痛点。
5. **L4 对 high 话题放开归档排除**：归档 id 集合从扁平 `Set<string>` 扩为 `{ all, highKept }`；排除条件改为 `all.has(id) && !highKept.has(id)`。
6. **归档消息可回读**：`SemanticRetriever` 取内容时，热存储 `getByIds` 取不到的 id 追加一次 `getArchivedByIds`（流式过滤读，任意归档大小可用）。热存储命中优先，归档只补缺口。
7. **与 L5 的重叠接受**：high 话题会同时有 L5 摘要（骨架）与 L4 原文（细节）。不预设降权，先跑实际效果；若原文挤占 topK 明显，再给 high 条目 `score × 0.9`（记为后续可调项，不在本单）。
8. **不改 Rust 侧车**：supervisor 与 HNSW 均在本次范围外。supervisor 的废弃问题另单处理。

## 3. 验收

1. **跨压缩档召回**：造 20 条消息 → 压缩判 high → 归档 → 以 40 天后的时钟检索 → 同主题 query 能召回原文（`timeDecay` 已收 `now` 参数，可注入）；
2. **30 天不再归零**：同一消息在 40 天/200 天两个时钟下，`similarity` 过关即注入，`score` 随之下降但不影响准入；
3. **低相似度仍被挡**：`similarity ≤ 0.5` 的消息在任意年龄都不注入（回归：噪声不因放开衰减而涌入）；
4. **normal 话题行为不变**：importance 非 high 的话题归档后仍删向量、仍在 L4 被排除（恒等）；
5. **archiveOnly 路径不变**：短话题仍删向量；
6. **`semanticMinScore` 新语义生效**：设为 0.6 时，sim 0.55 的消息被过滤（不再被 decay 放大误差）；
7. **既有套件零回归**：`tests/context/*`、`tests/memory/*`、`tests/topic/*`、`tests/core/agent-worker.test.ts` 全绿。
