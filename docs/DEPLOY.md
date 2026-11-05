# 部署指南

> 日期：2026-11-05 对账 | 产品形态：纯 Web 应用（engine + Nuxt 前端）。桌面端（Tauri）已于 2026-08-19 移除
> （git 历史可回溯）；sidecar 保留为可选性能组件（向量记忆）。

## Web 模式（唯一形态）

### 环境要求

- Node.js 22+
- （可选）Rust（`rust-toolchain.toml`）+ protoc 27+ —— 仅当要运行 sidecar（向量记忆）时

### 构建与运行

```bash
# 1. 安装依赖
pnpm install

# 2. 构建 engine 和 web
pnpm --filter @cloudmind/engine --filter @cloudmind/web build

# 3. 运行
pnpm --filter @cloudmind/engine start    # node dist/src/bootstrap.js
pnpm --filter @cloudmind/web preview     # 预览构建产物（web 无 start 脚本）
```

访问 `http://localhost:3000`（engine API 在 `http://127.0.0.1:8848`，Swagger UI 在 `/docs`，
REST 需 Bearer token——见 `docs/API.md` 鉴权章节；开发模式下前端经 nitro
`/api/engine-token` 自动下发，无需手动配置）。

> sidecar 可选：需要向量记忆（跨会话语义检索）时，先
> `cargo build --release --manifest-path crates/zome-sidecar/Cargo.toml` 并运行
> `zome-sidecar`（gRPC `127.0.0.1:50051`），engine 会自动连接；不运行则静默降级。

### sidecar 准备（可选，自启唤醒）

生产部署可让 engine 自启 sidecar（`settings.sidecarAutoStart`，默认关）——系统设置面板勾选，或直接写
`config.json` 的 `settings.sidecarAutoStart: true`。二进制准备二选一：

1. **仓内产物**（推荐）：`cargo build --release --manifest-path crates/zome-sidecar/Cargo.toml`
   ——发现序自动命中 `crates/zome-sidecar/target/release/zome-sidecar`；
2. **显式指认**：环境变量 `ZOME_SIDECAR_BIN=/path/to/zome-sidecar`（最优先档）。

其余发现档：仓内 debug 产物 → PATH `zome-sidecar` → `cargo run` 兜底；全灭只 warn 降级不影响
engine 启动。已在跑的健康实例（手动起的）会被纳用不重复拉起。

## 安装后更新

一条命令（推荐）：

```bash
scripts/update.sh              # git pull → pnpm install → build → pnpm verify
scripts/update.sh --skip-verify  # 跳过验证快速更新
```

脚本**不是**自动更新器：不在后台跑、不检查新版本、不重启进程——更新完成后请自行重启 engine 与 web 生效。等价的手工四步：`git pull` → `pnpm install` → `pnpm --filter @cloudmind/shared --filter @cloudmind/engine --filter @cloudmind/web build` → 重启。若在用 sidecar，记得一并 `cargo build --release`。

**数据兼容性**：

- 数据目录（DATA_DIR）在更新中不受影响。落盘格式带 `schemaVersion` 戳（单文件 JSON 顶层 / JSONL 每行 / 压缩档 frontmatter），**读时惰性迁移**——升级后旧格式数据在首次被读到时自动迁移，无需手工处理
- 启动对账：engine 每次启动自动补归档「压缩档已写但归档未完成」的孤儿消息与未压缩 pending 段，异常退出后的更新同样安全
- 若启动时报 `落盘格式版本过高`：说明**代码比数据旧**（数据由更新版本写入）——请升级代码，**不要删数据目录**（文件未被做任何改动）
- 回滚：`git checkout <旧 commit>` + 重新 build 即可回到旧版代码；但回滚后旧代码可能读不出新版本写入的数据格式（同上的高版本报错），数据本身始终保留

## 数据目录

- 默认 `~/.cloudmind-zome`（Windows 上为 `%USERPROFILE%\.cloudmind-zome`）
- sidecar 若运行，由其解析统一目录并在 spawn engine 时经 `CLOUDMIND_DATA_DIR` 注入
- 均可通过环境变量 `CLOUDMIND_DATA_DIR` 覆盖

## Provider 配置

首次运行时，通过前端「算力中枢」添加 LLM Provider：

- Provider Type: `openai`
- Base URL: `https://api.openai.com/v1` 或兼容接口
- API Key: 你的 API Key

配置完成后，即可创建 Agent 并开始对话。
