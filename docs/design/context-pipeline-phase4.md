# ContextPipeline Phase 4 实施前报告

> 日期：2026-08-19 | 状态：待批准后实施
> 依据：[`docs/design/context-pipeline-v2.md`](./context-pipeline-v2.md)（Phase 4 节 + 设计决策 3/4/6 + 五、实施路线）、[`docs/路线图.md`](../路线图.md) §七 下一步建议、当前代码核实（行号见文中）

---

## 一、当前情况（Phase 1–3、5–7 后的真实状态）

### 已实现（与本报告相关的事实基线）

- **分层组装与降级**：L1/L3/L4/L5/L6 分层 + 降级序 L5→L4→L6-ext→L3 全部在位（`context/pipeline.ts`、`downgrade.ts`；L2 层因无生产者已于 2026-08-18 删除）
- **话题检测**：规则版三规则（切换词/30 分钟窗/20 条阈值，`memory/topic/detector.ts`）+ **方案 C 的 LLM 裁判链已存在**——每攒 6 轮异步语义判切（`memory/topic/judge.ts`，模型链 topicBoundaryModel→compressionModel→主模型）+ 压缩前复核拆分混合段（`compression-task.ts`）
- **压缩**：单程 LLM 调用（`memory/topic/compressor.ts:143-169`）同时产出摘要 + 关键结论 + MIND 经验（Phase 7）；**`importance` 字段恒为 `"normal"`**（`compressor.ts:160` 硬编码，从未由模型赋值）
- **归档与回忆**：先归档后删热存储原子序、`recall` 工具（topics 浏览 + read 取原文）、启动对账三路
- **L5 注入**：最近 `hotMemoryCount`（默认 2）个压缩档注入，无重要性加权
- **L4 时间衰减**：分段衰减（<7d 1.0 / <30d 0.8 / <90d 0.5 / 保底 0.3，`context/semantic.ts`）；设计决策 5 的「importance=high 不衰减」**从未生效**（importance 恒 normal）
- **memories.jsonl（长期记忆存储）**：仓储与 REST 只读端点存在（`memory/repositories/memory.ts`、`api/routes/memory.ts`），但**生产代码无任何写入方**——与 H1 修复前的 actions.jsonl 同型空壳，当前是死存储

### 设计文档与代码的偏差（Phase 4 要先消化的）

| 设计/文档项 | 现状 | 处置建议 |
|---|---|---|
| Phase 4「LLM 版话题检测」 | 方案 C 裁判+复核已实质覆盖该意图 | **不重复建设**；Phase 4 只在其边界上做增量（见计划项 3） |
| 决策 3：`embedding_id` 预留 | 恒为空串；L4 排除与向量删除都走 msg_ids，不依赖它 | **正式放弃**（本文档销记，设计文档标注） |
| 决策 4：「每周校验归档」 | 从未实现；启动对账已覆盖主风险 | **不建**周期性校验（记录为不做） |
| 决策 6 / Phase 3 欠项：压缩前 memory flush | 未实现 | **Phase 4 主项**（见计划项 1） |
| Phase 4：双程压缩 | 未实现（复核拆分≠双程精炼） | Phase 4 主项（计划项 2） |
| Phase 4：差异化保留 | 不可能实现（importance 恒 normal） | Phase 4 主项（计划项 3） |
| Phase 4：用户可审计接口 | 无（`_compressed/` 只能翻文件系统） | Phase 4 主项（计划项 4） |

---

## 二、Phase 4 计划（四项 + 批次划分）

### 项 1：memory flush（压缩前关键事实落库）

**设计**（对齐决策 6 + Phase 7 的零边际成本手法）：压缩调用本就产出「关键结论」，flush 在同一次调用里增加一个产出区——「值得长期记住的事实/决策/情感表达」，写入 `memories.jsonl`（它因此获得首个生产写入方）。与 MIND.md 的分工：MIND 沉淀**经验/偏好**（「我学到什么」），memories 沉淀**事实**（「发生了什么值得记住的事」）。

- 检索可达性：flush 条目 embed 后入向量索引（doc_id `mem:<recordId>`），L4 可召回——这是 flush 相对「只进摘要」的核心价值（决策 6 的理由：LLM 摘要注定有损，关键信息不依赖摘要保留）
- 护栏：复用 Phase 7 的置信度口径（≤0.5 不落盘）与防注入声明；append-only
- 面板：`GET /memory/:agentId`（既有只读端点）自然可见，前端记忆页暂不做（见项 4）

### 项 2：双程压缩（two-pass）

**设计**：压缩从单程变两程——第一程产出草稿（摘要+关键结论+经验+flush，与现 prompt 同），第二程把草稿+原文交给模型做**修订**（纠偏、补漏、去噪），产出最终档。模型链沿用 compressionModel（便宜模型两程同模型）。

- 成本：压缩调用 ×2（便宜模型，可接受）；任一程失败回退单程现状（永不更差）
- 与既有复核拆分的关系：复核拆分在前（多话题拆段），双程精炼在后（每段各自两程）
- Agent 级开关：`twoPassCompression`（缺省关——先灰度，观察质量收益再考虑默认开）

### 项 3：importance 真实化 + 差异化保留

**设计**：
- 裁判链（judge）在判 NEW_TOPIC 时顺手评重要性（high/normal/low，同一调用零边际成本；复核拆分路径由压缩调用兜底评）
- 差异化保留两处处生效：① L5 注入——最近 hotMemoryCount 个之外，**最近一个 importance=high 的压缩档始终注入**（防高重要话题被挤出）；② L4 时间衰减——importance=high 的记忆不衰减（兑现设计决策 5 的未实现承诺）
- 迁移：存量压缩档 importance=normal 不变（无需迁移）

### 项 4：用户可审计接口

**REST（本项主体）**：
- `GET /agents/:id/topics`——压缩档列表（label/时间/消息数/importance/来源场景，读 `_compressed/*.md` frontmatter，复用 store 的指纹缓存）
- `GET /agents/:id/topics/:topicId`——单档全文（Summary + Key Points + frontmatter）
- `POST /agents/:id/topics/:topicId/restore`——把该档的消息从归档**恢复到热存储**（防重复恢复：已在热存储的 id 跳过；恢复后该档标注/移除策略见下）

**恢复语义**（需决策点，见下节）：恢复后压缩档保留（历史记录）还是删除（热存储原文回来了，摘要挡就重复了）？**建议：恢复即删除压缩档**（L5 不再注入该摘要，原文回热存储正常进 L3/L4；归档行保留不动，等于双轨各归其位）。

### 批次划分（每批：实现 → 独立验证 → commit）

| 批次 | 内容 | 主要文件 |
|---|---|---|
| **P4-a** | 项 1（memory flush）+ 项 3 的 importance 赋值（裁判/压缩链） | `memory/topic/compressor.ts`、`judge.ts`、`compression-task.ts`、`memory/indexer.ts`、`agent-worker.ts` |
| **P4-b** | 项 3 的差异化保留（L5 高重要常驻 + L4 不衰减） | `context/pipeline.ts`、`context/semantic.ts`、`agent-worker.ts` |
| **P4-c** | 项 2（双程压缩，Agent 级开关缺省关） | `memory/topic/compressor.ts`、`compression-task.ts` |
| **P4-d** | 项 4（审计 REST 三端点 + 恢复语义） | `api/routes/`、memory/topic/store.ts、repositories/message.ts |
| **P4-e** | 文档销记（embedding_id 放弃、每周校验不建、架构文档/路线图/设计文档同步） | docs/ |

顺序理由：P4-a 先让 importance 有真值，P4-b 的保留才有意义；双程与审计接口独立；文档收尾。

### 明确不做（本周期）

- LLM 版话题检测重建（方案 C 已覆盖意图）
- `embedding_id` 接入（正式放弃）
- 周期性归档校验（启动对账已覆盖）
- 审计接口的前端 UI 页（REST 先行，UI 看使用反馈再说）
- MIND.md 的 LLM 合并/衰减（规模未到，Phase 7 已记留待）

---

## 三、计划完成的最终结果（验收标准）

1. **memory flush 闭环**：一次话题压缩后，`memories.jsonl` 出现带置信度的关键事实条目（无可沉则不写），且该条目可被 L4 语义检索召回（向量索引含 `mem:` 条目）；压缩失败的回合不产生 flush 孤儿（沿用 M12 的「归档成功后才沉淀」纪律）
2. **双程压缩**：开启 `twoPassCompression` 的 agent，压缩档质量经修订程产出（草稿不落地，最终档为修订产物）；关闭的 agent 行为逐字节不变；第二程失败回退单程
3. **差异化保留**：importance=high 的话题在 L5 常驻注入（不被新话题挤出）且 L4 检索不衰减；importance 由裁判/压缩链真实赋值，存量档不受影响
4. **可审计**：三个 REST 端点可用（列表/全文/恢复），恢复后原文回热存储、压缩档删除、L5 不再注入该摘要；全部经测试钉住
5. **工程基线不破**：`pnpm verify` 全绿；新增行为全部行为级测试；文档与代码一致（Phase 4 状态、设计文档销记）

**性能口径**：assemble 延迟不进热路径（flush/双程都在后台压缩队列）；双程仅在压缩时多一次便宜模型调用。

---

## 四、开放点 → 已定决策（2026-08-19 指挥官拍板）

1. **恢复即删档**（已定）：恢复后压缩档删除——原文回热存储正常进 L3/L4，摘要不再与原文重复在场；归档行保留不动（双轨各归其位）
2. **双程压缩缺省关**（已定）：Agent 级开关 `twoPassCompression` 缺省关，灰度观察后再议默认
3. **flush 颗粒度**（已定）：每条一句话事实 + 置信度（≤0.5 不落盘），上限 5 条/话题防灌水

> 按 P4-a → P4-b → P4-c → P4-d → P4-e 开工（老流程：主线计划、子代理实现、独立验证、逐批 commit）。
> 实施细化（P4-a 期定稿）：importance 由**压缩调用**赋值（它能看全段内容，比边界裁判看得多），裁判链不动。
