# 清理 Python 后端与旧版 frontend — 实现计划

> **历史文档 / 已归档**：本计划已执行完毕（2026-07-02）。保留用于追溯历史，不再作为当前实施依据。

> **面向 AI 代理的工作者：** 本计划为代码/目录清理任务，推荐在当前会话中内联执行。步骤使用复选框（`- [ ]`）语法跟踪进度。

**目标：** 彻底移除 CloudMind-Zome 项目中遗留的 Python 后端（`backend/`）及依赖它的旧版 Tauri 桌面应用（`frontend/`），保留并仅保留 Node.js + TypeScript 新架构。

**架构：** 删除旧架构目录和脚本，修正 README 与 docs 中的技术栈描述，清理 .gitignore 中 Python 专用规则，最后验证新架构仍可构建。

**技术栈：** Git、Bash、Markdown、pnpm、Turborepo、Tauri、Rust。

---

## 1. 文件结构

### 1.1 删除的文件/目录

| 路径 | 类型 | 说明 |
|------|------|------|
| `backend/` | 目录 | 旧版 Python 后端与引擎 |
| `frontend/` | 目录 | 旧版 Vite + Tauri 桌面应用 |
| `scripts/package_backend.py` | 文件 | 打包 Python backend 脚本 |
| `scripts/prepare_embedded_python.py` | 文件 | 准备 Windows 嵌入式 Python 脚本 |
| `tests/engine/agent/test_data_store.py` | 文件 | 旧版 Python 引擎相关测试 |
| `backend.log` | 文件 | 旧后端开发日志 |
| `frontend.log` | 文件 | 旧前端开发日志 |
| `preview.log` | 文件 | 旧前端预览日志 |

### 1.2 修改的文件

| 路径 | 修改内容 |
|------|----------|
| `README.md` | 移除 Python 环境要求、旧 frontend 说明、旧数据目录说明 |
| `docs/开发指南.md` | 移除 Python 环境要求、旧启动方式、旧调试说明 |
| `docs/架构文档.md` | 修正为 Node.js + TypeScript 架构，移除 Python 相关描述 |
| `docs/DEPLOY.md` | 移除旧版桌面打包、嵌入式 Python、旧 Web 模式部署说明 |
| `.gitignore` | 清理仅与 Python/backend 相关的忽略项 |

---

## 2. 任务分解

### 任务 1：创建分支

**文件：**
- 修改：仓库当前分支状态

- [ ] **步骤 1：基于 main 创建清理分支**

  运行：
  ```bash
  cd /f/MyProject_justlove/MindCloud-Zome
  git checkout -b cleanup/remove-python-backend
  ```

- [ ] **步骤 2：确认当前分支**

  运行：
  ```bash
  git branch --show-current
  ```
  预期输出：`cleanup/remove-python-backend`

---

### 任务 2：删除旧架构目录和文件

**文件：**
- 删除：`backend/`
- 删除：`frontend/`
- 删除：`scripts/package_backend.py`
- 删除：`scripts/prepare_embedded_python.py`
- 删除：`tests/engine/agent/test_data_store.py`
- 删除：`backend.log`
- 删除：`frontend.log`
- 删除：`preview.log`

- [ ] **步骤 1：删除目录和文件**

  运行：
  ```bash
  cd /f/MyProject_justlove/MindCloud-Zome
  rm -rf backend/
  rm -rf frontend/
  rm -f scripts/package_backend.py
  rm -f scripts/prepare_embedded_python.py
  rm -f tests/engine/agent/test_data_store.py
  rm -f backend.log frontend.log preview.log
  ```

- [ ] **步骤 2：验证删除结果**

  运行：
  ```bash
  ls -d backend frontend 2>/dev/null || echo "backend/ frontend/ 已删除"
  ls scripts/package_backend.py scripts/prepare_embedded_python.py 2>/dev/null || echo "Python 脚本已删除"
  ls tests/engine/agent/test_data_store.py 2>/dev/null || echo "旧测试已删除"
  ls backend.log frontend.log preview.log 2>/dev/null || echo "日志已删除"
  ```
  预期：所有检查都输出"已删除"。

- [ ] **步骤 3：Commit 删除操作**

  运行：
  ```bash
  git add -A
  git commit -m "chore: remove legacy Python backend and old frontend"
  ```

---

### 任务 3：修改 README.md

**文件：**
- 修改：`README.md`

- [ ] **步骤 1：读取当前 README.md**

  读取：`F:/MyProject_justlove/MindCloud-Zome/README.md`

- [ ] **步骤 2：移除 Python 相关内容**

  需要移除或替换的内容：
  - 环境要求中的 Python（实际为 Node.js 22+、Rust 1.80+、protoc）
  - 旧数据目录 `~/.cloudmind-zome` 中提及 Python backend 的部分
  - 任何提到 `backend/`、`uvicorn`、`app.main:app`、`frontend/` 旧版的位置

  修改后 README 应描述：
  - 项目定位
  - 使用场景
  - 功能列表
  - 核心概念
  - 新架构技术栈
  - 新快速开始命令（`pnpm install`、`pnpm dev`）
  - 新数据目录结构
  - 文档链接

- [ ] **步骤 3：验证修改**

  运行：
  ```bash
  grep -n "python\|Python\|backend/\|uvicorn\|app.main\|frontend/" /f/MyProject_justlove/MindCloud-Zome/README.md || echo "无 Python/旧 frontend 残留"
  ```
  预期：无匹配或仅保留合理引用（如历史说明不应保留）。

- [ ] **步骤 4：Commit**

  运行：
  ```bash
  git add README.md
  git commit -m "docs: update README for Node.js architecture"
  ```

---

### 任务 4：修改 docs/开发指南.md

**文件：**
- 修改：`docs/开发指南.md`

- [ ] **步骤 1：读取当前 docs/开发指南.md**

  读取：`F:/MyProject_justlove/MindCloud-Zome/docs/开发指南.md`

- [ ] **步骤 2：移除 Python 相关内容**

  需要移除或替换：
  - Python 环境要求
  - 旧启动方式（如 `python -m uvicorn app.main:app`）
  - 旧调试技巧（如查看 Python backend 日志）
  - 旧 per-Agent 存储路径中与 Python 相关的描述（如保留则改为 Node.js 实现）

- [ ] **步骤 3：验证修改**

  运行：
  ```bash
  grep -n "python\|Python\|uvicorn\|app.main\|backend/" /f/MyProject_justlove/MindCloud-Zome/docs/开发指南.md || echo "无 Python 残留"
  ```
  预期：无匹配。

- [ ] **步骤 4：Commit**

  运行：
  ```bash
  git add docs/开发指南.md
  git commit -m "docs: update dev guide for Node.js architecture"
  ```

---

### 任务 5：修改 docs/架构文档.md

**文件：**
- 修改：`docs/架构文档.md`

- [ ] **步骤 1：读取当前 docs/架构文档.md**

  读取：`F:/MyProject_justlove/MindCloud-Zome/docs/架构文档.md`

- [ ] **步骤 2：修正架构描述**

  需要修正的内容：
  - 技术栈表格确保为 Node.js + TypeScript + Fastify 5 + Nuxt 3 + Tauri 2 + Rust sidecar
  - 后端分层架构图中的 `backend/` 改为 `services/engine/`
  - 移除任何 Python 相关描述（如 `uvicorn`、`FastAPI`、`SQLAlchemy` 等）
  - 数据库模型部分：当前实现是 SQLite 还是 per-Agent JSON/JSONL 需与代码一致
  - 任何提到旧 Python 实现的章节

- [ ] **步骤 3：验证修改**

  运行：
  ```bash
  grep -n "python\|Python\|FastAPI\|SQLAlchemy\|uvicorn\|app.main\|backend/" /f/MyProject_justlove/MindCloud-Zome/docs/架构文档.md || echo "无 Python 残留"
  ```
  预期：无匹配。

- [ ] **步骤 4：Commit**

  运行：
  ```bash
  git add docs/架构文档.md
  git commit -m "docs: update architecture doc for Node.js architecture"
  ```

---

### 任务 6：修改 docs/DEPLOY.md

**文件：**
- 修改：`docs/DEPLOY.md`

- [ ] **步骤 1：读取当前 docs/DEPLOY.md**

  读取：`F:/MyProject_justlove/MindCloud-Zome/docs/DEPLOY.md`

- [ ] **步骤 2：移除旧部署说明**

  需要移除：
  - 旧版桌面打包（使用 `frontend/src-tauri`）
  - 嵌入式 Python 准备说明
  - 旧 Web 模式部署（使用 `backend/run.py`）

  保留/新增：
  - 新版 Web 模式部署（`pnpm build` + `pnpm --filter @mindcloud/engine start` + `pnpm --filter @mindcloud/web start`）
  - 新版 Tauri 桌面打包（`pnpm --filter @mindcloud/desktop tauri build`）

- [ ] **步骤 3：验证修改**

  运行：
  ```bash
  grep -n "python\|Python\|embedded\|frontend/src-tauri\|backend/run" /f/MyProject_justlove/MindCloud-Zome/docs/DEPLOY.md || echo "无旧部署残留"
  ```
  预期：无匹配。

- [ ] **步骤 4：Commit**

  运行：
  ```bash
  git add docs/DEPLOY.md
  git commit -m "docs: update deploy guide for Node.js architecture"
  ```

---

### 任务 7：清理 .gitignore

**文件：**
- 修改：`.gitignore`

- [ ] **步骤 1：读取当前 .gitignore**

  读取：`F:/MyProject_justlove/MindCloud-Zome/.gitignore`

- [ ] **步骤 2：移除 Python/backend 专用规则**

  需要移除的规则示例（以实际文件为准）：
  - `__pycache__/`
  - `*.pyc`
  - `*.pyo`
  - `*.pyd`
  - `.venv/`
  - `venv/`
  - `backend/*.log`
  - `backend/.pytest_cache/`
  - `backend/.ruff_cache/`
  - Python 相关的 egg-info、dist、build 等

  保留的通用规则：
  - `.env`
  - `.env.local`
  - `node_modules/`
  - `dist/`
  - `.nuxt/`
  - `.turbo/`
  - `target/`
  - `.log`（通用日志模式，保留）

- [ ] **步骤 3：验证修改**

  运行：
  ```bash
  grep -n "__pycache__\|\.venv\|venv/\|\.pyc\|\.pyo\|\.pyd\|egg-info\|backend/\." /f/MyProject_justlove/MindCloud-Zome/.gitignore || echo "无 Python 专用 gitignore 规则"
  ```
  预期：无匹配。

- [ ] **步骤 4：Commit**

  运行：
  ```bash
  git add .gitignore
  git commit -m "chore: remove Python-specific gitignore rules"
  ```

---

### 任务 8：全局搜索并修复遗漏的 Python/旧 frontend 引用

**文件：**
- 可能修改：任何仍引用 Python backend 或旧 frontend 的非 node_modules 文件

- [ ] **步骤 1：全局搜索关键词**

  运行：
  ```bash
  cd /f/MyProject_justlove/MindCloud-Zome
  grep -R "backend/\|prepare_embedded_python\|package_backend\|uvicorn\|app.main:app\|frontend/src-tauri" \
    --include="*.md" --include="*.json" --include="*.yml" --include="*.yaml" \
    --include="*.bat" --include="*.ps1" --include="*.sh" --include="*.mjs" \
    --include="*.js" --include="*.ts" --include="*.vue" --include="*.rs" \
    . 2>/dev/null | grep -v node_modules | grep -v ".git/" | head -n 50
  ```

- [ ] **步骤 2：处理搜索结果**

  对每一条匹配，判断是否属于旧架构引用：
  - 如果是，删除或修正
  - 如果与新架构无关的合法引用（如文档中的历史说明），保留并备注

- [ ] **步骤 3：Commit 修复**

  运行：
  ```bash
  git add -A
  git commit -m "chore: remove remaining Python/old frontend references"
  ```

---

### 任务 9：验证构建

**文件：**
- 验证对象：`services/engine/`、`apps/web/`、`apps/desktop/`、`crates/zome-sidecar/`

- [ ] **步骤 1：安装依赖**

  运行：
  ```bash
  cd /f/MyProject_justlove/MindCloud-Zome
  pnpm install
  ```
  预期：成功完成，无 Python 相关错误。

- [ ] **步骤 2：类型检查**

  运行：
  ```bash
  pnpm typecheck
  ```
  预期：通过。

- [ ] **步骤 3：构建新架构**

  运行：
  ```bash
  pnpm build
  ```
  预期：新架构各包构建成功。

  注：如果 `apps/desktop` 构建因本地环境（如 WebView2、签名）失败，至少确保 `services/engine` 和 `apps/web` 构建成功。

- [ ] **步骤 4：Rust sidecar 检查**

  运行：
  ```bash
  cd /f/MyProject_justlove/MindCloud-Zome/crates/zome-sidecar
  cargo fmt --check
  cargo clippy -- -D warnings
  cargo build --release
  ```
  预期：fmt/clippy/build 通过。

---

### 任务 10：最终检查与提交

- [ ] **步骤 1：检查工作区状态**

  运行：
  ```bash
  cd /f/MyProject_justlove/MindCloud-Zome
  git status
  ```
  预期：所有变更已 commit，工作区干净。

- [ ] **步骤 2：查看提交历史**

  运行：
  ```bash
  git log --oneline -10
  ```
  预期：显示清理相关的多个 commit。

- [ ] **步骤 3：确认未合并**

  运行：
  ```bash
  git branch -v
  ```
  预期：`cleanup/remove-python-backend` 分支存在，未与 main 合并。

---

## 3. 自检

### 3.1 规格覆盖度

| 规格需求 | 对应任务 |
|----------|----------|
| 创建分支 | 任务 1 |
| 删除 backend/、frontend/、Python 脚本、旧测试、日志 | 任务 2 |
| 更新 README.md | 任务 3 |
| 更新 docs/开发指南.md | 任务 4 |
| 更新 docs/架构文档.md | 任务 5 |
| 更新 docs/DEPLOY.md | 任务 6 |
| 清理 .gitignore | 任务 7 |
| 全局搜索遗漏引用 | 任务 8 |
| 验证构建 | 任务 9 |
| 不合并到 main | 任务 10 |

### 3.2 占位符扫描

- 无 "待定"、"TODO"、"后续实现"。
- 每个任务包含具体命令和预期输出。
- 无未定义类型或函数引用。

### 3.3 一致性检查

- 所有路径使用 `/f/MyProject_justlove/MindCloud-Zome`。
- 删除和修改操作严格限定在旧架构范围内。
- 验证命令针对新架构，确保清理后仍可工作。

---

## 4. 执行方式

本计划推荐**内联执行**（在当前会话中按任务顺序执行），因为任务之间有明确顺序（先删除再修改文档，最后验证），且操作相对直接。

如需使用子代理驱动，请说明。
