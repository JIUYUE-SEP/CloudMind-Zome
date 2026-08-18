# 部署指南

> 产品形态：纯 Web 应用（engine + Nuxt 前端）。桌面端（Tauri）已于 2026-08-19 移除
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
pnpm --filter @mindcloud/engine --filter @mindcloud/web build

# 3. 运行
pnpm --filter @mindcloud/engine start    # node dist/src/bootstrap.js
pnpm --filter @mindcloud/web preview     # 预览构建产物（web 无 start 脚本）
```

访问 `http://localhost:3000`（engine API 在 `http://127.0.0.1:8848`，Swagger UI 在 `/docs`，
REST 需 Bearer token——见 `docs/API.md` 鉴权章节；开发模式下前端经 nitro
`/api/engine-token` 自动下发，无需手动配置）。

> sidecar 可选：需要向量记忆（跨会话语义检索）时，先
> `cargo build --release --manifest-path crates/zome-sidecar/Cargo.toml` 并运行
> `zome-sidecar`（gRPC `127.0.0.1:50051`），engine 会自动连接；不运行则静默降级。

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
