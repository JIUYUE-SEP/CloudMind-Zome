# CloudMind-Zome 编程 Agent 模式 — 设计规格

> **历史文档 / 部分落地**：引擎侧已实现（`session.set_mode`、chat/code 双模式、`list_files` / `edit_file` / `run_command` 工具、projectRoot 路径限制）；前端 IDE 工作区（Monaco 编辑器、CodeWorkspace、FileTree）曾实现但后续已移除，当前前端无 IDE 面板。保留用于追溯历史。

> 版本：1.0 | 日期：2026-07-12
> 目标：在现有 `/hub` 私聊页面中增加「编程模式」，让 Agent 能在浏览器内帮用户查看、编辑、运行项目代码。

---

## 1. 背景与目标

### 1.1 背景

CloudMind-Zome 当前已具备：
- 多 Agent 私聊/群聊
- 基础工具调用（`read_file`、`write_file`、`bash`）
- Plan / Goal / Subagent 调度
- WebSocket 实时通信
- Nuxt 3 前端

但当前工具对编程场景支持较弱：
- 没有文件树视图，用户无法直观浏览项目结构
- 没有代码编辑器，Agent 修改代码后无法即时展示
- `bash` 工具输出直接混入聊天流，不适合长命令输出
- 没有基于 diff 的精确编辑工具
- 没有代码搜索工具

### 1.2 目标

在现有 `/hub` 页面中增加「编程模式」，实现：
1. Agent 可在「聊天模式」与「编程模式」之间切换。
2. 编程模式下，页面展示 IDE 式工作区：文件树、代码编辑器、命令输出面板。
3. Agent 能读取项目文件、执行命令、精确编辑代码，并在 IDE 中实时展示。
4. 所有文件/命令操作限制在项目根目录内，保证安全。

---

## 2. 范围

### 2.1 包含内容（MVP）

| 模块 | 内容 |
|------|------|
| 会话模式 | ChatSession 增加 `mode: 'chat' \| 'code'` |
| UI 布局 | `/hub` 页面支持双栏布局（左侧聊天 + 右侧 IDE 面板） |
| 文件树 | 展示 `workspace/projects/{projectId}/` 目录结构 |
| 代码编辑器 | Monaco Editor，支持语法高亮 |
| 命令输出面板 | 只读展示 Agent 执行的 shell 命令及输出 |
| 新增工具 | `list_files`、`edit_file`、`run_command` |
| 增强工具 | `read_file`、`write_file` 支持项目路径 |
| WebSocket 帧 | `session.set_mode`、`code.file_open`、`code.command_output` |
| 安全 | 路径解析、命令执行目录限制、危险操作确认 |

### 2.2 不包含内容（后续 Phase）

- `search_code` 工具（Phase 2）
- Git 集成（diff、status、commit 建议）（Phase 3）
- 多文件 diff 视图
- 断点调试
- LSP 语言服务器

---

## 3. 设计方案

### 3.1 会话模式

每个 `ChatSession` 增加字段：

```typescript
type ChatMode = 'chat' | 'code';

interface ChatSession {
  id: string;
  mode: ChatMode;
  projectId?: string; // code 模式下关联的项目目录
  // ... 其他字段
}
```

- `chat` 模式：现有行为，Agent 使用默认系统提示和普通工具。
- `code` 模式：Agent 系统提示追加编程角色说明，强调：
  - 先读取相关文件再修改
  - 使用 `edit_file` 进行小范围精确修改
  - 使用 `run_command` 运行测试/构建
  - 修改前说明意图

模式切换由前端按钮触发，通过 WebSocket 发送 `session.set_mode` 帧。

### 3.2 UI 布局

`/hub` 页面在 `code` 模式下切换为双栏布局：

```
┌─────────────────────────────────────────────────────────────┐
│  Header: Agent 信息 + [聊天模式 | 编程模式] 切换              │
├────────────────────┬────────────────────────────────────────┤
│                    │  IDE 面板（可折叠）                     │
│   聊天区域          │  ┌─────────────────────────────────┐   │
│   (ChatView)        │  │  文件树 (FileTree)               │   │
│                    │  ├─────────────────────────────────┤   │
│                    │  │  Monaco Editor                   │   │
│                    │  ├─────────────────────────────────┤   │
│                    │  │  TerminalPanel                   │   │
│                    │  └─────────────────────────────────┘   │
└────────────────────┴────────────────────────────────────────┘
```

- 文件树：展示项目目录，点击文件发送 `code.file_open` 帧，Agent 可读取并在编辑器中打开。
- Monaco Editor：展示当前打开文件内容。用户可手动编辑；Agent 修改后自动刷新。
- TerminalPanel：只读展示 `run_command` 的输出，支持清空和复制。

### 3.3 项目目录

项目根目录统一为：

```
{CLOUDMIND_DATA_DIR}/projects/{projectId}/
```

默认项目：
- 每个 Agent 首次进入 `code` 模式时，自动创建以 Agent ID 命名的默认项目目录。
- 用户可在设置中切换或创建新项目。

### 3.4 新增工具

#### `list_files`

列出项目目录下文件和文件夹。

```typescript
parameters: {
  path: string; // 相对项目根目录的路径，默认为 "."
  recursive?: boolean;
}
```

#### `edit_file`

基于 diff 的精确编辑。

```typescript
parameters: {
  path: string;
  oldString: string;
  newString: string;
}
```

要求：
- `oldString` 必须在文件中唯一存在。
- 如果存在多个匹配，返回错误并提示 Agent 扩大上下文。
- 替换后保留文件原换行符和编码。

#### `run_command`

在项目根目录下执行 shell 命令并捕获输出。

```typescript
parameters: {
  command: string;
  cwd?: string; // 相对项目根目录，默认为 "."
  timeout?: number; // 默认 60 秒
}
```

输出：
- stdout / stderr 合并返回
- 退出码
- 执行时间

限制：
- 禁止 `cd ..` 等逃逸操作
- 禁止修改 `..` 之外的路径
- 危险命令（如 `rm -rf`、`curl \|`）需要用户确认

### 3.5 增强现有工具

`read_file` 和 `write_file` 增加 `projectId` 上下文：
- 如果会话处于 `code` 模式且关联了项目，`path` 解析为相对于项目根目录。
- 否则保持现有行为（`workspace/files/` 下）。

### 3.6 WebSocket 协议新增帧

Client → Server：
- `session.set_mode` — 切换会话模式
- `code.file_open` — 用户在前端点击文件，请求 Agent 读取并打开

Server → Client：
- `code.file_opened` — 文件已在编辑器中打开，携带内容
- `code.file_changed` — Agent 修改了文件，刷新编辑器
- `code.command_output` — `run_command` 的输出片段
- `code.command_end` — 命令执行结束

### 3.7 安全模型

| 风险 | 缓解措施 |
|------|----------|
| 路径逃逸 | 所有路径解析为 `path.resolve(projectRoot, path)`，然后校验是否以 `projectRoot` 开头 |
| 命令逃逸 | `run_command` 在 `projectRoot` 下执行；解析命令字符串，禁止 `..`、`$HOME`、绝对路径等 |
| 危险命令 | 命令黑名单：`rm -rf /`、`curl \| sh`、`mkfs` 等；覆盖已有文件前确认 |
| 长时间运行 | `run_command` 默认 60 秒超时，可配置 |
| 大文件 | `read_file` 限制单次读取 100KB；`list_files` 限制返回条目数 |

---

## 4. 数据流

### 4.1 用户打开编程模式

```
用户点击「编程模式」按钮
    │
    ▼
前端发送 session.set_mode { mode: 'code', projectId: 'agent-1' }
    │
    ▼
后端更新 ChatSession.mode，向 AgentWorker 注入 code 系统提示
    │
    ▼
前端切换为双栏布局，加载 FileTree
```

### 4.2 Agent 读取并编辑文件

```
Agent 调用 list_files { path: "." }
    │
    ▼
后端返回文件列表
    │
    ▼
Agent 调用 read_file { path: "src/main.ts" }
    │
    ▼
后端返回内容，前端通过 code.file_opened 展示到 Monaco Editor
    │
    ▼
Agent 调用 edit_file { path: "src/main.ts", oldString: "...", newString: "..." }
    │
    ▼
后端修改文件，前端通过 code.file_changed 刷新编辑器
```

### 4.3 Agent 运行命令

```
Agent 调用 run_command { command: "pnpm test" }
    │
    ▼
后端启动子进程，实时通过 code.command_output 推送 stdout/stderr
    │
    ▼
命令结束，后端发送 code.command_end { exitCode: 0 }
```

---

## 5. 文件结构

### 5.1 后端新增/修改

```
services/engine/src/
├── tools/builtin/
│   ├── list_files.ts          # 新增
│   ├── edit_file.ts           # 新增
│   ├── run_command.ts         # 新增
│   ├── read.ts                # 修改：支持项目路径
│   └── write.ts               # 修改：支持项目路径
├── api/ws/handler.ts          # 修改：处理 session.set_mode、code.file_open
├── api/ws/protocol.ts         # 修改：新增帧类型
└── core/agent-worker.ts       # 修改：根据 mode 注入不同系统提示
```

### 5.2 前端新增/修改

```
apps/web/
├── pages/hub.vue              # 修改：增加模式切换和 IDE 容器
├── components/
│   ├── ChatView.vue           # 修改：适配双栏布局
│   └── code/
│       ├── CodeWorkspace.vue  # 新增
│       ├── FileTree.vue       # 新增
│       ├── CodeEditor.vue     # 新增
│       └── TerminalPanel.vue  # 新增
├── stores/chat.ts             # 修改：增加 mode / openFiles / projectId
└── composables/
    └── useEngineClient.ts     # 修改：处理 code.* 帧
```

---

## 6. 成功标准

- [ ] `/hub` 页面有「编程模式」切换按钮
- [ ] 编程模式下展示文件树、Monaco Editor、命令输出面板
- [ ] `session.set_mode` 能正确切换 Agent 系统提示
- [ ] `list_files`、`edit_file`、`run_command` 工具可用
- [ ] Agent 能在编程模式下读取、修改项目文件并运行命令
- [ ] 文件/命令操作被限制在项目根目录内
- [ ] `pnpm typecheck` 和 `pnpm build` 通过

---

## 7. 风险与假设

| 风险 | 缓解 |
|------|------|
| Monaco Editor 体积大 | 使用 `@monaco-editor/loader` 按需加载，或考虑 CodeMirror 作为轻量替代 |
| 命令执行安全风险 | 严格命令白名单/黑名单 + 用户确认 + 超时限制 |
| Agent 误改文件 | `edit_file` 要求 `oldString` 唯一匹配；重要文件修改前确认 |
| 大项目文件树卡顿 | 文件树分页/懒加载，限制单次返回条目数 |

---

## 8. 后续步骤

1. 调用 `writing-plans` 生成 Phase 1 详细实现计划。
2. 按实现计划开发并验证。
3. Phase 1 完成后 review，再进入 Phase 2/3。
