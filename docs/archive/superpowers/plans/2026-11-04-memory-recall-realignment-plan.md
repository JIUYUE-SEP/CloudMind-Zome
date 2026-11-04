# 长期记忆召回对齐实施计划

- 日期：2026-11-04
- 范围：`services/engine`（context / memory / core + 测试）、`docs`（架构文档 / 路线图 / API）
- 依据：`docs/archive/superpowers/specs/2026-11-04-memory-recall-realignment-design.md`——决策 1-8 不翻案
- 方法：分四阶段独立提交（A → B → C → 文档），每阶段自带用例与验收；全程不动 `crates/`

## 阶段 0（侦察结论，已核）

- `score` 的准入双职：`semantic.ts:130`（`minScore` 过滤）、`pipeline.ts:219`（`CONFIDENCE_DROP` 过滤）、`recall.ts:15,68`（分档）三处都判混合分；
- 归档 id 是扁平集合：`store.ts:358` 返回 `Set<string>`，无 importance 维度；按档缓存 `archivedIdsCache`（`:349`）存 `{mtimeMs,size,ids}`；
- **归档内容取不到**：`message.ts:150` 的 `getByIds` 只读热存储；`message.ts:198` 的 `getArchivedByIds` 流式过滤读归档，任意大小可用——C 阶段必须补这一跳，否则放开排除了也读不到正文；
- 三处删向量：`compression-task.ts:139`（archiveOnly）、`:180`（注入检测降级）、`:197`（正常落档）；`archiveOnly` 不调 LLM，无 importance 来源；
- `archivedMessageIds` 除 L4 外还有 `memory/reconcile.ts:36` 在用（只需全集，不关心 importance）。

## 阶段 A（拆开准入与排序）——1 个实现子代理

1. `context/layers.ts:8`：`SemanticMemory` 加 `similarity: number`，注释写明分工（similarity = 准入/分档；score = 排序）。
2. `context/semantic.ts`：
   - 消息路径与 `mem:` 路径均在 push 时填 `similarity`，`score` 仍为 `similarity × decay`（`mem:` 的 high 恒 1.0 语义不变）；
   - 过滤改 `if (sim < this.config.minScore) continue;`（原判 `score`）；
   - 出口排序仍 `sort((a,b) => b.score - a.score)`。
3. `context/pipeline.ts:219`：`m.score > CONFIDENCE_DROP` → `m.similarity > CONFIDENCE_DROP`；`:248` 注释同步。
4. `context/recall.ts`：`classifyScore` 入参改 `mem.similarity`；`CONFIDENCE_DROP` 注释由「最终相关度」改为「相似度」。
5. 测试：
   - `tests/context/semantic.test.ts`：40 天前 `sim=0.9` 能通过（`score=0.45`）；`sim=0.4` 在 7 天内也被挡；`score` 仍用于排序（造三条同 `sim` 不同龄，断言顺序）；
   - `tests/context/recall.test.ts`：模糊分档按 `similarity` 判定，旧消息不再被判「模糊」；
   - `tests/context/pipeline*.test.ts`：`CONFIDENCE_DROP` 过滤改判 `similarity`；
   - `tests/core/agent-worker.test.ts`：L4 mock 补 `similarity` 字段，断言不变。

**验收：** 引擎全量绿 + typecheck/lint 绿；不涉及归档与 importance，normal 路径行为逐字节不变。

## 阶段 B（high 话题保留向量）

1. `memory/topic/compression-task.ts`：
   - 正常落档路径（`:197`）：`compressed.importance !== "high"` 时才 `deleteArchivedVectors`；
   - 注入检测降级路径（`:180`）：同上，判 `enriched.importance`；
   - `archiveOnly`（`:139`）：**不动**（无 importance）；
   - helper 加一行注释说明「high 保留依据决策 6」。
2. 测试 `tests/memory/compression-task.test.ts`：high 不调用 `deleteArchivedVectors` / normal 调用 / low 调用 / archiveOnly 调用（4 例）。

**验收：** high 话题归档后向量仍在（mock 断言未调用）；normal/low/archiveOnly 与现状一致。

## 阶段 C（放开归档排除 + 回读归档）

1. `memory/topic/store.ts`：
   - `archivedIdsCache` 每项加 `highIds: string[]`；
   - 新增 `archivedIdsByKeep(agentId): Promise<{ all: Set<string>; highKept: Set<string> }>`——同一份缓存派生，**不额外读盘**；importance 取自压缩档 frontmatter（复用 `parseFrontmatterBlock` + `normalizeImportance`）；
   - 保留 `archivedMessageIds` 供 `reconcile.ts` 使用（内部复用同一缓存）。
2. `core/agent-worker.ts:557`：`SemanticRetriever` 构造注入改 `archivedIdsByKeep`。
3. `context/semantic.ts`：
   - 构造参数类型改 `(agentId) => Promise<{ all, highKept }>`；
   - 排除改 `if (all.has(id) && !highKept.has(id)) continue;`；
   - **取内容补一跳**：先 `repo.getByIds(msgIds)`，取不到的 id 再 `repo.getArchivedByIds(missing)` 合并；仅对 topK 候选做，不全量扫；
   - `IMessageRepository` 类型已是完整接口，无需扩 types。
4. 测试：
   - `tests/context/semantic.test.ts`：high 话题原文在归档后仍能召回（含正文来自 `getArchivedByIds` 的断言）；normal 话题仍被排除；`all` 命中但 `highKept` 也命中时不排除；
   - `tests/memory/topic-store-msgids.test.ts`：`archivedIdsByKeep` 的 all/highKept 划分（high/normal/无 frontmatter 存量档按 normal）。

**验收：** 设计规格验收 1-5 全部有条件覆盖；`getArchivedByIds` 只在有缺口时调用（断言调用次数）。

## 阶段 D（文档销记 + 总闸）

- `架构文档.md` §4.4 L4 段：补「similarity 判准入 / score 只排序」「high 话题归档保留原文并可回读」「`semanticMinScore` 语义」；§9.1 内存表补 high 话题驻留估算；
- `路线图.md` 记忆节：向量记忆条目改为现口径；
- `API.md`：`semanticMinScore` 说明由「最终相关度」改「相似度」；
- 全量 `pnpm lint` + `typecheck` + `test`（Rust 闸门本机无 cargo，靠 CI）；文档与代码分两笔提交。

## 评审闸

独立 review 重点：① **恒等**——normal/low/archiveOnly 路径零行为变化；② **噪声**——放开衰减后低相似度内容是否会涌入（验收 3 专项）；③ **归档回读成本**——每轮是否可能全扫 `messages_archived.jsonl`，`getArchivedByIds` 调用次数与入参规模；④ **`semanticMinScore` 语义变更**的老配置兼容；⑤ **测试是否真的证明了"想起"**，而非又一次只测格式。

## 开放点

- **high 条目挤占 topK**：high 话题会同时有 L5 摘要与 L4 原文。先不做降权，跑实际效果；若明显挤占，后续给 high 条目 `score × 0.9`（记档，不在本单）。
- **归档回读的长期成本**：归档只增不减，`getArchivedByIds` 是流式全扫。当前只在 topK 候选有缺口时触发，规模上来后需评估按 id 预建索引。
- **内存长期增长**：high 话题向量不删，年增 27–53MB（按 10–20% 判 high 估）。触及 §9.1 触发条件时与「换库」一并处理。
- **sidecar supervisor 废弃**：`apps/desktop` 已删（`2f23679`），1209 行 supervisor 仍在 `main.rs:29` 无条件拉起 engine。另单处理，不在本次范围。
