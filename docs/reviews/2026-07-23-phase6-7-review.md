# Code Review：Phase 6（SOUL/MIND 基础框架）+ Phase 7（经验自动沉淀）

- 日期：2026-07-23
- 范围：commit `b59e526`（Phase 6）、`3b6cbde`（Phase 7），含 `src/mind/mind-files.ts`、`src/memory/topic/{compressor,types}.ts`、`src/core/agent-worker.ts`、`src/context/{recall,assembler,layers,pipeline}.ts`、`src/api/routes/agents.ts` 及两个 commit 的测试
- 评审人：kimi（作者自评，已按 review 纪律重新回读两个 commit 完整 diff、全部相关现状源码与 provider 发送层）
- 基线：设计文档 `docs/design/context-pipeline-v2.md` Phase 6 / Phase 7 两节（设计定稿）

## 总评

**可进下一阶段，建议先修唯一的 Major（M1，小改动）。** 设计定稿逐条核验全部落地（见下表），无 Blocker：append-only 在合并路径上确实只加不改，原子写复用 `renameWithRetry`（Windows 重试内建），提取/写入失败均不影响压缩主流程，注入正文与 frontmatter 物理隔离，L1 跨轮字节稳定（provider 发送层只发 role/content，`llm.ts:27-30`，id/createdAt 不上线）。M1 是去重算法在"共享前缀短标题"下的系统性误并——压缩 prompt 的示例会引导模型批量产出同前缀标题，误并不是小概率事件，建议进下一阶段前修掉。其余为 Minor：写失败恢复、解析鲁棒性、注入长度控制与若干一致性瑕疵，排期消化即可。

### 设计符合性逐条核对（全部通过）

| 设计定稿 | 核验结果 |
|---|---|
| P7-1 提取时机：压缩落档时同一次 LLM 调用顺手提取 | 通过。`agent-worker.ts:107-128`，`writeCompressedTopic` 成功后写 MIND；`compressor.ts:10-33` prompt 追加「经验：」区，0-N 条、没有留空、颗粒度定位（经验/教训/偏好，非事实流水账）已写入 prompt；压缩模型不变 |
| P7-2 写入 append-only，只加不改 | 通过。`mind-files.ts:280-318` 新块追加在文件末尾；合并路径 `262-271` 仅在已有块末尾插入一行补充，frontmatter 与原文不动（测试钉死）；唯一偏差是原块尾部空行被 `trimEnd` 规范化，不涉及内容 |
| P7-3 块结构带 frontmatter，≤0.5 不落盘 | 通过。`formatExperienceBlock`（`mind-files.ts:246-256`）格式与设计示例逐字段一致；`MIND_MIN_CONFIDENCE=0.5`（`234`），`> 0.5` 才写入（含 0.5 边界测试） |
| P7-4 写权限仅系统 | 通过。`appendMindExperiences` 全仓库唯一调用方是压缩回调（`agent-worker.ts:117`），无工具/路由暴露 |
| P7 去重：标题 token Jaccard ≥ 0.6 合并 | 通过（实现忠实，但算法本身有 M1 所述缺陷） |
| P7 注入侧不变：frontmatter 不参与打分、不进正文 | 通过。打分 haystack 仅 heading+content（`mind-files.ts:178`）；`mindToMessage`（`recall.ts:101-115`）由 heading+content 重组，frontmatter 物理隔离（含集成测试） |
| P7 失败处理：提取/写入失败不影响主流程 | 通过。`parseExperiences` 全链路不抛错（坏行跳过）；写入失败仅 warn 跳过（`agent-worker.ts:125-127`）；压缩失败原有路径不变 |
| P6 SOUL → L1 固定、缺失用默认模板、不含 MIND | 通过。`agent-worker.ts:216-225`，SOUL 在 skill 前；`loadSoul` 每轮新读、trim 后字节稳定；缓存前缀跨轮一致有 pipeline 级测试 |
| P6 MIND 命中块伪装 assistant 消息、热上下文之后 | 通过。`assembler.ts` 显式追加在归并后的 L3 之后、检索失败提示之前 |
| P6 新建 Agent 默认文件（SOUL 模板 + MIND 占位，不覆盖） | 通过。`agents.ts:27-30` + `ensureMindFiles`（`wx` 不覆盖） |

## Blocker

无。

## Major

- **M1. Jaccard 去重对共享前缀的标题系统性误并** — `mind-files.ts:232`（阈值）、`262-267`（合并判定）、`152-163`（tokenize）
  标题 token 化后集合很小，共享前缀会吃掉大部分 token 配额，使不同主题的经验越过 0.6 阈值被并入同一块。实例：「指挥官偏好：饮食」→ {指挥,官偏,偏好,饮食}，「指挥官偏好：穿搭」→ {指挥,官偏,偏好,穿搭}，交 3 并 5，Jaccard = 0.6，恰好达到合并线——饮食经验与穿搭经验被并入同一块，检索时张冠李戴。这不是边缘案例：`compressor.ts` prompt 的示例（「指挥官讨厌 emoji」）会引导模型批量产出「指挥官偏好：…」式同前缀标题，误并在正常使用中稳定发生。后果不丢数据（append-only，可人工修复），但经验结构被静默污染，与 P7-2 的可审计目标相悖。现有测试只覆盖了 0.6 边界的正例（`mind-append.test.ts`「Jaccard = 0.6 边界也合并」），无误并反例。
  建议：合并判定加双重门槛——Jaccard ≥ 0.6 且共享 token 数 ≥ 2（「指挥官偏好：饮食/穿搭」共享 3 个仍过线，需再配合：标题按冒号/破折号分段，主体段（末段）无共享 token 则不并）；或按设计预留直接上 LLM 合并判定。无论哪种，先补误并反例测试。

## Minor

- **写失败整批经验永久丢失，且遗留孤儿 tmp** — `mind-files.ts:310-317`、`document-store.ts:24-39`
  `renameWithRetry` 对 EPERM/EBUSY/EACCES 重试 5 次（约 300ms 窗口）。Windows 上 MIND.md 被占用（杀毒扫描、带锁编辑器打开审计）超过该窗口即抛错，本批经验永久丢失（不会重新提取，下一话题的写入也不带旧批），仅一行 warn；同时遗留 `MIND.md.tmp` 孤儿文件（下次写入覆盖，仅观感问题）。符合 P7「失败仅 warn」定稿，但丢失面可收窄。
  建议：写入失败时把该批经验以附录形式落到压缩档 sidecar（或独立 failed-experiences 日志），支持人工/后续恢复。
- **FRONTMATTER_RE 会把块首用户自定义的 `---` 段误判为 frontmatter 吞掉** — `mind-files.ts:83`
  块正文若以 `---` 横线开头且后方存在第二个 `---` 行（用户手写分隔线、模型输出习惯），整段被当作 frontmatter 消费，content 丢失该段（无字段可解析时静默丢弃）。当前写入路径不会产生这种内容，但 MIND.md 同时面向人手编辑。
  建议：围栏段至少解析出一个已知字段（source/created/confidence）才按 frontmatter 处理，否则视为正文。
- **merge 与 append 两条写入路径对正文处理不一致，导出函数缺防御** — `mind-files.ts:262-271` vs `246-256`
  merge 把补充行 `\s+` 压成一行，append 原样写入 `text.trim()`。当前唯一数据源（`parseExperiences` 单行正则）保证单行，无现实漏洞；但 `appendMindExperiences` 是导出 API，未来调用方传入多行文本（含行首 `##`、`---` 围栏样式）会直接破坏块结构。
  建议：append 前同样压行，并拒绝/转义行首 `##` 行；补伪造输入测试。
- **MIND 注入无长度控制，合并只增不减可无限膨胀** — `recall.ts:101-115`
  L4/L5 注入有 P5 设计决策 7 的 500 字摘要化，MIND 没有；块经合并持续变长，又声明永不降级（P6 决策），长期会静默挤压 L3/L4/L5 预算（它们被先降）。当前量级小，属慢燃问题。
  建议：注入时对单块套用 `summarizeContent`，或按 created/confidence 做截断；规模上来后与 embedding 检索一并评估。
- **空 SOUL 文件导致 L1 瑕疵** — `agent-worker.ts:216-225`、`mind-files.ts:71-80`
  SOUL.md 存在但内容为空时 `loadSoul` 返回 `""`：无 skill 则 L1 整条缺席（人格不再"永不缺席"），有 skill 则 L1 以 `"\n\n"` 开头。
  建议：空内容回退默认模板，或 `promptParts` 压入前过滤空串。
- **MIND.md 读取失败不走 retrievalFailed，与 L4/L5 口径不一致** — `agent-worker.ts:273-283`
  L4/L5 失败会尾随 system 消息明确告知（P5 诚实透明），MIND 非 ENOENT 读失败仅 console.warn，模型与用户无感。
  建议：非 ENOENT 失败同样置 `retrievalFailed`（或扩展告知文案覆盖经验档案）。
- **POST /agents：文件生成失败时 agent 已创建但返回 500** — `api/routes/agents.ts:27-30`
  `agentRepository.save` 成功后 `ensureMindFiles` 抛错（磁盘/权限）会让路由 500，客户端误以为创建失败而重试（重试幂等可恢复，但状态不一致）。
  建议：`ensureMindFiles` 失败降级为 warn（两文件均可懒创建：loadSoul 有模板兜底、append 会自建 MIND.md），或返回明确的 partial 状态。
- **同一经验被重复提取时块内出现重复行** — `mind-files.ts:262-271`
  不同话题产出标题+正文相同的经验时，merge 把相同句子逐字重复追加（无行级去重）。
  建议：merge 前检查补充行是否已存在于目标块正文。
- **新旧 worker 可并发 append 同一 MIND.md（窄竞态）** — `bootstrap.ts:66-73`、`mind-files.ts:280-318`
  agent.json 变更即删建 worker，旧 worker 在飞的压缩回调与新 worker 的回调可并发进入 append（读-改-写无锁），丢一个批次。窗口很窄，但随配置热更新频率上升会放大。
  建议：per-agent 写串行化（复用 `DocumentStore.enqueueWrite` 模式），或 append 内做 mtime 校验重读。
- **测试缺口** —
  1. worker 层「沉淀失败仅 warn、压缩主流程不受影响」的 catch 分支（`agent-worker.ts:125-127`）无测试；
  2. M1 误并反例无测试（只测了 0.6 边界正例）；
  3. 伪造输入（块首 `---`、多行正文、行首 `##`）无测试；
  4. 旧格式压缩回复（无「经验：」区）未显式断言 `experiences = []`（现有旧测试未覆盖该字段）；
  5. `loadMindChunks` 非 ENOENT 错误 rethrow 路径、`ensureMindFiles` 部分失败路径未测。

## 亮点

- **写入顺序正确**：先 `writeCompressedTopic` 成功才沉淀（`agent-worker.ts:112-128`），落档失败不产生无源经验；归档失败隔离压缩档时已沉淀经验保留——经验源自真实对话，该取舍合理。
- **解析全链路 no-throw**：`parseExperiences` 正则限定 + 坏行跳过 + 置信度 clamp/NaN 防护（`compressor.ts:111-124`）；`parseFrontmatter` 字段缺失安全降级（`mind-files.ts:93-108`）。
- **原子写复用既有基建**：tmp+rename + Windows 重试直接复用 `renameWithRetry`，与压缩档同一模式，没有发明第二套。
- **frontmatter 物理隔离干净**：解析只在块首识别围栏段，打分与注入均不接触 frontmatter；注入由 heading+content 重组而非复用 raw，从结构上杜绝了 frontmatter 泄漏到上下文。
- **压缩解析区间隔离**：`sectionLines` 按区截取，关键结论不吃经验区 dash 行（`compressor.ts:77-85`），且有专项测试。
- **测试颗粒度好的部分**：Jaccard 0.6 精确边界、同批次连续去重、合并不动 frontmatter、confidence 0.5 边界、注入位置与失败提示的相对顺序——关键不变量大多有钉子。
- **缓存纪律核验通过**：provider 发送层只发 role/content（`llm.ts:27-30`），L1 = trim 后的 SOUL + 固定拼接的 skill 内容，跨轮字节稳定；MIND 注入位于动态尾部，不污染前缀。

## 结论

无 Blocker，1 个 Major（M1 去重误并），10 个 Minor。**可以进下一阶段，但建议先用小改动修掉 M1**（合并判定加主体段约束 + 误并反例测试，预计几十行内）；Minor 按上表排期消化，其中「写失败恢复」「注入长度控制」建议优先于其余。
