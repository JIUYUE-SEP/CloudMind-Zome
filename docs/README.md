# docs 文档地图

> 本目录分两区：**现行区**（与代码同寿命，随时销记）与 **archive/ 档案区**（当时的真相，只增不改）。
> 找现状读现行区，找历史读档案区。别拿档案当现状，别把现状拖进档案。
> 最后对账：2026-11-01（全量链接校验零死链；现行区单篇均已收录于下方明细）

---

## 现行区

| 文档 | 内容 | 口径 |
|------|------|------|
| [`项目导览.md`](项目导览.md) | 新人入口：产品定义、词汇解释、架构骨架、子系统全景、迷路读法 | 快照，漂移随单修 |
| [`路线图.md`](路线图.md) | 功能状态：已实现 / 部分实现 / 规划中 / 已废弃 | 每条可追溯到代码 |
| [`架构文档.md`](架构文档.md) | 分层架构、核心机制、数据流、配置系统、安全模型 | 与实现同步销记 |
| [`API.md`](API.md) | Engine REST 与 WebSocket 契约（端点/帧/错误码/鉴权） | 与路由同步 |
| [`开发指南.md`](开发指南.md) | 本地开发、调试、常见任务、提交前检查清单、隐私红线 | 工程纪律本体 |
| [`看门狗调参.md`](看门狗调参.md) | 看护三层阈值怎么调：参数总表、按症状查、写入方式、快照与日志读法 | 与 `plugins/watchdog` 同步 |
| [`DEPLOY.md`](DEPLOY.md) | Web 部署指南（含 sidecar 准备） | 部署实况 |
| [`design/`](design/) | 进行中的设计文档（context-pipeline、intermind 等） | 落地后归 superpowers |
| [`examples/`](examples/) | 示例（外部插件 hello 等） | 可运行 |
| [`issues/`](issues/) | 未决问题跟踪（已解决的留作先例） | 活着才留 |
| [`references/`](references/) | 外部参考资料 | 只读 |

### 现行区单篇明细

> 上表按目录给入口，下表按文件给直达——目录里的每一篇都在这里登记，不留孤儿。

**design/ — 进行中的设计**

| 文件 | 内容 |
|------|------|
| [`context-pipeline-v2.md`](design/context-pipeline-v2.md) | ContextPipeline v2 设计（Phase 1–7 全部实现，现行上下文机制的权威参考） |
| [`context-pipeline-phase4.md`](design/context-pipeline-phase4.md) | Phase 4 实施前报告（**已实施完成**，留作方案论证与现状核实的留痕） |
| [`intermind.md`](design/intermind.md) | 人形间私信（Intermind）设计定案 |
| [`watchdog.md`](design/watchdog.md) | 后台看护（turn 级卡死检测与中断）实施前报告（**P1 流空闲超时、P2 中断语义与停止生成、P3 心跳扫描、P4 语义审查均已实施**；语义审查缺省关闭；对应 `worker-registry.ts:18-21` 登记风险） |

**issues/ — 问题跟踪**

| 文件 | 内容 |
|------|------|
| [`2026-07-17-scheduler-flaky.md`](issues/2026-07-17-scheduler-flaky.md) | scheduler 测试并行负载下 flaky（**已解决**，留作先例） |

**references/ — 外部参考**

| 文件 | 内容 |
|------|------|
| [`2026-08-07-opencode-acp-上下文压缩参考.md`](references/2026-08-07-opencode-acp-上下文压缩参考.md) | opencode ACP 上下文压缩的外部参考 |

**examples/ — 可运行示例**

| 文件 | 内容 |
|------|------|
| [`plugins/hello/index.mjs`](examples/plugins/hello/index.mjs) | 外部插件（器官）最小示例，开发指引见 `开发指南.md` §5.7 |

## archive/ 档案区

> **纪律：只增不改。** 这里的一切是"当时的真相"——过时是它的职责，不是它的缺陷。新文档直接落对应子目录。

| 目录 | 内容 |
|------|------|
| [`archive/superpowers/specs/`](archive/superpowers/specs/) | 设计规格（各单决策定案，含不翻案条款） |
| [`archive/superpowers/plans/`](archive/superpowers/plans/) | 实施计划（阶段 0 侦察 + 分阶段任务 + 验收标准） |
| [`archive/reviews/`](archive/reviews/) | 独立审计报告（双眼睛流程的证据链，每条带 文件:行 证据） |

## 维护规则

1. 功能状态变更 → 当单内同步 `路线图.md`（维护规则见其文末）；
2. 机制变更 → 当单内同步 `架构文档.md` 与 `API.md`；
3. 文档漂移发现者 = 修复者（`docs/archive/reviews/2026-07-29-code-vs-docs-drift.md` 先例）；
4. 新 plan/spec/review 一律落 `archive/superpowers|reviews`，档案区是唯一位置。
