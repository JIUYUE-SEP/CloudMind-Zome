# 清理 Python 后端与旧版 frontend — 设计规格

> 版本：1.0 | 日期：2026-07-02
> 目标：彻底移除 CloudMind-Zome 项目中遗留的 Python 后端（`backend/`）及依赖它的旧版 Tauri 桌面应用（`frontend/`），保留并仅保留 Node.js + TypeScript 新架构。

---

## 1. 背景

CloudMind-Zome 项目已完成架构迁移：
- **旧架构**：`backend/`（Python FastAPI + 自定义 Python Agent 引擎） + `frontend/`（Vite + Tauri 2 桌面壳）
- **新架构**：`services/engine/`（Node.js 22 + Fastify 5 + TypeScript） + `apps/web/`（Nuxt 3） + `apps/desktop/`（Tauri 2 + Rust sidecar）

旧 `backend/` 与 `frontend/` 已不再被主工作流使用（`pnpm-workspace.yaml`、`turbo.json`、`start-dev.bat`、`start-tauri.bat` 均指向新架构），但代码仍留在仓库中，造成维护负担和混淆。

---

## 2. 清理范围

### 2.1 删除项

| 路径 | 说明 | 删除原因 |
|------|------|----------|
| `backend/` | 旧版 Python 后端与引擎 | 已被 `services/engine/` 替代 |
| `frontend/` | 旧版 Vite + Tauri 桌面应用 | 专为旧 Python backend 服务，已被 `apps/desktop/` 替代 |
| `scripts/package_backend.py` | 打包 Python backend 到 Tauri 产物 | 依赖已删除的 `backend/` |
| `scripts/prepare_embedded_python.py` | 准备 Windows 嵌入式 Python 运行时 | 依赖已删除的 `backend/` |
| `tests/engine/agent/test_data_store.py` | Python 测试文件 | 属于旧 Python 引擎 |
| `backend.log`、`frontend.log`、`preview.log` | 开发日志 | 旧架构运行遗留 |

### 2.2 修改项

| 文件 | 修改内容 |
|------|----------|
| `README.md` | 移除 Python 环境要求、旧 frontend 说明、旧数据目录说明 |
| `docs/开发指南.md` | 移除 Python 环境要求、旧启动方式、旧调试说明 |
| `docs/架构文档.md` | 修正为 Node.js + TypeScript 架构，移除 Python 相关描述 |
| `docs/DEPLOY.md` | 移除旧版桌面打包、嵌入式 Python、旧 Web 模式部署说明 |
| `.gitignore` | 清理仅与 Python/backend 相关的忽略项（如 `__pycache__`、`.venv`、`backend/*.log` 等），保留通用项 |
| `docs/superpowers/specs/2026-06-24-cloudmind-docs-rewrite-design.md` | 由于外部文档已生成，源项目文档修正后无需回改 |

### 2.3 保留项

- `apps/web/`（新版 Nuxt 3 前端）
- `apps/desktop/`（新版 Tauri 2 桌面应用）
- `services/engine/`（新版 Node.js/TypeScript 引擎）
- `crates/zome-sidecar/`（Rust 性能侧车）
- `packages/shared/`、`packages/skills/`
- `node_modules/` 中的依赖文件
- `workspace/` 本地运行时数据

---

## 3. 设计原则

1. **只删旧、不动新**：删除确认属于旧架构的文件，新版 Node.js 架构的文件一字不改。
2. **文档同步**：README 和 docs 中关于技术栈、环境要求、部署方式的描述必须与新架构一致。
3. **gitignore 最小化**：只移除明确仅服务于 Python/backend 的忽略规则；通用规则（如 `.log`、`.env`）保留。
4. **可验证**：清理后必须能通过 `pnpm install`、`pnpm typecheck`、`pnpm build`。
5. **不合并**：按用户要求，清理完成后停留在分支，等待人工审查后再合并。

---

## 4. 风险与缓解

| 风险 | 缓解措施 |
|------|----------|
| 误删新版代码 | 删除前逐项核对路径；只删除列出的旧架构目录/文件 |
| 文档遗漏旧引用 | 全局搜索 `backend/`、`python`、`uvicorn`、`app.main:app`、`prepare_embedded_python`、`package_backend` 等关键词 |
| 构建失败 | 清理后运行 `pnpm install`、`pnpm typecheck`、`pnpm build` 验证 |
| CI 失败 | 检查 `.github/workflows/ci.yml` 是否引用 Python/backend；有则同步移除 |

---

## 5. 成功标准

- [ ] 分支 `cleanup/remove-python-backend` 创建成功
- [ ] `backend/`、`frontend/`、`scripts/package_backend.py`、`scripts/prepare_embedded_python.py`、`tests/engine/agent/test_data_source.py` 已删除
- [ ] 开发日志 `backend.log`、`frontend.log`、`preview.log` 已删除
- [ ] `README.md` 和 `docs/` 中无 Python backend、旧 `frontend/` 的引用
- [ ] `.gitignore` 中仅保留通用规则
- [ ] `pnpm typecheck` 通过
- [ ] `pnpm build` 通过（或至少新架构的核心包构建通过）
- [ ] 未合并到 `main`，等待用户审查

---

## 6. 后续步骤

1. 调用 `writing-plans` 生成详细执行计划。
2. 创建分支并执行清理。
3. 验证构建。
4. 提交并请用户审查。
