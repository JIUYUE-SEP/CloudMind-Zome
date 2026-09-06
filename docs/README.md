# docs 文档地图

> 本目录分两区：**现行区**（与代码同寿命，随时销记）与 **archive/ 档案区**（当时的真相，只增不改）。
> 找现状读现行区，找历史读档案区。别拿档案当现状，别把现状拖进档案。

---

## 现行区

| 文档 | 内容 | 口径 |
|------|------|------|
| [`项目导览.md`](项目导览.md) | 新人入口：产品定义、词汇解释、架构骨架、子系统全景、迷路读法 | 快照，漂移随单修 |
| [`路线图.md`](路线图.md) | 功能状态：已实现 / 部分实现 / 规划中 / 已废弃 | 每条可追溯到代码 |
| [`架构文档.md`](架构文档.md) | 分层架构、核心机制、数据流、配置系统、安全模型 | 与实现同步销记 |
| [`API.md`](API.md) | Engine REST 与 WebSocket 契约（端点/帧/错误码/鉴权） | 与路由同步 |
| [`开发指南.md`](开发指南.md) | 本地开发、调试、常见任务、提交前检查清单、隐私红线 | 工程纪律本体 |
| [`DEPLOY.md`](DEPLOY.md) | Web 部署指南（含 sidecar 准备） | 部署实况 |
| [`design/`](design/) | 进行中的设计文档（context-pipeline、intermind 等） | 落地后归 superpowers |
| [`examples/`](examples/) | 示例（外部插件 hello 等） | 可运行 |
| [`issues/`](issues/) | 未决问题跟踪（已解决的留作先例） | 活着才留 |
| [`references/`](references/) | 外部参考资料 | 只读 |

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
