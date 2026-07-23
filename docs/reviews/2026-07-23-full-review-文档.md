# CMZ 全面 review 第 3 块：文档对齐

- 审查日期：2026-07-23
- 审查对象：main @ 1768e96（工作树干净）
- 审查方式：只读核对，未修改任何代码或文档；每条失实均附代码证据（文件:行号）
- 实测基准：`pnpm --filter @mindcloud/engine test` = 71 文件 / 527 用例全绿；`pnpm --filter @mindcloud/web test` = 22 文件 / 96 用例全绿；`cargo test`（zome-sidecar）= 14 用例全绿；e2e spec 2 个（`tests/e2e/chat.spec.ts`、`logs.spec.ts` 各 1 个 `test(`）

**总计：Blocker 0 / Major 9 / Minor 13（另有观察项 4 条）**

---

## 1. README.md（1 Major / 1 Minor / 1 无法验证）

整体对齐度高，L28-41 的核心功能宣称（WS 分帧、@mention 路由、7 内置工具、ContextPipeline L1-L6、原子写、HNSW、Skill 三目录、Plan、cron、算力平台、蓝图、双模式、sidecar 守护）逐条找到真实实现证据，常用命令与技术栈表也全部核对一致。

### Major

**M1. `pnpm dev` 并非"同时启动 engine + web"，还会连带启动桌面端**

- 声称：README.md:71-74 `pnpm dev` 注释为"同时启动 engine + web"；README.md:79-83 另设第 4 节"启动桌面"，暗示桌面需单独命令。
- 实际：根 `package.json:7` 为 `"dev": "turbo run dev"` 无 filter；`turbo.json:6` 无排除规则；`apps/desktop/package.json:9` 的 `dev` 是 `tauri dev`。`pnpm dev` 实际并发拉起 engine + web + shared + **desktop（完整 Rust 编译并弹窗）**，与文档职责划分直接矛盾，快速开始用户会意外等待数分钟 Rust 构建。

### Minor

**m1. 克隆地址为占位符，与真实 remote 不符**

- 声称：README.md:59 `git clone https://github.com/yourname/MindCloud-Zome.git`
- 实际：真实 remote 为 `https://github.com/JIUYUE-SEP/CloudMind-Zome.git`，用户名与仓库名均不匹配，照抄会 404。

### 无法验证（非失实）

- README.md:54 `protoc 27+`：protoc 依赖属实（`crates/zome-sidecar/build.rs:2` 用 `tonic_build::compile_protos`），但"27+"下界在仓库内无依据，本环境无法验证。

---

## 2. docs/路线图.md（0 Major / 2 Minor + 数字过时）

质量较高："已实现"约 30 条子声明中 29 条找到真实实现证据，"部分实现"6/6、"规划中"9/9、"废弃"6 项中 5 项属实，无"声称完成但完全无实现"的前科类问题。

### Minor

**m1. Phase 3 跨场景标注格式描述过时**

- 声称：路线图.md:21 "跨场景 `[来自: sessionId]` 标注"
- 实际：该格式已在"记忆自然化"重构中移除，现为自然语言"在另一个对话里"（`services/engine/src/context/recall.ts:72-75`）；测试明确断言旧格式不存在（`services/engine/tests/context/pipeline.test.ts:227-228`）。功能本身存在，仅文档格式过时（`docs/design/context-pipeline-v2.md:386` 同样残留）。

**m2. Python 后端移除日期失实（偏差 10 天）**

- 声称：路线图.md:96 "Python 后端（`backend/`）与旧 Tauri 前端（`frontend/`）| 2026-07-02 移除"
- 实际：移除提交 `f390431` 的日期为 **2026-07-12**；2026-07-02 是所引设计文档的日期。

### 数字失实（见第 9 节核对表）

- 路线图.md:59 声称 engine "66 个测试文件 / 450 用例"，实测 71 / 527，数字过时（Minor 级，随第 9 节一并记录）。

---

## 3. docs/架构文档.md（2 Major / 1 Minor）

抽查约 30 处声明仅 3 处失实，模块清单、WS 协议、群聊路由、ReAct 参数、话题压缩、L4 检索、MIND、基础设施、前端页面等均核对一致。无"写了但代码完全没有"的模块（无 Blocker）。问题集中在 Phase 5 "记忆自然化注入"（recall.ts）未回写文档。

### Major

**M1. L4/L5 注入机制描述整体过时（"自然化注入"未入档）**

- 声称：架构文档.md:157-158（L4 为"语义检索结果 score 降序"、L5 为"话题摘要时间倒序"）、:178（取最近 hotMemoryCount 个压缩档渲染进 L5）、:187（注入按 2000 字符截断、`[来自: sessionId]` 标注）、:184（L4 仅以 semanticMinScore 过滤）。
- 实际：注入走 `services/engine/src/context/recall.ts` 的"记忆自然化"方案：
  - L4/L5 伪装成第三人称 user 历史消息，按 createdAt 与 L3 归并穿插（`context/assembler.ts:50-58`）；
  - 置信度三档：>0.7 注入、(0.5,0.7] 模糊化、≤0.5 丢弃（`recall.ts:14-16,21-25`；`pipeline.ts:108` 的 CONFIDENCE_DROP 是 semanticMinScore 之外的额外门槛，文档未提）；
  - 单条注入上限 500 字符（`recall.ts:18` MAX_MEMORY_CHARS=500），2000 仅存在于检索侧（`semantic.ts:54`）；
  - `[来自: sessionId]` 标注已不存在（全库 grep 无命中，改为"在另一个对话里"，`recall.ts:73`）；
  - 检索失败尾随 system 消息告知（`recall.ts:119`），文档完全未提。
- 主链路数据流描述与实现不符，且整个 recall 机制未入档。

**M2. §3.1 目录结构遗漏一级模块 `services/engine/src/mind/`**

- 声称：架构文档.md:74-99 目录树列出 engine src 下 14 个目录，无 `mind/`。
- 实际：`services/engine/src/mind/mind-files.ts` 存在（Phase 6/7 产物，SOUL/MIND 加载、检索、沉淀去重）；文档 §4.3 正文（:154/:162）有引用该文件，但目录树漏列。

### Minor

**m1. §3.1 context/ 子文件清单未列 `recall.ts`**

- 声称：架构文档.md:78 "src/context/ # ContextPipeline（layers/downgrade/assembler/semantic/token-counter/truncate/pipeline）"
- 实际：`services/engine/src/context/recall.ts` 存在且是 L4/L5/MIND 注入核心（随 M1 一并补录即可）。

---

## 4. docs/API.md（0 Major / 2 Minor）

**本次审查中质量最高的文档。** 49 个 REST 端点全部存在且方法/路径一致（Health 1 + Agents 5 + Chat 1 + Sessions 6 + Compute 9 + Config 3 + Blueprints 6 + Scheduler 4 + Plans 7 + Subagents 2 + Memory 2 + Actions 1 + Skills 1 + Logs 1）；2 个 WS 端点、3 类客户端帧、9 类服务端帧全部核对一致。此前踩过的 provider vs providerId 类字段名问题未再出现：AgentConfig 7 个字段与 `packages/shared/src/index.ts:21-33` 逐字一致，默认值也与代码一致。

### Minor

**m1. "clamp" 措辞不准**

- 声称：API.md:41 "非法取值（如 `topicMessageThreshold < 4`、`semanticTopK < 1`）由引擎 clamp 并 warn"
- 实际：`topicMessageThreshold < 4` 确为 clamp 到 4（`memory/topic/types.ts:83-88`）；但 `semanticTopK < 1` 是重置为默认值 10（`context/semantic.ts:30-32`），非 clamp。

**m2. WS Origin 白名单描述不完整**

- 声称：API.md:152 "握手时校验 Origin（无 Origin 的非浏览器客户端放行；NODE_ENV=e2e 全放行）"
- 实际：另有第三条放行规则——`tauri://` 协议及 `*.tauri.localhost` 域直接放行（`api/ws/validation.ts:23-24`），文档遗漏桌面端白名单。

---

## 5. docs/开发指南.md（1 Major / 1 Minor + 数字过时）

整体质量良好：章节编号 1-7 连续无错位（此前的错位问题无残留）；14 条命令全部有效（脚本名、filter 包名均与 package.json 一致）；关键文件表、路由清单、环境变量表、WS 帧名、Tool 接口字段等均核对一致。

### Major

**M1. `services/engine/tests/bench/` 路径不存在**

- 声称：开发指南.md:333 "`services/engine/tests/bench/` — benchmark"
- 实际：`services/engine/tests/` 下无 `bench` 目录；benchmark 实际位于 `services/engine/bench/`（document-store.bench.ts、react.bench.ts、repositories.bench.ts），engine package.json 的 `bench: "vitest bench"` 也指向该目录。

### Minor

**m1. "当前测试覆盖"清单不完整**

- 声称：开发指南.md:318-334 测试覆盖清单
- 实际：清单遗漏实际存在的 `tests/topic/`（5 个测试文件，L253 本文自己还引用过）、`tests/mind/`、`tests/helpers/`、根级 `placeholder.test.ts`；同时把不存在的 `tests/bench/` 列入（见 M1）。

### 数字失实

- 开发指南.md:316 声称 engine "66 文件 450 用例"，实测 71 / 527（见第 9 节）。

### 观察项

- 开发指南.md:357 "核心模块覆盖率 ≥ 70%"：`vitest.config.ts` coverage 块未配置任何阈值，该数字仅是目标，CI/配置层面无强制。

---

## 6. docs/design/context-pipeline-v2.md（4 Major / 5 Minor / 1 观察项）

与前科不同：文档声称的组件全部真实存在且有测试佐证（Phase 1/2/3/5/6/7 抽查均通过，13 个 mock 集成测试、recall.test.ts 17 例等均属实）；文中对旧 Python 实现的引用（行 4、505-506）均为 `git show f390431^:` 形式的显式历史引用，commit 真实存在，未发现把已删代码说成现存。问题集中在"已确认不再变更"的冻结决策被实现静默偏离。

### Major

**M1. 冻结决策 1 的关键词规则被静默放弃**

- 声称：context-pipeline-v2.md:278-281（"已确认，不再变更"）规则含"连续 5 条消息没有实体重叠（关键词匹配）→ 新话题"；:372 称"关键词边界留 Phase 3"；:382 标 Phase 3 已完成。
- 实际：`memory/topic/detector.ts:25-44` 只有数量阈值、显式切换词、时间窗三条规则，无实体重叠/关键词检测；Phase 3 完成项（:384-389）不含关键词边界，也无任何处披露该规则被放弃。冻结决策被实现悄悄偏离。

**M2. 冻结决策 4 的"每周校验"无任何实现**

- 声称：context-pipeline-v2.md:323-324（"不再变更"）"每周校验归档消息都有对应压缩档，缺失则告警"；同决策称"压缩档 msg_ids 指向归档行号"。
- 实际：全仓无周/周期性校验任务（`scheduler/` 是用户任务 cron，与归档无关）；仅有启动对账 `reconcile.ts`（`bootstrap.ts:255-262`），覆盖另一类孤儿。且压缩档存的是消息 id 列表（`memory/topic/store.ts:42-44`），非归档行号。保护性决策未实现且未披露。

**M3. embedding_id 承诺"Phase 3 接入"，Phase 3 已完成但仍恒为空**

- 声称：context-pipeline-v2.md:375（Phase 2 完成项）"frontmatter 预留 embedding_id，Phase 3 接入"；:302-317 决策 3 称 embedding_id 关联向量库支持反查；:382 标 Phase 3 已完成。
- 实际：`memory/topic/store.ts:25` 写入 `embedding_id: ${topic.embeddingId ?? ""}`，但 `embeddingId` 在全代码库从未被赋值（`memory/topic/types.ts:36` 注释仍写"预留"），所有压缩档该字段恒为空串。

**M4. grok-build 对照表中的两个"CMZ v2 对应"配置不存在**

- 声称：context-pipeline-v2.md:261-264 `config.thresholdRatio`(0.8)、`config.flushBeforeCompress`(true) 作为 v2 对应项；:241-244 伪代码描述超阈值才触发 assemble；:499 验收 4 称"触发比例…可在 config 里调整"。
- 实际：`ContextPipelineConfig` 只有 `maxContextTokens`/`reserveRatio`（`context/pipeline.ts:10-15`），全仓无 `thresholdRatio`；memory flush 未实现（文档 :382 自己承认"留待 Phase 4 评估"，与表格自相矛盾）；`react/turn.ts:47-54` 每轮无条件 assemble，无阈值预检，"触发比例"无从配置。

### Minor

**m1. 头部状态行漏掉 Phase 7**

- 声称：context-pipeline-v2.md:5 "Phase 1/2/3/5/6 已实现"
- 实际：正文 :445 已标 Phase 7 已实现且代码确认存在（`mind/mind-files.ts`），头部未同步。

**m2. Phase 7 去重口径过时**

- 声称：context-pipeline-v2.md:468/:476 "Jaccard ≥ 0.6 并入已有块"
- 实际：实现为双重门槛（整体 Jaccard ≥ 0.6 且主体段共享 token，`mind/mind-files.ts:251-262`，review M1 修复，commit `c12a912`）。

**m3. 测试例数过期**

- 声称：context-pipeline-v2.md:443 `mind-files.test.ts`（13 例）；:481 "engine 测试全绿（522 例）"
- 实际：mind-files.test.ts 15 例；engine 实测 527 例（本次实跑全绿）。

**m4. 冻结决策 5/6 的 importance 相关部分未实现（有披露，降级 Minor）**

- 声称：context-pipeline-v2.md:340 "重要记忆（importance: high）不衰减，永远 1.0"；:348 "high 话题保留更多原文引用"
- 实际：L4 路径无 importance 概念（`context/layers.ts:8-16` 的 SemanticMemory 无该字段，`context/semantic.ts:45-51` 无重要性分支）；importance 恒 `"normal"`（`memory/topic/types.ts:31`）。文档 :385 已披露"待 v2 话题检测启用后接入"，故降 Minor。

**m5. msg_ids 位置与恢复函数名描述错误**

- 声称：context-pipeline-v2.md:218 "msg_ids 保留在 frontmatter 中，可通过 `getByIds` 从归档恢复"
- 实际：msg_ids 在正文 `## Messages Archived` 段（`memory/topic/store.ts:42-44`）而非 frontmatter；归档恢复走 `getArchivedByIds`（`memory/repositories/message.ts:54-59`），`getByIds` 只读热存储（同文件 :34-39）。功能存在，位置与函数名描述错。

### 观察项

- 第六节验收 1"1000 轮长对话不报错"与验收 2"assemble 延迟 < 100ms"无自动化证据（无对应测试，`bench/` 下无对应基准）。文档未声称已达，列为提醒。

---

## 7. IDEA.md（0 Major / 1 Minor，偏移记录）

IDEA.md 全文仅 1 行（:1"一个多agent项目"），无法承担"初心对照基准"的作用。

- 已兑现：多 agent 初心落地且形态完整——Agent CRUD（`services/engine/src/api/routes/agents.ts`）、子 agent 体系（`src/subagent/`、`api/routes/subagents.ts`）、多 Agent 调度（`src/scheduler/`、`src/blueprint/`）、技能系统（`src/skills/`）、多 Provider 算力中枢（`api/routes/compute.ts` + `apps/web/pages/compute.vue:5`）。方向无偏移。
- 偏移量：项目的实际愿景（本地优先、记忆系统、桌面+Web 双形态、MIND 注入等）全部沉淀在架构文档与 README，IDEA.md 未随项目演进，已名存实亡（Minor，文档维护问题）。

---

## 8. docs/DEPLOY.md（1 Major）与 docs/issues/

### DEPLOY Major

**M1. 步骤 2 的构建范围与顺序自相矛盾**

- 声称：DEPLOY.md:19-20 `pnpm build` 注释为"构建 engine 和 web"，sidecar 二进制在步骤 4 才准备。
- 实际：根 `pnpm build` = `turbo run build`（`package.json:8`），`turbo.json:5` 未排除 desktop，而 `apps/desktop/package.json` 的 `build` 就是 `tauri build`；`tauri.conf.json:29` 声明 `externalBin: ["binaries/zome-sidecar"]`，该二进制要等步骤 4 `prepare-sidecar.mjs release` 才存在（`scripts/prepare-sidecar.mjs:26-31` 缺二进制直接退出）。干净机器上执行步骤 2 会连带触发完整 tauri 构建并因 sidecar 未就位而失败。

DEPLOY 其余条目核对一致：Node 22 / Rust 1.88 / protoc 依赖、prepare-sidecar 参数与产物路径、engine start / web preview、端口 3000/8848/50051、数据目录、算力中枢添加 Provider 流程均属实。

### docs/issues/

仅 1 个文档 `2026-07-17-scheduler-flaky.md`，第 6 行已标"已解决"，修复证据复核全部属实（`tests/scheduler/scheduler.test.ts:87` 去墙钟化、`memory/document-store.ts:24` renameWithRetry、`tests/memory/document-store.test.ts:18-30` 回归测试）。**无"已解决未关闭"的 issue。**

---

## 9. 数字核对表（文档值 vs 实测值）

实测基准：2026-07-23 本机实跑。

| 数字 | 文档出处 | 文档值 | 实测值 | 结论 |
|---|---|---|---|---|
| engine 测试 | 路线图.md:59、开发指南.md:316 | 66 文件 / 450 用例 | 71 文件 / 527 用例（全绿） | 失实（过时，Minor） |
| engine 测试 | context-pipeline-v2.md:481 | 522 例 | 527 例 | 失实（过时，Minor） |
| web 测试 | 路线图.md:59、开发指南.md:316 | 22 文件 / 96 用例 | 22 文件 / 96 用例（全绿） | 一致 |
| sidecar 测试 | 路线图.md:59、开发指南.md:316 | 14 用例 | 14 用例（crypto 2 + grpc 3 + tokenizer 2 + vector 7，全绿） | 一致 |
| e2e | 开发指南.md:316 | 2 用例 | 2 个 spec 各 1 个 `test(` | 一致 |
| mind-files 测试 | context-pipeline-v2.md:443 | 13 例 | 15 例 | 失实（过时，Minor） |
| Python 后端移除日期 | 路线图.md:96 | 2026-07-02 | 2026-07-12（commit f390431） | 失实（Minor） |
| L1.5 移除 | 路线图.md:99 | 2026-07-21 / ba7f726 | 一致 | 一致 |
| 文档更新日期 | 路线图.md:3、开发指南.md:3 | 2026-07-22 | 距今 1 天 | 新鲜 |
| Node 版本 | README.md:53、开发指南.md:13 | 22+ | `.nvmrc` = 22 | 一致 |
| Rust 版本 | README.md:53、开发指南.md:14 | 1.88 | `rust-toolchain.toml:2` = 1.88 | 一致 |
| Fastify | 开发指南.md:18 | 5 | `services/engine/package.json:25` ^5.3.0 | 一致 |
| protoc | README.md:54、开发指南.md:15 | 27+ | 依赖属实，版本下界无法验证 | 未证实 |
| 消息上限 10000 / maxSteps 5 / 截断 20% / 30min·20 条 / 7 工具 / 审批 60s / subagent 120s / 轮询 5s / gRPC 5 方法 | 路线图.md:15-56 | — | 逐项核对一致 | 一致 |

---

## 10. 孤儿文件与 .gitignore

- `nul`（91B，2026-06-22，Windows 保留名误写）：未被 git 跟踪，`.gitignore:47` 已正确忽略。不该进 git（现状正确），但磁盘上的垃圾文件本身建议清理。
- `engine_test.log`（1966B，2026-06-26）：未跟踪，`*.log`（.gitignore:20）覆盖。同为磁盘垃圾，建议清理。
- `test-results/`：`/test-results/`（.gitignore:56）覆盖，未跟踪，处理正确。
- `.review-tools/`：空目录残留（2026-07-16 后无内容）。git 不报告空目录所以 status 干净；未跟踪未忽略，无害但建议删除或补一条忽略。
- `workspace/`、`node_modules/`、`.turbo/`、`dist/`、`*.db` 等均已覆盖；`git status --porcelain` 干净，未发现"该忽略而未忽略"的已跟踪文件。
- 注意项：`.gitignore:62` 把 `AGENTS.md` 列为忽略。若属有意（本地代理配置不入库）则无碍，但与常规做法相反，建议团队确认。

结论：.gitignore 无实质漏洞；两个已知垃圾文件（nul、engine_test.log）进不了 git，但一直没人从磁盘清掉。

---

## 11. 文档可信度总评

| 文档 | 失实统计 | 可信度结论 |
|---|---|---|
| docs/API.md | 0B / 0M / 2m | **可以信**。49 端点 + WS 协议逐字段核对一致，仅 2 处措辞瑕疵。全库文档标杆。 |
| docs/开发指南.md | 0B / 1M / 1m | **基本可信，小修**。命令 14/14 有效、编号无错位；修 `tests/bench/` 路径与测试清单即可。 |
| docs/路线图.md | 0B / 0M / 2m | **基本可信，小修**。"已完成"项无一造假；修跨场景标注格式、Python 移除日期、测试数字。 |
| README.md | 0B / 1M / 1m | **基本可信，小修**。功能宣称全部有据；但快速开始第一条命令 `pnpm dev` 行为失实，最伤新用户，优先修。 |
| docs/DEPLOY.md | 0B / 1M / 0m | **基本可信，一处硬伤**。步骤 2 在干净机器上必翻车，部署文档的失实代价高，优先修。 |
| docs/架构文档.md | 0B / 2M / 1m | **需要大修（局部）**。骨架准确，但 L4/L5 注入这一主链路整节过时（recall.ts 自然化方案未入档），目录树漏 `mind/`；§4.3 应重写。 |
| docs/design/context-pipeline-v2.md | 0B / 4M / 5m | **主体可信，但"冻结决策"区不可信**。组件全部真实存在；然而 4 条 Major 全是"声称不再变更/承诺接入但实现静默偏离"，恰恰是设计者最依赖的部分，需逐条修订或显式声明放弃。 |
| IDEA.md | 0B / 0M / 1m | **名存实亡**。仅一行，已不能作为初心对照基准；要么补写要么归档。 |
| docs/issues/ | 无失实 | 健康。 |

**横向结论**：本次未发现"文档声称已实现但代码完全不存在"的 Blocker 级前科复发；9 条 Major 中有 6 条属于同一模式——**实现已演进、文档未回写**（recall 自然化、冻结决策偏离、`pnpm dev`/`pnpm build` 实际范围），建议建立"改主链路行为必须同步改文档"的约束。
