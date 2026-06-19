# CloudMind-Zome

> 多 Agent 协作调度平台 —— 让每一个数字心智拥有完整的生命周期。

CloudMind-Zome 是一个面向未来的多 Agent 协作平台。它将多个独立 Agent（心智）整合到统一的调度与通讯框架中，支持私聊、群聊、任务编排、记忆管理与跨场景协作。

既可作为 Web 应用运行（Vite dev server + FastAPI），也可打包为 **Tauri 桌面应用**（Rust + WebView2，内嵌 Python 运行时）。

---

## 功能特性

- **心智管理** —— 创建、配置、形象化展示 Agent（立绘 / Live2D / 3D VRM）
- **算力平台** —— 管理 LLM Provider（API Key、Base URL、模型列表），与心智配置打通
- **私聊系统** —— 与单个 Agent 一对一对话，实时流式回复，支持图片发送
- **群聊系统** —— 多 Agent 群组讨论，支持 `@mention` 指定回复对象；Agent 自主决策是否回复（`stay_silent`）
- **代称系统** —— Agent 支持多个 aliases（昵称/代称），群聊 `@mention` 可通过代称精确路由（case-insensitive）
- **蓝图工作流** —— 可视化节点编辑器编排复杂任务流程，支持审批节点
- **任务调度** —— Cron / Interval / 手动触发，Agent 主动执行计划（Commission）
- **审批系统** —— 敏感操作需人工审批后方可执行
- **技能系统** —— 基于 SKILL.md 的指令注入，Agent 可加载额外技能指引
- **全局记忆** —— 跨场景统一记忆池，支持语义检索与自动话题压缩
- **语义搜索** —— 基于 zvec（C++ HNSW）的向量记忆检索，跨场景召回
- **智能停止** —— SmartStop 检测死循环、无进展、超时，自动终止
- **错误恢复** —— Provider 降级链 + 指数退避重试

---

## 技术栈

| 层级 | 技术 |
|---|---|
| 后端 | Python 3.11+, FastAPI, SQLAlchemy 2.0 (async), aiosqlite, Pydantic v2, SQLite + WAL |
| 前端 | Vue 3, Vite 5, Pinia, TypeScript, Vue Router (hash 模式) |
| 实时通信 | WebSocket (单连接多协议) |
| 向量存储 | zvec (C++ HNSW，替代 ChromaDB) |
| LLM 客户端 | OpenAI SDK (兼容 GLM / DeepSeek / MiMo / KimiCode 等 OpenAI 协议 provider) |
| 3D 形象 | three.js + @pixiv/three-vrm + Live2D |
| 进程管理 | Python asyncio + 全局 Agent Worker |
| 桌面封装 | Tauri 2 (Rust + WebView2，Windows Job Object 管理子进程) |

---

## 快速启动

### 环境要求

- Python 3.11+
- Node.js 18+
- （Tauri 桌面模式）Rust 工具链 + `cargo`
- Windows / Linux / macOS

### 1. 克隆仓库

```bash
git clone https://github.com/yourname/MindCloud-Zome.git
cd MindCloud-Zome
```

### 2. 配置后端

后端的 LLM Provider 已迁移至**数据库 + YAML 双写**架构，主数据源不再是 `engine/config.yaml`：

- **LLM Provider（API Key、Base URL、模型列表）** —— 通过前端「算力平台」界面配置，或直接编辑运行时生成的 `~/.cloudmind-zome/providers.yaml`。数据库与 YAML 双向同步。
- **以下配置项仍在 `backend/engine/config.yaml`**（需先从 `backend/engine/config.yaml.example` 复制一份，该文件已被 `.gitignore` 忽略）：
  - `tavily.api_key` —— 网络搜索工具（也支持环境变量 `TAVILY_API_KEY`）
  - `assistant_model` —— 记忆压缩助手模型（可选）
  - `embedding_model` —— 语义向量模型（可选，用于 zvec 语义检索）

```bash
cd backend
cp engine/config.yaml.example engine/config.yaml
# 编辑 engine/config.yaml，填入 tavily / assistant_model / embedding_model 的 Key
```

### 3. 安装依赖

```bash
# 后端
pip install -r requirements.txt

# 前端
cd ../frontend
npm install
```

### 4. 启动开发环境

在项目根目录执行：

```bash
# Windows (Web 模式，浏览器访问)
start-dev.bat

# Windows (Tauri 桌面模式，WebView2 窗口，需 Rust 工具链)
start-tauri.bat

# 或 PowerShell
powershell -ExecutionPolicy Bypass -File start-dev.ps1
```

服务启动后：

- 前端：`http://localhost:1420`
- 后端 API：`http://127.0.0.1:8848`
- WebSocket：`ws://127.0.0.1:8848/api/v1/ws`

> Tauri 桌面模式启动时，Rust 壳会自动拉起内嵌 Python 后端（优先使用 `runtime/python/python.exe`），并通过 `backend_url` 命令把后端地址暴露给前端；退出时用 Windows Job Object 一并清理子进程。

---

## 项目结构

```
MindCloud-Zome/
├── backend/
│   ├── app/                     # FastAPI 平台层
│   │   ├── api/                 # REST + WebSocket 路由
│   │   ├── models/              # SQLAlchemy 数据模型
│   │   ├── services/            # 业务服务（Worker、调度器、事件总线、群聊路由、Provider 双写迁移）
│   │   ├── core/                # crypto / security(token) / provider_schema
│   │   ├── database.py          # 数据库连接与 DATA_DIR 路径
│   │   └── main.py              # 应用入口（lifespan / 路由挂载 / 迁移）
│   ├── engine/                  # Agent 引擎层（与平台解耦）
│   │   ├── agent/               # ReActAgent 核心循环 + MessageBuilder + SmartStop
│   │   ├── context/             # ContextPipeline + zvec 向量存储 + Embedder + token 计数
│   │   ├── memory/              # MemorySystem 插件体系（simple / topic_compression）
│   │   ├── personality/         # 人格提取（Big-5）+ 提示词构建
│   │   ├── provider/            # LLM Transport + Thinking Profile + Factory + Registry
│   │   ├── skill/               # SKILL.md 加载与指令注入
│   │   ├── mcp/                 # MCP 占位（预留，未实现）
│   │   ├── importer/            # 外部资源导入器
│   │   ├── workers/             # 后台工作线程
│   │   ├── logging_/            # 日志工具
│   │   ├── tool/                # 工具注册中心
│   │   ├── tools/               # 工具实现（web / file / code / shell / comms / group / project）
│   │   ├── message/             # 消息类型定义（Text/Thinking/ToolUse/ToolResult/Image 块）
│   │   ├── session/             # SQLite 持久化存储（llm_ 前缀表 + FTS5）
│   │   ├── config/              # 配置加载（Pydantic）
│   │   ├── error/               # 错误分类、重试、降级链
│   │   ├── config.yaml.example  # 引擎配置示例（实际 config.yaml 被 gitignore）
│   │   └── config.yaml          # 引擎配置（需从 .example 复制）
│   ├── tests/                   # pytest 测试套件
│   ├── pytest.ini
│   ├── requirements.txt
│   ├── run.py                   # 开发启动入口（uvicorn reload）
│   └── run_prod.py              # 生产启动入口
├── frontend/
│   ├── src/
│   │   ├── components/          # Vue 组件（ChatView、AgentEdit、ComputeCenter、BlueprintCanvas 等）
│   │   ├── stores/              # Pinia 状态管理（auth / agents / chat / compute / ui）
│   │   ├── api/                 # 统一 API 客户端（fetch 封装）
│   │   ├── views/               # 页面视图（AppShell / HomeView 等）
│   │   ├── composables/         # WebSocket / Markdown 封装
│   │   ├── router/              # Vue Router
│   │   └── styles/              # 全局样式（科幻暗色主题）
│   ├── src-tauri/               # Tauri 2 桌面壳（Rust）
│   │   ├── src/main.rs          # 拉起内嵌 Python 后端 + 端口探测 + Job Object
│   │   ├── Cargo.toml           # Rust 依赖
│   │   └── tauri.conf.json      # 打包配置（productName: CloudMind-Zome）
│   └── vite.config.ts           # Vite 配置（dev/preview 反代 /api → 127.0.0.1:8848）
├── scripts/                     # 打包脚本（prepare_embedded_python / package_backend）
├── docs/                        # 设计与审计文档
├── workspace/                   # 占位目录（运行时数据落 ~/.cloudmind-zome/workspace/）
├── start-dev.bat                # 一键 Web 开发启动
├── start-tauri.bat              # 一键 Tauri 桌面启动
├── start-dev.ps1                # PowerShell 版启动脚本
├── LICENSE                      # GPL-3.0
└── README.md
```

---

## 核心架构

### Agent = 单一数字生命

- 每个 Agent 拥有**唯一的全局 Worker**（`AgentWorker`）
- 单一 `ReActAgent` 实例，永不重建，持有场景隔离的记忆 `_messages`
- FIFO 任务队列，所有 Job（私聊、群聊、任务）按顺序处理
- 单点维护 `idle / busy` 状态

### Context Pipeline（上下文组装）

每轮 LLM 调用前，`ContextPipeline` 按 **L1–L6** 六层组装 prompt：

| 层级 | 内容 | 优先级 | 降级策略 |
|------|------|--------|----------|
| L1 | Mind 文件（SOUL.md / AGENT.md / USER.md / profile.md）+ 平台能力 | 最高 | 不降级 |
| L2 | 群聊 sender 前缀（由 MessageBuilder 处理） | 最高 | 不降级 |
| L3 | Hot Context（当前场景最近 N 条消息） | 中 | 从最老开始截断：20→15→10→5 |
| L4 | 语义检索结果（zvec 跨场景 top-K） | 中 | 从低分开始去掉：10→5→3→0 |
| L5 | 话题摘要（`_compressed/*.md` 压缩历史） | 低 | 多条合并成一条概要 |
| L6 | 工具描述 | 最高 | 不降级 |

**降级顺序：L5 → L4 → L3**，超限时自动触发，**L1 / L2 / L6 永不动**。

> 说明：
> - **L1 / L2 / L6 永不降级**，L3/L4/L5 按需压缩。
> - 群聊时的**人格描述（personality_desc，stay_silent 行为指令）和 @mention 提醒**作为 `assemble()` 的独立参数注入，不属于上述 6 层体系。
> - `MessageBuilder` 负责组装 L1（Mind 文件）与 L2（群聊 sender 前缀）；私聊不加标签，群聊 user 消息加 `sender_name:` 前缀。

### 记忆系统

**三层架构：**

| 层级 | 来源 | 用途 |
|---|---|---|
| Hot Context | `_messages`（内存，按 `source_id` 场景隔离） | 当前对话上下文 |
| Semantic Memory | zvec 向量检索（跨场景） | 按语义相似度召回全场景历史 |
| Topic Summaries | `_compressed/*.md`（自动压缩） | 长期话题摘要，按修改时间排序 |

**记忆系统模式**（`engine/config.yaml` 的 `agent.memory_system`）：
- `simple` —— 默认模式，基础记忆管理
- `topic_compression` —— 启用话题压缩（TopicMarker + 异步 CompressionWorker）

**话题压缩触发（仅 `topic_compression` 模式）：**
- 上下文 token 数超过阈值（默认 80% of context window）
- `TopicMarker` 检测到话题切换时，异步 `CompressionWorker` 执行压缩

### 通信协议

- **单 WebSocket 连接**：所有实时流量走同一个 WS 通道
- **消息帧类型**：
  - `chat.message` — 消息内容
  - `chat.thinking` — 推理块（折叠显示）
  - `chat.tool_call` — 工具调用（折叠显示）
  - `chat.typing` — 输入状态
  - `agent.status` — Agent 状态变更（idle / busy）
  - `intermind.start/end` — 心智互聊触发
  - `action.progress` — 工作流进度
  - `notification.new` — 系统通知
- **消息持久化**：`tool_calls` 和 `reasoning` 随 `ChatMessage` 一并存入数据库，历史消息加载后完整还原

### 错误恢复

- **Provider 降级链**：默认 `glm → kimicode`（可在 `engine/config.yaml` 的 `provider.fallback_chain` 配置），API 故障时自动切换
- **指数退避重试**：可恢复错误（RateLimit / Timeout）自动重试
- **LLM 流式中断**：流式响应失败时，fallback 到完整响应模式

### 工具系统

Agent 可调用 7 个工具集（toolset），通过 `@tool_registry.register()` 自动注册：

| Toolset | 工具 | 功能 |
|---|---|---|
| `web` | `search_web`, `generate_image` | Tavily 网络搜索、生图（DashScope/SiliconFlow 兼容） |
| `file` | `read_file`, `write_file`, `edit_file`, `delete_file`, `share_file` | 文件读写编辑、删除（移至回收站）、分享到聊天 |
| `code` | `python_execute` | 执行 Python 代码 |
| `shell` | `shell_command` | 执行 Shell 命令 |
| `comms` | `send_private_message`, `report_workflow_progress` | Agent 间私信、报告工作流进度 |
| `group` | `stay_silent` | 群聊中 Agent 决定不回复 |
| `project` | `list_project_docs`, `search_project_docs` | 项目知识库查询 |

> **文件工具安全**：`write_file` 等文件工具有强白名单，仅允许写入 `DATA_DIR` 与 `WORKSPACE_ROOT`，黑名单（系统目录、凭据文件等）不可绕过，单 Agent 可通过 contextvars 注入额外允许路径。

---

## 开发说明

### 登录/注册（开发模式）

当前为开发便利，未登录用户自动回退为 Guest 用户，无需注册即可使用全部功能。

### 数据目录

所有运行时数据落在 **`DATA_DIR`**，其解析顺序：

1. 环境变量 `CLOUDMIND_DATA_DIR`（Tauri 桌面构建会设为 `%LOCALAPPDATA%\com.cloudmind-zome.app`）
2. 未设置时回退到 `~/.cloudmind-zome`（开发模式默认）

`DATA_DIR` 下包含：

- `cloudmind.db` — SQLite 数据库（WAL 模式，平台表与引擎表共存）
- `providers.yaml` — LLM Provider 配置（与 DB 双写）
- `workspace/` — Agent 工作区
- `uploads/` — 上传文件（通过 `/uploads/` 静态路径访问）
- `zvec/` — zvec 向量库本地文件

### Agent 数据目录

每个 Agent 的数据存储在 `DATA_DIR/workspace/{agent_id}/`：

- `SOUL.md` — 灵魂内核 / 人格定义
- `AGENT.md` — 工作规范 / 行为指南
- `USER.md` — Agent 对用户的感知
- `MEMORY.md` — 长期记忆（由 CompressionWorker 追加摘要）
- `_compressed/*.md` — 话题压缩摘要（仅 topic_compression 模式）
- `skills/{name}/SKILL.md` — 技能指令文件
- `memory.db` — 话题上下文状态

全局用户档案：`DATA_DIR/userdata/profile.md`

---

### 运行测试

```bash
cd backend
python -m pytest tests/ -q
```

---

## 路线图

- [x] 私聊 / 群聊系统
- [x] Agent 全局 Worker + 任务调度
- [x] 蓝图工作流（节点编辑器）
- [x] 语义记忆（zvec 向量检索）
- [x] `@mention` 心智提及 + @所有人
- [x] Context Pipeline（场景隔离 + 跨场景检索 + 降级）
- [x] Topic Compression Memory（自动话题压缩）
- [x] 真流式逐字输出
- [x] 消息合并（单气泡 reasoning + tools + content）
- [x] Markdown 渲染（代码块、表格、引用）
- [x] 算力平台（ComputeProvider 数据库表）
- [x] 代称系统（Alias routing）
- [x] 技能系统（SKILL.md 指令注入）
- [ ] MCP / ACP 管理
- [ ] 部署文档与 Docker 支持

---

## 许可证

GNU General Public License v3.0 (GPL-3.0)
