# 部署指南

## 桌面应用（推荐）

### 环境要求

- Node.js 22+
- Rust（版本见 `rust-toolchain.toml`，当前 1.88）
- protoc 27+
- Windows: WebView2 Runtime

### 构建步骤

```bash
# 1. 安装依赖
pnpm install

# 2. 构建 engine 和 web
pnpm build

# 3. 构建 Rust sidecar
cd crates/zome-sidecar
cargo build --release
cd ../..

# 4. 准备 sidecar 二进制
node scripts/prepare-sidecar.mjs release

# 5. 构建桌面安装包
pnpm --filter @mindcloud/desktop build
```

构建输出位于 `apps/desktop/src-tauri/target/release/bundle/`。

## Web 模式

```bash
pnpm build
pnpm --filter @mindcloud/engine start    # node dist/src/bootstrap.js
pnpm --filter @mindcloud/web preview     # 预览构建产物（web 无 start 脚本）
```

访问 `http://localhost:3000`。

> sidecar 在 Web 模式下可选：需要向量记忆时，先 `cargo build --release --manifest-path crates/zome-sidecar/Cargo.toml` 并运行 `zome-sidecar`（gRPC `127.0.0.1:50051`），engine 会自动连接。

## 数据目录

默认数据目录：`~/.cloudmind-zome`

- Windows: `%USERPROFILE%\.cloudmind-zome`
- macOS / Linux: `~/.cloudmind-zome`

可通过环境变量 `CLOUDMIND_DATA_DIR` 覆盖。

## Provider 配置

首次运行时，通过前端「算力中枢」添加 LLM Provider：

- Provider Type: `openai`
- Base URL: `https://api.openai.com/v1` 或兼容接口
- API Key: 你的 API Key

配置完成后，即可创建 Agent 并开始对话。
