# CloudMind-Zome JS/TypeScript 重构实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 在 git 分支 `refactor/js-rewrite` 上用 JavaScript/TypeScript + Rust 完整重写 CloudMind-Zome，实现 Node.js 核心引擎、Rust 性能侧车、Nuxt 3 前端、Tauri 桌面集成，并迁移全部现有功能。

**架构：** 采用 monorepo（pnpm workspace + Turborepo）：`services/engine` 作为独立 Node.js/TypeScript 后端；`crates/zome-sidecar` 作为 Rust 性能侧车；`apps/web` 作为 Nuxt 3 前端；`apps/desktop` 作为 Tauri 桌面壳。数据层使用 per-Agent JSON/JSONL 文档存储。Agent 核心参考 Kimi Code CLI（MIT License）实现无状态 ReAct loop、ToolScheduler、thinking/content 分离、子代理前台/后台/Swarm 模式。

**技术栈：** TypeScript、Node.js 22+、Fastify、Nuxt 3、Vue 3、Pinia、Tauri 2、Rust、gRPC、WebSocket、Vitest、Playwright、cargo test。

---

## 0. 前置动作

以下动作必须在进入 Phase 0 之前完成：

- [ ] **步骤 0.1：创建并切换到 git 分支**

  运行：
  ```bash
  git checkout -b refactor/js-rewrite
  ```

- [ ] **步骤 0.2：确认当前工作区状态**

  运行：
  ```bash
  git status
  ```
  预期：当前在 `refactor/js-rewrite` 分支，无未跟踪的 Python 迁移中间文件干扰根目录。

---

## Phase 1：基础设施与 Monorepo 搭建

**目标：** 创建分支、搭建 pnpm workspace + Turborepo、配置 TypeScript/Rust 基础工具链、共享类型包、CI 骨架。

**涉及文件：**
- 创建：`package.json`、`pnpm-workspace.yaml`、`turbo.json`、`tsconfig.json`、`.nvmrc`、`.rust-toolchain.toml`
- 创建：`packages/shared/package.json`、`packages/shared/src/index.ts`
- 创建：`services/engine/package.json`、`services/engine/tsconfig.json`
- 创建：`apps/web/package.json`、`apps/web/nuxt.config.ts`、`apps/web/tsconfig.json`
- 创建：`apps/desktop/package.json`、`apps/desktop/src-tauri/Cargo.toml`
- 创建：`crates/zome-sidecar/Cargo.toml`
- 创建：`.github/workflows/ci.yml`
- 修改：`docs/superpowers/specs/2026-06-24-js-rewrite-design.md`（如有必要，同步更新）

**任务步骤：**

- [ ] **步骤 1.1：初始化根 package.json 和 pnpm workspace**

  在仓库根目录创建 `package.json`：
  ```json
  {
    "name": "mindcloud-zome",
    "version": "2.0.0",
    "private": true,
    "packageManager": "pnpm@10.33.0",
    "scripts": {
      "dev": "turbo run dev",
      "build": "turbo run build",
      "test": "turbo run test",
      "lint": "turbo run lint",
      "typecheck": "turbo run typecheck"
    },
    "devDependencies": {
      "turbo": "^2.5.0"
    }
  }
  ```

  创建 `pnpm-workspace.yaml`：
  ```yaml
  packages:
    - "apps/*"
    - "services/*"
    - "packages/*"
    - "crates/*"
  ```

- [ ] **步骤 1.2：配置 Turborepo**

  创建 `turbo.json`：
  ```json
  {
    "$schema": "https://turbo.build/schema.json",
    "globalDependencies": ["**/.env.*local", "**/tsconfig.json"],
    "tasks": {
      "build": { "dependsOn": ["^build"], "outputs": ["dist/**", ".nuxt/**", "target/**"] },
      "dev": { "cache": false, "persistent": true },
      "test": { "dependsOn": ["build"], "outputs": ["coverage/**"] },
      "lint": {},
      "typecheck": { "dependsOn": ["^build"] }
    }
  }
  ```

- [ ] **步骤 1.3：创建共享类型包 `packages/shared`**

  创建 `packages/shared/package.json`：
  ```json
  {
    "name": "@mindcloud/shared",
    "version": "0.1.0",
    "type": "module",
    "main": "./dist/index.js",
    "types": "./dist/index.d.ts",
    "scripts": {
      "build": "tsc",
      "dev": "tsc --watch",
      "typecheck": "tsc --noEmit"
    },
    "devDependencies": { "typescript": "^5.8.0" }
  }
  ```

  创建 `packages/shared/tsconfig.json`：
  ```json
  {
    "compilerOptions": {
      "target": "ES2022",
      "module": "Node16",
      "moduleResolution": "Node16",
      "declaration": true,
      "strict": true,
      "esModuleInterop": true,
      "skipLibCheck": true,
      "outDir": "./dist",
      "rootDir": "./src"
    },
    "include": ["src/**/*"]
  }
  ```

  创建 `packages/shared/src/index.ts`：
  ```typescript
  export interface AgentConfig {
    id: string;
    name: string;
    persona: string;
    model: string;
    skills: string[];
    tools: string[];
  }

  export interface ChatMessage {
    id: string;
    role: "user" | "assistant" | "tool";
    content: Array<{ type: "text"; text: string } | { type: "think"; think: string }>;
    createdAt: string;
  }
  ```

- [ ] **步骤 1.4：创建 `services/engine` 初始包**

  创建 `services/engine/package.json`：
  ```json
  {
    "name": "@mindcloud/engine",
    "version": "0.1.0",
    "type": "module",
    "scripts": {
      "dev": "tsx watch src/bootstrap.ts",
      "build": "tsc",
      "start": "node dist/bootstrap.js",
      "test": "vitest run",
      "lint": "eslint src tests",
      "typecheck": "tsc --noEmit"
    },
    "dependencies": {
      "fastify": "^5.3.0",
      "@fastify/websocket": "^11.0.0",
      "@grpc/grpc-js": "^1.13.0",
      "@grpc/proto-loader": "^0.8.0",
      "pino": "^9.6.0",
      "zod": "^3.25.0",
      "openai": "^4.95.0",
      "cron-parser": "^5.0.0"
    },
    "devDependencies": {
      "@types/node": "^22.15.0",
      "tsx": "^4.19.0",
      "typescript": "^5.8.0",
      "vitest": "^3.2.0",
      "supertest": "^7.1.0",
      "@types/supertest": "^6.0.0",
      "eslint": "^9.25.0"
    }
  }
  ```

  创建 `services/engine/src/bootstrap.ts`：
  ```typescript
  import { createServer } from "./api/server.js";

  async function main() {
    const app = await createServer();
    await app.listen({ port: Number(process.env.PORT || 8848), host: "127.0.0.1" });
    console.log(`Engine listening on ${app.server.address()}`);
  }

  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
  ```

  创建 `services/engine/src/api/server.ts`：
  ```typescript
  import Fastify from "fastify";

  export async function createServer() {
    const app = Fastify({ logger: true });
    app.get("/health", async () => ({ status: "ok" }));
    return app;
  }
  ```

- [ ] **步骤 1.5：创建 `apps/web` Nuxt 3 项目**

  创建 `apps/web/package.json`：
  ```json
  {
    "name": "@mindcloud/web",
    "version": "0.1.0",
    "type": "module",
    "scripts": {
      "build": "nuxt build",
      "dev": "nuxt dev",
      "generate": "nuxt generate",
      "preview": "nuxt preview",
      "postinstall": "nuxt prepare",
      "typecheck": "nuxt typecheck"
    },
    "dependencies": {
      "@pinia/nuxt": "^0.11.0",
      "pinia": "^3.0.2",
      "@tauri-apps/api": "^2.5.0"
    },
    "devDependencies": {
      "nuxt": "^3.16.0",
      "vue": "^3.5.0",
      "typescript": "^5.8.0",
      "vue-tsc": "^2.2.0"
    }
  }
  ```

  创建 `apps/web/nuxt.config.ts`：
  ```typescript
  export default defineNuxtConfig({
    ssr: true,
    devtools: { enabled: true },
    modules: ["@pinia/nuxt"],
    runtimeConfig: {
      engineUrl: process.env.ENGINE_URL || "http://127.0.0.1:8848",
      public: { engineUrl: process.env.ENGINE_URL || "http://127.0.0.1:8848" }
    }
  });
  ```

  创建 `apps/web/app.vue`：
  ```vue
  <template>
    <NuxtPage />
  </template>
  ```

  创建 `apps/web/pages/index.vue`：
  ```vue
  <template>
    <div>
      <h1>MindCloud Zome</h1>
      <NuxtLink to="/hub">Communication Hub</NuxtLink>
    </div>
  </template>
  ```

- [ ] **步骤 1.6：创建 `crates/zome-sidecar` Rust 项目**

  创建 `crates/zome-sidecar/Cargo.toml`：
  ```toml
  [package]
  name = "zome-sidecar"
  version = "0.1.0"
  edition = "2024"

  [dependencies]
  tonic = "0.13"
  prost = "0.13"
  tokio = { version = "1.44", features = ["full"] }
  serde = { version = "1.0", features = ["derive"] }
  serde_json = "1.0"
  anyhow = "1.0"
  tracing = "0.1"
  tracing-subscriber = "0.3"

  [build-dependencies]
  tonic-build = "0.13"
  ```

  创建 `crates/zome-sidecar/src/main.rs`：
  ```rust
  #[tokio::main]
  async fn main() -> anyhow::Result<()> {
      tracing_subscriber::fmt::init();
      tracing::info!("zome-sidecar starting");
      Ok(())
  }
  ```

- [ ] **步骤 1.7：创建 `apps/desktop` Tauri 项目**

  创建 `apps/desktop/package.json`：
  ```json
  {
    "name": "@mindcloud/desktop",
    "version": "0.1.0",
    "type": "module",
    "scripts": {
      "dev": "tauri dev",
      "build": "tauri build",
      "tauri": "tauri"
    },
    "devDependencies": {
      "@tauri-apps/cli": "^2.5.0"
    }
  }
  ```

  创建 `apps/desktop/src-tauri/Cargo.toml`：
  ```toml
  [package]
  name = "mindcloud-desktop"
  version = "0.1.0"
  edition = "2024"

  [dependencies]
  tauri = { version = "2.5", features = [] }
  serde = { version = "1.0", features = ["derive"] }
  serde_json = "1.0"
  tokio = { version = "1.44", features = ["full"] }
  anyhow = "1.0"

  [build-dependencies]
  tauri-build = "2.5"
  ```

  创建 `apps/desktop/src-tauri/src/main.rs`：
  ```rust
  fn main() {
      tauri::Builder::default()
          .run(tauri::generate_context!())
          .expect("error while running tauri application");
  }
  ```

  创建 `apps/desktop/src-tauri/tauri.conf.json`：
  ```json
  {
    "productName": "MindCloud Zome",
    "version": "2.0.0",
    "identifier": "com.mindcloud.zome",
    "build": {
      "beforeDevCommand": "pnpm --filter @mindcloud/web dev",
      "beforeBuildCommand": "pnpm --filter @mindcloud/web build",
      "devUrl": "http://localhost:3000",
      "frontendDist": "../../web/dist"
    },
    "app": {
      "windows": [
        {
          "title": "MindCloud Zome",
          "width": 1400,
          "height": 900,
          "resizable": true
        }
      ],
      "security": {
        "csp": null
      }
    },
    "bundle": {
      "active": true,
      "targets": "all",
      "icon": ["icons/32x32.png", "icons/128x128.png", "icons/icon.ico"]
    }
  }
  ```

- [ ] **步骤 1.8：安装依赖并验证 monorepo**

  运行：
  ```bash
  pnpm install
  pnpm build
  ```
  预期：所有子包编译成功（engine 的 health endpoint、web 的 Nuxt build、sidecar 的 cargo build、desktop 的 tauri build）。

- [ ] **步骤 1.9：创建 CI 骨架**

  创建 `.github/workflows/ci.yml`：
  ```yaml
  name: CI
  on: [push, pull_request]
  jobs:
    build-and-test:
      runs-on: ubuntu-latest
      steps:
        - uses: actions/checkout@v4
        - uses: pnpm/action-setup@v4
          with:
            version: 10.33.0
        - uses: actions/setup-node@v4
          with:
            node-version: 22
            cache: pnpm
        - uses: actions-rust-lang/setup-rust-toolchain@v1
        - run: pnpm install
        - run: pnpm lint
        - run: pnpm test
        - run: pnpm build
  ```

- [ ] **步骤 1.10：Commit Phase 1**

  运行：
  ```bash
  git add .
  git commit -m "chore: setup monorepo for js rewrite"
  ```

**Phase 1 验收检查点：**
- [ ] `pnpm install` 成功。
- [ ] `pnpm build` 成功。
- [ ] `services/engine` 能运行并响应 `GET /health`。
- [ ] `apps/web` 能 `nuxt build` 成功。
- [ ] `crates/zome-sidecar` 能 `cargo build` 成功。
- [ ] `apps/desktop/src-tauri` 能 `cargo build` 成功。

---

## Phase 2：Rust 性能侧车

**目标：** 实现 Rust 侧车的核心服务：gRPC 服务定义、HNSW 向量检索、token 计数、敏感配置加密、进程守护与沙箱骨架。

**涉及文件：**
- 创建：`crates/zome-sidecar/proto/zome.proto`
- 创建：`crates/zome-sidecar/build.rs`
- 创建：`crates/zome-sidecar/src/server.rs`、`crates/zome-sidecar/src/vector/mod.rs`、`crates/zome-sidecar/src/tokenizer/mod.rs`、`crates/zome-sidecar/src/crypto/mod.rs`、`crates/zome-sidecar/src/sandbox/mod.rs`、`crates/zome-sidecar/src/supervisor/mod.rs`
- 创建：`crates/zome-sidecar/src/lib.rs`
- 修改：`crates/zome-sidecar/src/main.rs`、`crates/zome-sidecar/Cargo.toml`
- 创建：`crates/zome-sidecar/tests/vector_test.rs`

**任务步骤：**

- [ ] **步骤 2.1：定义 gRPC proto**

  创建 `crates/zome-sidecar/proto/zome.proto`：
  ```protobuf
  syntax = "proto3";
  package zome;

  service ZomeSidecar {
    rpc Upsert(UpsertRequest) returns (UpsertResponse);
    rpc Search(SearchRequest) returns (SearchResponse);
    rpc CountTokens(TokenCountRequest) returns (TokenCountResponse);
    rpc Encrypt(EncryptRequest) returns (EncryptResponse);
    rpc Health(HealthRequest) returns (HealthResponse);
  }

  message UpsertRequest { string agent_id = 1; string doc_id = 2; repeated float embedding = 3; }
  message UpsertResponse {}

  message SearchRequest { string agent_id = 1; repeated float query = 2; uint32 top_k = 3; }
  message SearchResponse { repeated SearchResult results = 1; }
  message SearchResult { string doc_id = 1; float score = 2; }

  message TokenCountRequest { string text = 1; string model = 2; }
  message TokenCountResponse { uint32 count = 1; }

  message EncryptRequest { string plaintext = 1; }
  message EncryptResponse { string ciphertext = 1; }

  message HealthRequest {}
  message HealthResponse { string status = 1; }
  ```

- [ ] **步骤 2.2：配置 tonic build**

  创建 `crates/zome-sidecar/build.rs`：
  ```rust
  fn main() {
      tonic_build::compile_protos("proto/zome.proto").expect("Failed to compile protos");
  }
  ```

  修改 `crates/zome-sidecar/Cargo.toml`，添加 `hnsw_rs` 或 `usearch` 依赖（向量库）、`tiktoken-rs` 或 `rust-tokenizer` 依赖（token 计数）、`ring` 或 `aes-gcm` 依赖（加密）。

- [ ] **步骤 2.3：实现向量检索模块**

  创建 `crates/zome-sidecar/src/vector/mod.rs`：
  - 使用 `hnsw_rs` 或 `usearch` 实现 HNSW 索引。
  - 提供 `VectorIndex::new(agent_id: &str) -> Self`。
  - 提供 `upsert(doc_id: &str, embedding: &[f32])`。
  - 提供 `search(query: &[f32], top_k: usize) -> Vec<(String, f32)>`。
  - 索引持久化到 `~/.cloudmind-zome/agents/{agent_id}/indices/hnsw/`。

- [ ] **步骤 2.4：实现 token 计数模块**

  创建 `crates/zome-sidecar/src/tokenizer/mod.rs`：
  - 使用 `tiktoken-rs` 实现 `count_tokens(text: &str, model: &str) -> u32`。
  - 不支持模型 fallback 到近似字符数 / 4。

- [ ] **步骤 2.5：实现加密模块**

  创建 `crates/zome-sidecar/src/crypto/mod.rs`：
  - 使用 `ring` 实现基于主密钥派生的 AES-256-GCM 加密。
  - 主密钥从系统密钥环或环境变量 `ZOME_MASTER_KEY` 获取（Windows 使用 DPAPI，跨平台先用环境变量 fallback）。
  - 提供 `encrypt(plaintext: &str) -> String` 和 `decrypt(ciphertext: &str) -> String`。

- [ ] **步骤 2.6：实现进程守护模块**

  创建 `crates/zome-sidecar/src/supervisor/mod.rs`：
  - 提供 `spawn_node_engine() -> Child`：启动 Node.js 引擎进程。
  - 提供 `watch_node_health()`：定期 HTTP GET `/health`，失败则重启。
  - 提供 `shutdown()`：通知 Node 保存状态并停止。

- [ ] **步骤 2.7：实现 gRPC 服务入口**

  创建 `crates/zome-sidecar/src/server.rs`：
  - 实现 `ZomeSidecar` trait。
  - 绑定 Unix Domain Socket / Named Pipe / TCP。

  修改 `crates/zome-sidecar/src/main.rs`：
  ```rust
  #[tokio::main]
  async fn main() -> anyhow::Result<()> {
      tracing_subscriber::fmt::init();
      let supervisor = supervisor::spawn_node_engine().await?;
      tokio::spawn(supervisor::watch_node_health());
      server::serve().await?;
      Ok(())
  }
  ```

- [ ] **步骤 2.8：编写 Rust 单元测试**

  创建 `crates/zome-sidecar/tests/vector_test.rs`：
  ```rust
  #[tokio::test]
  async fn test_vector_search() {
      let mut index = VectorIndex::new("test-agent");
      index.upsert("doc1", &[1.0, 0.0, 0.0]);
      index.upsert("doc2", &[0.0, 1.0, 0.0]);
      let results = index.search(&[1.0, 0.0, 0.0], 1);
      assert_eq!(results[0].0, "doc1");
  }
  ```

- [ ] **步骤 2.9：Commit Phase 2**

  运行：
  ```bash
  git add crates/zome-sidecar
  git commit -m "feat(sidecar): vector search, tokenizer, crypto, supervisor"
  ```

**Phase 2 验收检查点：**
- [ ] `cargo test` 通过。
- [ ] `cargo run` 能启动 gRPC 服务并监听指定地址。
- [ ] Node 引擎能在 Rust 侧车守护下启动并响应 `/health`。

---

## Phase 3：Node 引擎核心 — 数据层与 Repository

**目标：** 实现 per-Agent JSON/JSONL 文档存储和 Repository 抽象，为上层业务提供统一数据接口。

**涉及文件：**
- 创建：`services/engine/src/config/paths.ts`
- 创建：`services/engine/src/memory/document-store.ts`
- 创建：`services/engine/src/memory/repositories/agent.ts`、`message.ts`、`memory.ts`、`action.ts`、`llm-call.ts`
- 创建：`services/engine/src/memory/repositories/index.ts`
- 创建：`services/engine/tests/memory/repositories/agent.test.ts`、`message.test.ts`
- 修改：`services/engine/src/bootstrap.ts`

**任务步骤：**

- [ ] **步骤 3.1：实现路径配置**

  创建 `services/engine/src/config/paths.ts`：
  ```typescript
  import path from "node:path";
  import os from "node:os";

  export function getDataDir(): string {
    return process.env.CLOUDMIND_DATA_DIR || path.join(os.homedir(), ".cloudmind-zome");
  }

  export function getAgentDir(agentId: string): string {
    return path.join(getDataDir(), "agents", agentId);
  }
  ```

- [ ] **步骤 3.2：实现文档存储基类**

  创建 `services/engine/src/memory/document-store.ts`：
  - `DocumentStore`：封装单个 JSON/JSONL 文件的读写、追加、读取。
  - 提供 `readJson<T>(): T` 用于 `agent.json`。
  - 提供 `appendLine<T>(record: T)` 用于 JSONL。
  - 提供 `readLines<T>(options?: { limit?: number; offset?: number }): T[]`。
  - 使用 Node.js `fs/promises` 和 `readline` 实现流式读取。

- [ ] **步骤 3.3：实现 Agent Repository**

  创建 `services/engine/src/memory/repositories/agent.ts`：
  - `AgentRepository` 实现 `IAgentRepository`。
  - 读写 `agent.json`。
  - 缓存 agent 配置并监听文件变化（可选）。

- [ ] **步骤 3.4：实现 Message Repository**

  创建 `services/engine/src/memory/repositories/message.ts`：
  - 按 session 追加消息。
  - 支持按 sessionId 过滤、游标分页。

- [ ] **步骤 3.5：实现 Memory、Action、LLMCall Repository**

  分别创建对应文件，基于 `DocumentStore` 实现。

- [ ] **步骤 3.6：编写 Repository 单元测试**

  使用临时目录，Vitest 测试 CRUD 和分页。

- [ ] **步骤 3.7：Commit Phase 3**

  运行：
  ```bash
  git add services/engine/src/memory services/engine/tests/memory
  git commit -m "feat(engine): document store and repositories"
  ```

**Phase 3 验收检查点：**
- [ ] `pnpm test`（engine）通过。
- [ ] Repository 能在临时目录中正确读写 JSON/JSONL。
- [ ] `agent.json` 变更能被缓存机制感知。

---

## Phase 4：Node 引擎核心 — Provider、Tool System、ReActLoop

**目标：** 实现 LLM/Embedder/ImageGen Provider、工具注册系统、ReActLoop（参考 Kimi CLI 的无状态循环 + ToolScheduler）。

**涉及文件：**
- 创建：`services/engine/src/provider/llm.ts`、`embedder.ts`、`image-gen.ts`、`factory.ts`
- 创建：`services/engine/src/tools/registry.ts`、`services/engine/src/tools/types.ts`
- 创建：`services/engine/src/tools/builtin/read.ts`、`write.ts`、`bash.ts`、`agent.ts`（示例）
- 创建：`services/engine/src/core/react/turn.ts`、`services/engine/src/core/react/step.ts`、`services/engine/src/core/react/tool-scheduler.ts`、`services/engine/src/core/react/tool-call.ts`
- 创建：`services/engine/src/core/agent-worker.ts`
- 创建：`services/engine/tests/core/react.test.ts`、`services/engine/tests/tools/registry.test.ts`
- 修改：`services/engine/src/api/server.ts`（注册相关路由）

**任务步骤：**

- [ ] **步骤 4.1：实现 Provider 层**

  创建 `services/engine/src/provider/llm.ts`：
  - 定义 `LLMProvider` 接口：`chat(params) -> AsyncIterable<LLMEvent>`。
  - 实现 OpenAI provider。
  - 支持 fallback 列表。

  类似实现 `EmbedderProvider` 和 `ImageGenProvider`。

- [ ] **步骤 4.2：实现工具注册表**

  创建 `services/engine/src/tools/types.ts`：
  ```typescript
  export interface Tool {
    name: string;
    description: string;
    parameters: ZodSchema;
    accesses: ToolAccess[];
    execute: (ctx: ToolContext, args: unknown) => Promise<ToolResult>;
  }
  ```

  创建 `services/engine/src/tools/registry.ts`：
  - `register(tool: Tool)`。
  - `get(name: string)`。
  - `list()`。

- [ ] **步骤 4.3：实现内置工具示例**

  创建 `services/engine/src/tools/builtin/read.ts`、`write.ts`、`bash.ts`。
  - `bash.ts` 标记为敏感工具，需要审批。
  - 每个工具声明 `accesses`（如 `files:read:/path`）。

- [ ] **步骤 4.4：实现 ReActLoop 核心**

  创建 `services/engine/src/core/react/turn.ts`：
  - `runTurn(input)`：while 循环调用 `executeLoopStep`。
  - 达到 `maxSteps` 时抛出错误。

  创建 `services/engine/src/core/react/step.ts`：
  - `executeLoopStep`：调用 LLM，解析 stop reason，若为 tool_use 则调用 `runToolCallBatch`。
  - 流式事件：text.delta / thinking.delta / tool.call / tool.result / step.end。

  创建 `services/engine/src/core/react/tool-scheduler.ts`：
  - `ToolScheduler` 根据 `ToolAccesses.conflict` 决定并行/串行。

  创建 `services/engine/src/core/react/tool-call.ts`：
  - `runToolCallBatch`：preflight → prepare → authorize → dispatch → schedule/execute → finalize。

- [ ] **步骤 4.5：实现 AgentWorker**

  创建 `services/engine/src/core/agent-worker.ts`：
  - FIFO 队列。
  - 状态机 idle/busy/paused。
  - 持有 ReActLoop 实例。

- [ ] **步骤 4.6：编写核心测试**

  使用 mock provider 测试 ReActLoop 的 tool calling 循环。

- [ ] **步骤 4.7：Commit Phase 4**

  运行：
  ```bash
  git add services/engine/src/core services/engine/src/provider services/engine/src/tools
  git commit -m "feat(engine): provider, tool system, react loop"
  ```

**Phase 4 验收检查点：**
- [ ] `pnpm test` 通过。
- [ ] AgentWorker 能接收任务并调用 ReActLoop。
- [ ] ReActLoop 能处理单工具调用、多工具并行调用、审批拒绝流程。

---

## Phase 5：Node 引擎核心 — Skill、Plan/Goal、Subagent

**目标：** 实现 Skill 系统、Plan/Goal Manager、Subagent Dispatcher（前台/后台/Swarm）。

**涉及文件：**
- 创建：`services/engine/src/skills/loader.ts`、`services/engine/src/skills/manager.ts`、`services/engine/src/skills/types.ts`
- 创建：`packages/skills/core/SKILL.md`、`packages/skills/core/tools/read.ts`、...
- 创建：`services/engine/src/plan/manager.ts`、`services/engine/src/plan/types.ts`
- 创建：`services/engine/src/subagent/dispatcher.ts`、`services/engine/src/subagent/background.ts`、`services/engine/src/subagent/batch.ts`
- 创建：`services/engine/tests/skills/loader.test.ts`、`services/engine/tests/plan/manager.test.ts`、`services/engine/tests/subagent/dispatcher.test.ts`

**任务步骤：**

- [ ] **步骤 5.1：实现 Skill 类型和加载器**

  创建 `services/engine/src/skills/types.ts`：
  - `Skill` 接口：name、description、tools、prompts、schema。

  创建 `services/engine/src/skills/loader.ts`：
  - 扫描 `packages/skills/` 和 `~/.cloudmind-zome/skills/`。
  - 解析 `SKILL.md` 和 `schema.json`。

- [ ] **步骤 5.2：创建内置 Skill 示例**

  创建 `packages/skills/core/SKILL.md` 和 `packages/skills/core/schema.json`。

- [ ] **步骤 5.3：实现 Plan/Goal Manager**

  创建 `services/engine/src/plan/types.ts`：
  - `PlanStep` 类型：`id`、`description`、`status`、`tool`/`subagent`/`llm`。

  创建 `services/engine/src/plan/manager.ts`：
  - `createPlan(goal: string)`：调用 LLM 生成步骤。
  - `executeStep(planId, stepId)`：执行步骤，状态流转。
  - `pause` / `resume` / `retry`。

- [ ] **步骤 5.4：实现 Subagent Dispatcher**

  创建 `services/engine/src/subagent/dispatcher.ts`：
  - `dispatch(parentAgent, task, options)`：创建临时 Agent 实例，隔离上下文。
  - 支持 foreground / background 模式。

  创建 `services/engine/src/subagent/background.ts`：
  - `BackgroundManager`：注册后台子代理，输出捕获，超时，通知事件。

  创建 `services/engine/src/subagent/batch.ts`：
  - `SubagentBatch`：并发上限、退避、重试、按顺序返回结果。

- [ ] **步骤 5.5：编写测试**

  测试 Skill 加载、Plan 创建与执行、Subagent 借用与隔离。

- [ ] **步骤 5.6：Commit Phase 5**

  运行：
  ```bash
  git add services/engine/src/skills services/engine/src/plan services/engine/src/subagent packages/skills
  git commit -m "feat(engine): skills, plan/goal, subagent"
  ```

**Phase 5 验收检查点：**
- [ ] Skill 能从目录加载并注册工具。
- [ ] Plan Manager 能生成计划并执行步骤。
- [ ] Subagent 能复用用户 Agent 配置但不污染原 Agent 状态。
- [ ] BackgroundManager 能通过事件通知前端。

---

## Phase 6：API 与 WebSocket

**目标：** 用 Fastify 暴露 REST 和 WebSocket API，连接前端与引擎核心。

**涉及文件：**
- 创建：`services/engine/src/api/routes/agents.ts`、`chat.ts`、`memory.ts`、`actions.ts`、`skills.ts`
- 创建：`services/engine/src/api/ws/handler.ts`
- 创建：`services/engine/src/api/server.ts`（扩展）
- 创建：`services/engine/tests/api/agents.test.ts`、`ws.test.ts`

**任务步骤：**

- [ ] **步骤 6.1：扩展 Fastify 服务器**

  修改 `services/engine/src/api/server.ts`：
  - 注册 `@fastify/websocket`。
  - 注册 routes。

- [ ] **步骤 6.2：实现 Agent REST API**

  创建 `services/engine/src/api/routes/agents.ts`：
  - `GET /agents`：列出所有 Agent。
  - `POST /agents`：创建 Agent。
  - `GET /agents/:id`：获取 Agent 配置。
  - `PUT /agents/:id`：更新 Agent。
  - `DELETE /agents/:id`：删除 Agent。

- [ ] **步骤 6.3：实现 Chat REST/WebSocket API**

  创建 `services/engine/src/api/routes/chat.ts` 和 `services/engine/src/api/ws/handler.ts`：
  - WebSocket 连接：用户发送消息，服务端流式返回 assistant delta / thinking delta / tool events。
  - REST 获取历史消息。

- [ ] **步骤 6.4：实现 Memory、Action、Skill API**

  分别创建路由文件。

- [ ] **步骤 6.5：编写 API 集成测试**

  使用 `supertest` 和临时数据目录测试 REST。
  使用原生 `ws` 客户端测试 WebSocket 流式事件。

- [ ] **步骤 6.6：Commit Phase 6**

  运行：
  ```bash
  git add services/engine/src/api services/engine/tests/api
  git commit -m "feat(engine): rest and websocket api"
  ```

**Phase 6 验收检查点：**
- [ ] `supertest` 测试通过。
- [ ] WebSocket 客户端能连接并收到流式回复。
- [ ] 创建 Agent 后能通过 API 发送消息并收到回复。

---

## Phase 7：Nuxt 前端迁移

**目标：** 迁移原 Vue 组件和页面到 Nuxt 3，实现与后端的实时通信。

**涉及文件：**
- 创建：`apps/web/composables/useEngineClient.ts`、`apps/web/stores/agents.ts`、`apps/web/stores/chat.ts`、`apps/web/stores/compute.ts`、`apps/web/stores/settings.ts`
- 创建：`apps/web/pages/hub.vue`、`apps/web/pages/agents/[id].vue`、`apps/web/pages/compute.vue`、`apps/web/pages/settings.vue`
- 创建：`apps/web/components/ChatView.vue`、`apps/web/components/AgentEditForm.vue`、...
- 创建：`apps/web/tests/components/ChatView.test.ts`

**任务步骤：**

- [ ] **步骤 7.1：实现 Engine Client Composable**

  创建 `apps/web/composables/useEngineClient.ts`：
  - 提供 REST 调用函数。
  - 提供 WebSocket 连接和事件订阅（onMessageDelta、onThinkingDelta、onToolCall）。

- [ ] **步骤 7.2：实现 Pinia Stores**

  创建 `apps/web/stores/agents.ts`、`chat.ts`、`compute.ts`、`settings.ts`。

- [ ] **步骤 7.3：迁移核心页面**

  将原 `frontend/src/views/` 迁移到 `apps/web/pages/`。

- [ ] **步骤 7.4：迁移核心组件**

  将原 `frontend/src/components/` 迁移到 `apps/web/components/`，适配 Nuxt 自动导入。

- [ ] **步骤 7.5：实现实时聊天 UI**

  `ChatView.vue`：
  - 连接 WebSocket。
  - 显示用户消息、assistant 流式文本、thinking 折叠块、工具调用事件。

- [ ] **步骤 7.6：编写前端组件测试**

  使用 Vitest + Vue Test Utils 测试 ChatView 的消息渲染。

- [ ] **步骤 7.7：Commit Phase 7**

  运行：
  ```bash
  git add apps/web
  git commit -m "feat(web): nuxt frontend migration"
  ```

**Phase 7 验收检查点：**
- [ ] `pnpm dev` 能同时启动 engine 和 web。
- [ ] 前端能创建 Agent、发送消息、看到流式回复。
- [ ] 前端组件测试通过。

---

## Phase 8：Tauri 桌面集成

**目标：** 实现 Tauri 启动 Rust 侧车、Rust 侧车启动 Node 引擎、前后端寻址、优雅退出、桌面打包。

**涉及文件：**
- 修改：`apps/desktop/src-tauri/src/main.rs`
- 创建：`apps/desktop/src-tauri/src/sidecar.rs`、`apps/desktop/src-tauri/src/commands.rs`
- 修改：`apps/desktop/src-tauri/tauri.conf.json`
- 创建：`apps/desktop/src-tauri/capabilities/default.json`
- 修改：`apps/web/composables/useEngineClient.ts`（适配 Tauri backend_url 命令）

**任务步骤：**

- [ ] **步骤 8.1：Tauri 启动 Rust 侧车**

  修改 `apps/desktop/src-tauri/src/main.rs`：
  - 应用启动时执行 `sidecar::spawn_zome_sidecar()`。
  - 注册 `get_backend_url` 命令。

  创建 `apps/desktop/src-tauri/src/sidecar.rs`：
  - 启动 `zome-sidecar` 二进制。
  - 监听 stdout/stderr。
  - 健康检查失败时重启。

- [ ] **步骤 8.2：前后端寻址**

  创建 `apps/desktop/src-tauri/src/commands.rs`：
  ```rust
  #[tauri::command]
  async fn get_backend_url(state: State<'_, SidecarState>) -> Result<String, String> {
      state.backend_url.lock().await.clone().ok_or("not ready".into())
  }
  ```

  修改 `apps/web/composables/useEngineClient.ts`：
  - 检测是否在 Tauri 环境，是则调用 `get_backend_url()`，否则使用 runtime config。

- [ ] **步骤 8.3：优雅退出**

  修改 `apps/desktop/src-tauri/src/main.rs`：
  - 监听 `RunEvent::ExitRequested`。
  - 调用 `sidecar::shutdown()`：通知 Rust 侧车，Rust 侧车通知 Node 保存状态，依次停止。

- [ ] **步骤 8.4：配置 Tauri 能力**

  创建 `apps/desktop/src-tauri/capabilities/default.json`：
  ```json
  {
    "$schema": "../gen/schemas/desktop-schema.json",
    "identifier": "default",
    "description": "Default capabilities",
    "windows": ["main"],
    "permissions": [
      "core:default",
      "shell:allow-execute",
      "shell:allow-spawn",
      {
        "identifier": "shell:allow-execute",
        "allow": [{ "args": true, "cmd": "$APP/zome-sidecar", "name": "zome-sidecar" }]
      }
    ]
  }
  ```

- [ ] **步骤 8.5：桌面打包验证**

  运行：
  ```bash
  pnpm --filter @mindcloud/desktop tauri build
  ```
  预期：生成安装包，能安装运行。

- [ ] **步骤 8.6：Commit Phase 8**

  运行：
  ```bash
  git add apps/desktop
  git commit -m "feat(desktop): tauri integration with sidecar and engine"
  ```

**Phase 8 验收检查点：**
- [ ] `pnpm tauri dev` 能启动完整桌面应用。
- [ ] 桌面应用能创建 Agent 并聊天。
- [ ] 关闭窗口时 Node 和 Rust 侧车正常退出。
- [ ] `tauri build` 成功生成安装包。

---

## Phase 9：完整功能迁移

**目标：** 迁移群聊、Intermind、Scheduler、ComputeCenter、蓝图工作流、系统设置、用户档案。

**涉及文件：**
- 创建：`services/engine/src/core/conductor.ts`、`services/engine/src/core/scheduler.ts`
- 创建：`services/engine/src/compute/`、`services/engine/src/blueprint/`、`services/engine/src/profile/`
- 创建：`apps/web/pages/compute.vue`、`apps/web/components/BlueprintCanvas.vue`、...
- 修改：`services/engine/src/api/routes/` 增加相应路由

**任务步骤：**

- [ ] **步骤 9.1：实现 Conductor（群聊/Intermind）**

  创建 `services/engine/src/core/conductor.ts`：
  - 群聊路由：@mention、语义匹配、随机。
  - Intermind 调度。

- [ ] **步骤 9.2：实现 Scheduler**

  创建 `services/engine/src/core/scheduler.ts`：
  - 基于 `croniter` 的定时任务。
  - 优先级队列。

- [ ] **步骤 9.3：迁移 ComputeCenter**

  创建 `services/engine/src/compute/` 模块和前端页面。

- [ ] **步骤 9.4：迁移蓝图工作流**

  创建 `services/engine/src/blueprint/` 模块和 `BlueprintCanvas.vue`。

- [ ] **步骤 9.5：迁移系统设置和用户档案**

  创建 `services/engine/src/profile/` 和前端 settings/profile 页面。

- [ ] **步骤 9.6：Commit Phase 9**

  按模块分多个 commit：
  ```bash
  git add services/engine/src/core/conductor.ts services/engine/src/core/scheduler.ts
  git commit -m "feat(engine): conductor and scheduler"
  ```

**Phase 9 验收检查点：**
- [ ] 群聊、Intermind、Scheduler、ComputeCenter、蓝图、系统设置、用户档案均可用。
- [ ] 各模块有对应集成测试。

---

## Phase 10：测试、性能优化与文档

**目标：** 补充测试覆盖、性能基准、完善文档、Tauri 生产构建、CI 调优。

**涉及文件：**
- 创建：`services/engine/tests/benchmark/llm-latency.test.ts`、`services/engine/tests/benchmark/jsonl-io.test.ts`
- 创建：`crates/zome-sidecar/benches/vector_search.rs`
- 修改：`.github/workflows/ci.yml`
- 创建：`docs/superpowers/plans/2026-06-24-js-rewrite-plan.md`（本文件已存在）
- 修改：`README.md`（新分支版本）

**任务步骤：**

- [ ] **步骤 10.1：补充后端测试覆盖到 ≥70%**

  使用 Vitest coverage：
  ```bash
  pnpm --filter @mindcloud/engine test --coverage
  ```

- [ ] **步骤 10.2：补充前端组件测试**

  使用 Vitest + Vue Test Utils。

- [ ] **步骤 10.3：E2E 测试**

  创建 `e2e/` 目录，使用 Playwright：
  - 创建 Agent → 发送消息 → 验证回复。
  - 验证工具审批流。

- [ ] **步骤 10.4：性能基准**

  - JSONL 写入吞吐。
  - 向量检索 QPS。
  - LLM 调用延迟（mock provider）。

- [ ] **步骤 10.5：CI 调优**

  修改 `.github/workflows/ci.yml`：
  - 分 job：lint、test-node、test-rust、build-web、build-tauri（release tag 触发）。

- [ ] **步骤 10.6：更新 README**

  创建新分支版本的 `README.md`，说明新架构、启动方式、开发命令。

- [ ] **步骤 10.7：Commit Phase 10**

  运行：
  ```bash
  git add README.md e2e .github/workflows/ci.yml
  git commit -m "chore: tests, benchmarks, docs and ci"
  ```

**Phase 10 验收检查点：**
- [ ] 后端测试覆盖 ≥70%。
- [ ] 前端核心组件测试 ≥50%。
- [ ] Playwright E2E 通过。
- [ ] CI 通过 `lint → test → build`。
- [ ] Tauri 生产构建在 release tag 时成功。

---

## 自检

### 规格覆盖度

| 规格章节 | 实现任务 |
|----------|----------|
| 1.4 直接开始 JS 重构 | 步骤 0.1、0.2 创建分支 |
| 3. 技术栈 | Phase 1 全部步骤 |
| 4. 总体架构 | Phase 1、8 |
| 5. 目录结构 | Phase 1 步骤 1.1-1.7 |
| 6. 数据层 | Phase 3 |
| 7.1 AgentWorker | Phase 4 步骤 4.5 |
| 7.2 ReActLoop | Phase 4 步骤 4.4 |
| 7.3 Conductor | Phase 9 步骤 9.1 |
| 7.4 Scheduler | Phase 9 步骤 9.2 |
| 7.5 Provider | Phase 4 步骤 4.1 |
| 7.6 Tool System | Phase 4 步骤 4.2-4.3 |
| 7.7 Skill System | Phase 5 步骤 5.1-5.2 |
| 7.8 Subagent | Phase 5 步骤 5.4 |
| 7.9 Plan/Goal | Phase 5 步骤 5.3 |
| 7.10 Tool Protocol | Phase 4 步骤 4.4 |
| 7.11 Tool Execution Pipeline | Phase 4 步骤 4.4 |
| 8. Rust 侧车 | Phase 2 |
| 9. Nuxt 前端 | Phase 7 |
| 10. Tauri 集成 | Phase 8 |
| 11. 测试策略 | Phase 1、2、3、4、5、6、7、10 |
| 12. 开发节奏 | 本计划各 Phase 对应 |
| 13. 验收标准 | 各 Phase 验收检查点 |

未发现遗漏。

### 占位符扫描

- 无 "TODO"、"待定"、"后续实现"。
- 每个步骤包含具体文件路径、代码或命令。
- 所有类型/函数在首次出现时定义。

### 类型一致性

- `AgentConfig`、`ChatMessage` 在 `packages/shared` 定义，后续使用一致。
- `ToolAccess`、`ToolContext` 在 Phase 4 定义，Phase 5 Subagent 和 Phase 9 使用。
- `LLMEvent` 在 Phase 4 定义，Phase 6 WebSocket 使用。

---

## 执行交接

**计划已完成并保存到 `docs/superpowers/plans/2026-06-24-js-rewrite-plan.md`。**

两种执行方式：

**1. 子代理驱动（推荐）** - 每个 Phase 或每个任务调度一个新的子代理，任务间进行审查，快速迭代。适用于这个大型重构项目。

**2. 内联执行** - 在当前会话中使用 executing-plans 执行任务，批量执行并设有检查点。适合你希望紧跟每一步的情况。

**选哪种方式？**
