# CloudMind-Zome 外部文档整理 — 设计规格

> 版本：1.0 | 日期：2026-06-24
> 目标：基于当前项目代码，在 `F:\TheMDLibrary\MyStudySpace\CloudMind-Zome` 下新建一套整理后的文档，不覆盖、不修改原 `F:\TheMDLibrary\MyStudySpace\心智云图` 中的任何文件。

---

## 1. 背景与目标

### 1.1 背景

- 当前项目源码位于 `F:/MyProject_justlove/MindCloud-Zome`，是一套基于 Node.js + Nuxt 3 + Tauri 2 + Rust sidecar 的多 Agent 协作平台。
- 目标学习/笔记空间位于 `F:\TheMDLibrary\MyStudySpace\心智云图`，其中存放的是较早阶段的产品目标与阶段规划文档，与当前代码实现已有较大差异。
- 用户希望根据**当前代码现状**，在旁侧新建一套更贴近实现的文档，供学习、复盘与查阅。

### 1.2 目标

1. 在 `F:\TheMDLibrary\MyStudySpace\CloudMind-Zome` 下新建一套 Markdown 文档。
2. 文档内容完全基于当前项目源码与已有项目文档（`docs/`、`README.md` 等）。
3. 保留原 `心智云图` 目录不动，实现"不覆盖"原则。
4. 同时为新目录 `CloudMind-Zome` 编写总览文档（即该文件夹的入口 README）。

---

## 2. 范围

### 2.1 包含内容

| 文档 | 来源 | 覆盖范围 |
|------|------|----------|
| `00-项目总览.md` | `README.md` + `docs/架构文档.md` | 项目定位、使用场景、核心概念、技术栈、项目结构、数据存储、当前状态 |
| `01-架构文档.md` | `docs/架构文档.md` | 分层架构、目录结构、层间边界、核心机制（AgentWorker、ReAct、ContextPipeline、记忆、工具）、通信架构、数据库模型、配置系统、错误处理、安全模型、已知限制 |
| `02-开发指南.md` | `docs/开发指南.md` | 环境准备、安装、启动、调试技巧、常见开发任务、测试、提交前检查清单 |
| `03-API文档.md` | `docs/API.md` + `services/engine/src/api/routes/` + `services/engine/src/api/ws/handler.ts` | REST API 概览、WebSocket 协议、关键端点与消息帧说明 |
| `04-部署文档.md` | `docs/DEPLOY.md` | Web 部署、Tauri 桌面打包、环境变量、数据目录 |
| `05-测试文档.md` | `docs/开发指南.md` + `services/engine/tests/` + `apps/web/tests/` | 测试结构、运行命令、单元/集成/E2E 测试说明 |
| `06-安全文档.md` | `docs/架构文档.md` 第 9 节 + 相关工具实现 | 本地安全模型、文件写入限制、代码执行风险、API Key 加密、WS 鉴权、SSRF 防护 |
| `07-模块说明/01-后端引擎.md` | `services/engine/src/` | engine 目录结构、bootstrap、api、core、memory、tools、provider、scheduler、blueprint、conductor |
| `07-模块说明/02-前端应用.md` | `apps/web/` | Nuxt 3 前端结构、关键组件、stores、composables、页面路由 |
| `07-模块说明/03-桌面封装.md` | `apps/desktop/` | Tauri 2 桌面壳、Rust 主进程、sidecar 启动流程 |
| `07-模块说明/04-Rust侧车.md` | `crates/zome-sidecar/` | 向量索引、加密、tokenizer、gRPC 接口 |
| `07-模块说明/05-共享包与Skill.md` | `packages/shared/` + `packages/skills/` | 共享类型、内置 Skill 包结构 |
| `07-模块说明/06-基础设施.md` | `package.json` + `turbo.json` + `scripts/` + CI 配置 | Monorepo 配置、pnpm workspace、Turborepo、构建脚本 |
| `08-路线图.md` | `docs/路线图.md` | 当前已实现功能、进行中的工作、未来规划（地铁图式保留为文本描述） |
| `09-索引.md` | 综合 | 术语表、文档地图、关键文件路径速查、阅读顺序建议 |

### 2.2 不包含内容

- 不修改、不删除、不覆盖 `F:\TheMDLibrary\MyStudySpace\心智云图` 下的任何文件。
- 不为 `F:\TheMDLibrary\MyStudySpace` 本身编写总览文档（按用户最新要求）。
- 不生成新的代码或修改项目源码。
- 不复制图片、二进制或其他非 Markdown 文件。

---

## 3. 输出目录结构

```
F:\TheMDLibrary\MyStudySpace\CloudMind-Zome/
├── 00-项目总览.md
├── 01-架构文档.md
├── 02-开发指南.md
├── 03-API文档.md
├── 04-部署文档.md
├── 05-测试文档.md
├── 06-安全文档.md
├── 07-模块说明/
│   ├── 01-后端引擎.md
│   ├── 02-前端应用.md
│   ├── 03-桌面封装.md
│   ├── 04-Rust侧车.md
│   ├── 05-共享包与Skill.md
│   └── 06-基础设施.md
├── 08-路线图.md
└── 09-索引.md
```

---

## 4. 设计原则

1. **来源可追踪**：每份文档在开头注明主要来源文件路径，关键事实优先引用代码或已有文档。
2. **现状优先**：以"当前代码已实现什么"为主，不过度展开历史或未来假设；未来规划仅集中在 `08-路线图.md`。
3. **不覆盖**：所有输出都在新目录 `CloudMind-Zome` 下，对原 `心智云图` 目录只读。
4. **中文撰写**：用户用中文交流，所有文档使用中文，代码路径与术语保留英文。
5. **Markdown 规范**：使用 `#` 标题层级、表格、代码块、列表，保持与项目现有文档风格一致。
6. **Mermaid 图保留为代码块**：原路线图中的 Mermaid 图直接保留，便于在支持 Mermaid 的编辑器中渲染。

---

## 5. 成功标准

- [ ] `F:\TheMDLibrary\MyStudySpace\CloudMind-Zome` 目录及其子目录成功创建。
- [ ] 上述 15 份 Markdown 文档全部生成，内容基于当前项目代码与文档，无占位符。
- [ ] 原 `F:\TheMDLibrary\MyStudySpace\心智云图` 目录下文件数量、名称、内容均未被修改。
- [ ] `00-项目总览.md` 可作为 `CloudMind-Zome` 文件夹的入口文档独立阅读。
- [ ] 文档之间交叉引用使用相对路径（如 `../07-模块说明/01-后端引擎.md`）。

---

## 6. 风险与假设

| 风险 | 缓解措施 |
|------|----------|
| 项目源码与文档存在不一致 | 以源码为准，文档仅作为组织和补充；不一致处标注"以代码为准"。 |
| 目标目录已存在同名文件 | 由于用户确认"不用管原有文档"且目标为新目录 `CloudMind-Zome`，默认该目录为空；若存在则只追加不覆盖。 |
| 文档篇幅过长 | 将大主题拆分到多个文件中，保持单文件聚焦。 |

---

## 7. 后续步骤

1. 调用 `writing-plans` 技能生成详细实现计划。
2. 按实现计划读取源码、生成文档。
3. 生成后快速自检：目录完整性、链接正确性、原目录未改动。
4. 请用户审查输出。
