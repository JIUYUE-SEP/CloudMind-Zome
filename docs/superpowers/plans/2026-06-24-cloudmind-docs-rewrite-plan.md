# CloudMind-Zome 外部文档整理 — 实现计划

> **面向 AI 代理的工作者：** 本计划为文档整理任务，不涉及代码实现，但按小步骤执行与验证。推荐在当前会话中内联执行。

**目标：** 基于当前项目代码，在 `F:\TheMDLibrary\MyStudySpace\CloudMind-Zome` 下新建一套整理后的 Markdown 文档，不覆盖原 `心智云图` 目录。

**架构：** 将项目源码、已有项目文档按主题拆分为 15 份 Markdown 文件（10 份根目录文档 + 6 份模块说明文档），并在 `CloudMind-Zome` 根目录提供总览入口。

**技术栈：** Markdown、Bash（目录操作）、Read/Write 工具。

---

## 1. 文件结构

### 1.1 输出文件清单

| 文件 | 职责 | 主要来源 |
|------|------|----------|
| `F:\TheMDLibrary\MyStudySpace\CloudMind-Zome\00-项目总览.md` | CloudMind-Zome 文件夹入口 | `README.md`、`docs/架构文档.md` 第 1 章 |
| `F:\TheMDLibrary\MyStudySpace\CloudMind-Zome\01-架构文档.md` | 分层架构、核心机制、通信与数据模型 | `docs/架构文档.md` |
| `F:\TheMDLibrary\MyStudySpace\CloudMind-Zome\02-开发指南.md` | 环境、启动、调试、常见任务 | `docs/开发指南.md` |
| `F:\TheMDLibrary\MyStudySpace\CloudMind-Zome\03-API文档.md` | REST 与 WebSocket API 说明 | `docs/API.md`、`services/engine/src/api/` |
| `F:\TheMDLibrary\MyStudySpace\CloudMind-Zome\04-部署文档.md` | 部署与打包 | `docs/DEPLOY.md` |
| `F:\TheMDLibrary\MyStudySpace\CloudMind-Zome\05-测试文档.md` | 测试体系 | `docs/开发指南.md` 第 6 章、`services/engine/tests/`、`apps/web/tests/` |
| `F:\TheMDLibrary\MyStudySpace\CloudMind-Zome\06-安全文档.md` | 安全模型与风险 | `docs/架构文档.md` 第 9 章 |
| `F:\TheMDLibrary\MyStudySpace\CloudMind-Zome\07-模块说明\01-后端引擎.md` | Node.js 引擎核心 | `services/engine/src/` |
| `F:\TheMDLibrary\MyStudySpace\CloudMind-Zome\07-模块说明\02-前端应用.md` | Nuxt 3 前端 | `apps/web/` |
| `F:\TheMDLibrary\MyStudySpace\CloudMind-Zome\07-模块说明\03-桌面封装.md` | Tauri 2 桌面壳 | `apps/desktop/` |
| `F:\TheMDLibrary\MyStudySpace\CloudMind-Zome\07-模块说明\04-Rust侧车.md` | Rust sidecar | `crates/zome-sidecar/` |
| `F:\TheMDLibrary\MyStudySpace\CloudMind-Zome\07-模块说明\05-共享包与Skill.md` | 共享类型与 Skill | `packages/shared/`、`packages/skills/` |
| `F:\TheMDLibrary\MyStudySpace\CloudMind-Zome\07-模块说明\06-基础设施.md` | Monorepo 与构建 | `package.json`、`turbo.json`、`scripts/`、CI |
| `F:\TheMDLibrary\MyStudySpace\CloudMind-Zome\08-路线图.md` | 功能状态与规划 | `docs/路线图.md` |
| `F:\TheMDLibrary\MyStudySpace\CloudMind-Zome\09-索引.md` | 术语表、文档地图、速查 | 综合 |

---

## 2. 任务分解

### 任务 1：创建输出目录

**文件：**
- 创建：`F:\TheMDLibrary\MyStudySpace\CloudMind-Zome`
- 创建：`F:\TheMDLibrary\MyStudySpace\CloudMind-Zome\07-模块说明`

- [ ] **步骤 1：创建目录结构**

  运行：
  ```bash
  mkdir -p "/f/TheMDLibrary/MyStudySpace/CloudMind-Zome/07-模块说明"
  ```

- [ ] **步骤 2：验证目录创建成功**

  运行：
  ```bash
  ls -la "/f/TheMDLibrary/MyStudySpace/CloudMind-Zome" && ls -la "/f/TheMDLibrary/MyStudySpace/CloudMind-Zome/07-模块说明"
  ```
  预期：目录存在且为空（除 `.` 和 `..`）。

---

### 任务 2：生成 00-项目总览.md

**文件：**
- 创建：`F:\TheMDLibrary\MyStudySpace\CloudMind-Zome\00-项目总览.md`

- [ ] **步骤 1：读取来源文档**

  读取：
  - `F:/MyProject_justlove/MindCloud-Zome/README.md`
  - `F:/MyProject_justlove/MindCloud-Zome/docs/架构文档.md` 第 1 章

- [ ] **步骤 2：编写总览文档**

  内容需包含：
  - 项目一句话定位
  - 使用场景（研究助手、代码审查、多角色写作）
  - 功能列表（私聊、Agent 管理、工具调用、长期记忆、Skill、Plan/Goal、Subagent、桌面应用）
  - 核心概念（Agent、ReAct、单用户本地模式）
  - 技术栈表格
  - 项目结构树
  - 数据存储路径
  - 文档地图（指向同目录下其他文件）

- [ ] **步骤 3：验证文件生成**

  运行：
  ```bash
  wc -l "/f/TheMDLibrary/MyStudySpace/CloudMind-Zome/00-项目总览.md"
  ```
  预期：行数 > 50，文件存在。

---

### 任务 3：生成 01-架构文档.md

**文件：**
- 创建：`F:\TheMDLibrary\MyStudySpace\CloudMind-Zome\01-架构文档.md`

- [ ] **步骤 1：读取来源文档**

  读取：
  - `F:/MyProject_justlove/MindCloud-Zome/docs/架构文档.md`

- [ ] **步骤 2：整理架构文档**

  内容需包含：
  - 项目定位与核心功能表
  - 明确未实现功能表
  - 技术栈
  - 后端分层架构与目录结构
  - 层间边界说明
  - AgentWorker、ReAct 循环、ContextPipeline、记忆系统、工具系统
  - 通信架构（WebSocket 协议、群聊路由、心智互聊）
  - 数据库模型与关键关系
  - 配置系统与数据目录
  - 错误处理与 Provider 降级链
  - 安全模型
  - 已知限制
  - 文档维护原则

- [ ] **步骤 3：验证文件生成**

  运行：
  ```bash
  wc -l "/f/TheMDLibrary/MyStudySpace/CloudMind-Zome/01-架构文档.md"
  ```
  预期：行数 > 200。

---

### 任务 4：生成 02-开发指南.md

**文件：**
- 创建：`F:\TheMDLibrary\MyStudySpace\CloudMind-Zome\02-开发指南.md`

- [ ] **步骤 1：读取来源文档**

  读取：
  - `F:/MyProject_justlove/MindCloud-Zome/docs/开发指南.md`

- [ ] **步骤 2：整理开发指南**

  内容需包含：
  - 环境要求与技术栈
  - 安装依赖与启动命令
  - 环境变量表
  - 项目结构速查
  - 启动流程详解
  - 调试技巧
  - 常见开发任务（添加工具、修改 Agent 配置、修改 ReAct、新增 API、新增组件）
  - 测试命令与覆盖范围
  - E2E 测试与 Benchmark
  - 提交前检查清单

- [ ] **步骤 3：验证文件生成**

  运行：
  ```bash
  wc -l "/f/TheMDLibrary/MyStudySpace/CloudMind-Zome/02-开发指南.md"
  ```
  预期：行数 > 200。

---

### 任务 5：生成 03-API文档.md

**文件：**
- 创建：`F:\TheMDLibrary\MyStudySpace\CloudMind-Zome\03-API文档.md`

- [ ] **步骤 1：读取来源**

  读取：
  - `F:/MyProject_justlove/MindCloud-Zome/docs/API.md`
  - `F:/MyProject_justlove/MindCloud-Zome/services/engine/src/api/server.ts`
  - `F:/MyProject_justlove/MindCloud-Zome/services/engine/src/api/ws/handler.ts`

- [ ] **步骤 2：整理 API 文档**

  内容需包含：
  - REST API 基地址
  - 主要路由分组（agents、chat、memory、compute、actions、skills、ws 等）
  - WebSocket 协议说明
  - Client → Server 帧类型
  - Server → Client 帧类型
  - 关键端点或消息示例

- [ ] **步骤 3：验证文件生成**

  运行：
  ```bash
  wc -l "/f/TheMDLibrary/MyStudySpace/CloudMind-Zome/03-API文档.md"
  ```
  预期：行数 > 100。

---

### 任务 6：生成 04-部署文档.md

**文件：**
- 创建：`F:\TheMDLibrary\MyStudySpace\CloudMind-Zome\04-部署文档.md`

- [ ] **步骤 1：读取来源文档**

  读取：
  - `F:/MyProject_justlove/MindCloud-Zome/docs/DEPLOY.md`

- [ ] **步骤 2：整理部署文档**

  内容需包含：
  - 部署前提
  - Web 模式部署步骤
  - Tauri 桌面打包步骤
  - 环境变量说明
  - 数据目录说明

- [ ] **步骤 3：验证文件生成**

  运行：
  ```bash
  wc -l "/f/TheMDLibrary/MyStudySpace/CloudMind-Zome/04-部署文档.md"
  ```
  预期：行数 > 50。

---

### 任务 7：生成 05-测试文档.md

**文件：**
- 创建：`F:\TheMDLibrary\MyStudySpace\CloudMind-Zome\05-测试文档.md`

- [ ] **步骤 1：读取来源**

  读取：
  - `F:/MyProject_justlove/MindCloud-Zome/docs/开发指南.md` 第 6 章
  - `F:/MyProject_justlove/MindCloud-Zome/services/engine/tests/` 目录结构
  - `F:/MyProject_justlove/MindCloud-Zome/apps/web/tests/` 目录结构

- [ ] **步骤 2：整理测试文档**

  内容需包含：
  - 测试命令表
  - 单元测试覆盖范围
  - 集成测试覆盖范围
  - E2E 测试说明
  - Benchmark 说明
  - 覆盖率目标

- [ ] **步骤 3：验证文件生成**

  运行：
  ```bash
  wc -l "/f/TheMDLibrary/MyStudySpace/CloudMind-Zome/05-测试文档.md"
  ```
  预期：行数 > 80。

---

### 任务 8：生成 06-安全文档.md

**文件：**
- 创建：`F:\TheMDLibrary\MyStudySpace\CloudMind-Zome\06-安全文档.md`

- [ ] **步骤 1：读取来源**

  读取：
  - `F:/MyProject_justlove/MindCloud-Zome/docs/架构文档.md` 第 9 章
  - `F:/MyProject_justlove/MindCloud-Zome/services/engine/src/tools/builtin/write.ts`
  - `F:/MyProject_justlove/MindCloud-Zome/services/engine/src/config/crypto.ts`

- [ ] **步骤 2：整理安全文档**

  内容需包含：
  - 单用户本地模式的安全假设
  - 文件系统隔离与写入限制
  - 代码执行风险（bash 工具）
  - API Key 加密机制
  - Provider URL 校验（SSRF 防护）
  - WebSocket 鉴权现状
  - SQLite 并发说明
  - 风险与建议对照表

- [ ] **步骤 3：验证文件生成**

  运行：
  ```bash
  wc -l "/f/TheMDLibrary/MyStudySpace/CloudMind-Zome/06-安全文档.md"
  ```
  预期：行数 > 80。

---

### 任务 9：生成模块说明文档

**文件：**
- 创建：`F:\TheMDLibrary\MyStudySpace\CloudMind-Zome\07-模块说明\01-后端引擎.md`
- 创建：`F:\TheMDLibrary\MyStudySpace\CloudMind-Zome\07-模块说明\02-前端应用.md`
- 创建：`F:\TheMDLibrary\MyStudySpace\CloudMind-Zome\07-模块说明\03-桌面封装.md`
- 创建：`F:\TheMDLibrary\MyStudySpace\CloudMind-Zome\07-模块说明\04-Rust侧车.md`
- 创建：`F:\TheMDLibrary\MyStudySpace\CloudMind-Zome\07-模块说明\05-共享包与Skill.md`
- 创建：`F:\TheMDLibrary\MyStudySpace\CloudMind-Zome\07-模块说明\06-基础设施.md`

#### 任务 9.1：后端引擎

- [ ] **步骤 1：读取来源**

  读取：
  - `F:/MyProject_justlove/MindCloud-Zome/services/engine/src/` 下关键文件

- [ ] **步骤 2：整理后端引擎模块文档**

  内容需包含：
  - `services/engine/` 目录结构
  - `bootstrap.ts` 启动流程
  - `api/` REST + WebSocket
  - `core/` AgentWorker、ReActLoop
  - `memory/` per-Agent Repository
  - `tools/` 工具系统
  - `provider/` LLM Provider
  - `scheduler/` 定时任务
  - `blueprint/` 蓝图工作流
  - `conductor/` 群聊编排

- [ ] **步骤 3：验证**

  运行：
  ```bash
  wc -l "/f/TheMDLibrary/MyStudySpace/CloudMind-Zome/07-模块说明/01-后端引擎.md"
  ```
  预期：行数 > 150。

#### 任务 9.2：前端应用

- [ ] **步骤 1：读取来源**

  读取：
  - `F:/MyProject_justlove/MindCloud-Zome/apps/web/` 下关键文件

- [ ] **步骤 2：整理前端应用模块文档**

  内容需包含：
  - `apps/web/` 目录结构
  - 关键页面（agents、chat、compute、settings 等）
  - 关键组件（ChatView、GroupChatView、AgentEdit）
  - Pinia stores
  - composables（useEngineClient）
  - 路由与自动导入

- [ ] **步骤 3：验证**

  运行：
  ```bash
  wc -l "/f/TheMDLibrary/MyStudySpace/CloudMind-Zome/07-模块说明/02-前端应用.md"
  ```
  预期：行数 > 120。

#### 任务 9.3：桌面封装

- [ ] **步骤 1：读取来源**

  读取：
  - `F:/MyProject_justlove/MindCloud-Zome/apps/desktop/src-tauri/src/main.rs`
  - `F:/MyProject_justlove/MindCloud-Zome/apps/desktop/` 其他配置

- [ ] **步骤 2：整理桌面封装模块文档**

  内容需包含：
  - Tauri 2 架构
  - Rust 主进程职责
  - sidecar 启动流程
  - WebView 加载前端

- [ ] **步骤 3：验证**

  运行：
  ```bash
  wc -l "/f/TheMDLibrary/MyStudySpace/CloudMind-Zome/07-模块说明/03-桌面封装.md"
  ```
  预期：行数 > 80。

#### 任务 9.4：Rust 侧车

- [ ] **步骤 1：读取来源**

  读取：
  - `F:/MyProject_justlove/MindCloud-Zome/crates/zome-sidecar/src/` 下文件

- [ ] **步骤 2：整理 Rust 侧车模块文档**

  内容需包含：
  - `crates/zome-sidecar/` 目录结构
  - 向量索引（`vector.rs`）
  - 加密（`crypto.rs`）
  - Tokenizer（`tokenizer.rs`）
  - gRPC 服务接口

- [ ] **步骤 3：验证**

  运行：
  ```bash
  wc -l "/f/TheMDLibrary/MyStudySpace/CloudMind-Zome/07-模块说明/04-Rust侧车.md"
  ```
  预期：行数 > 80。

#### 任务 9.5：共享包与 Skill

- [ ] **步骤 1：读取来源**

  读取：
  - `F:/MyProject_justlove/MindCloud-Zome/packages/shared/src/`
  - `F:/MyProject_justlove/MindCloud-Zome/packages/skills/`

- [ ] **步骤 2：整理共享包与 Skill 模块文档**

  内容需包含：
  - `packages/shared/` 共享类型
  - Agent 类型定义
  - 其他共享类型（消息、会话、工具等）
  - `packages/skills/` 内置 Skill 包结构
  - SKILL.md manifest 说明

- [ ] **步骤 3：验证**

  运行：
  ```bash
  wc -l "/f/TheMDLibrary/MyStudySpace/CloudMind-Zome/07-模块说明/05-共享包与Skill.md"
  ```
  预期：行数 > 80。

#### 任务 9.6：基础设施

- [ ] **步骤 1：读取来源**

  读取：
  - `F:/MyProject_justlove/MindCloud-Zome/package.json`
  - `F:/MyProject_justlove/MindCloud-Zome/turbo.json`
  - `F:/MyProject_justlove/MindCloud-Zome/scripts/`
  - CI 配置（如 `.github/workflows/`）

- [ ] **步骤 2：整理基础设施模块文档**

  内容需包含：
  - pnpm workspace 配置
  - Turborepo pipeline
  - 常用脚本说明
  - 构建辅助脚本
  - CI 流程概述

- [ ] **步骤 3：验证**

  运行：
  ```bash
  wc -l "/f/TheMDLibrary/MyStudySpace/CloudMind-Zome/07-模块说明/06-基础设施.md"
  ```
  预期：行数 > 80。

---

### 任务 10：生成 08-路线图.md

**文件：**
- 创建：`F:\TheMDLibrary\MyStudySpace\CloudMind-Zome\08-路线图.md`

- [ ] **步骤 1：读取来源文档**

  读取：
  - `F:/MyProject_justlove/MindCloud-Zome/docs/路线图.md`

- [ ] **步骤 2：整理路线图**

  内容需包含：
  - 新架构迁移状态
  - 系统总览地铁图（保留 Mermaid 代码块）
  - 各轨道详图（核心对话、Agent 引擎、工具系统、工作流等）
  - 当前开发优先级
  - 图例与维护规则

- [ ] **步骤 3：验证文件生成**

  运行：
  ```bash
  wc -l "/f/TheMDLibrary/MyStudySpace/CloudMind-Zome/08-路线图.md"
  ```
  预期：行数 > 300。

---

### 任务 11：生成 09-索引.md

**文件：**
- 创建：`F:\TheMDLibrary\MyStudySpace\CloudMind-Zome\09-索引.md`

- [ ] **步骤 1：整理索引**

  内容需包含：
  - 术语表（Agent、ReAct、Intermind、Conductor、Blueprint、Commission、Skill、Provider 等）
  - 文档地图（列出同目录所有文档及一句话简介）
  - 关键文件路径速查（源码到文档的映射）
  - 推荐阅读顺序

- [ ] **步骤 2：验证文件生成**

  运行：
  ```bash
  wc -l "/f/TheMDLibrary/MyStudySpace/CloudMind-Zome/09-索引.md"
  ```
  预期：行数 > 80。

---

### 任务 12：最终验证

- [ ] **步骤 1：统计输出文件数量**

  运行：
  ```bash
  find "/f/TheMDLibrary/MyStudySpace/CloudMind-Zome" -type f -name '*.md' | wc -l
  ```
  预期：15。

- [ ] **步骤 2：确认原目录未被修改**

  运行：
  ```bash
  ls -la "/f/TheMDLibrary/MyStudySpace/心智云图"
  ```
  预期：目录结构与任务开始前一致，文件时间戳未发生变化（除非系统本身有更新）。

- [ ] **步骤 3：快速检查 00-项目总览.md 是否可作为入口阅读**

  运行：
  ```bash
  head -n 30 "/f/TheMDLibrary/MyStudySpace/CloudMind-Zome/00-项目总览.md"
  ```
  预期：包含项目定位、技术栈、文档地图。

---

## 3. 自检

### 3.1 规格覆盖度

| 规格需求 | 对应任务 |
|----------|----------|
| 在 `CloudMind-Zome` 下新建文档 | 任务 1、任务 2-11 |
| 不覆盖原 `心智云图` | 任务 12 步骤 2 |
| 文档基于当前项目代码 | 每个任务步骤 1 读取来源 |
| 总览作为入口 | 任务 2（00-项目总览.md） |
| 包含专题文档（API、部署、测试、安全） | 任务 5、6、7、8 |
| 中文撰写 | 所有任务输出均为中文 |

### 3.2 占位符扫描

- 无 "待定"、"TODO"、"后续实现"。
- 每个任务包含具体文件路径与验证命令。
- 无未定义类型或函数引用。

### 3.3 一致性检查

- 所有输出文件路径统一使用 `F:\TheMDLibrary\MyStudySpace\CloudMind-Zome`。
- 文档编号从 `00` 到 `09`，模块说明子目录内编号从 `01` 到 `06`。
- 交叉引用使用相对路径。
