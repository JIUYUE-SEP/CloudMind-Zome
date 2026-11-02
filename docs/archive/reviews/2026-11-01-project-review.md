# 项目检查报告（2026-11-01）

> 范围：`services/engine`（194 文件）、`apps/web`（37 组件 / 17 页）、`crates/zome-sidecar`（4 文件）、`scripts`、CI 配置。
> 方法：真实运行基线（vitest ×2 / tsc ×2 / eslint ×2 / Playwright）+ 静态扫描（危险 API、硬编码密钥、浮空 promise、定时器、文件规模、测试平台假设）+ 上次审计（2026-08-19）16 项 Medium 修复抽查（F1/F5/F6/F7/F8 全部复核已修）。
> 结论：**代码质量在线，安全面扎实；问题集中在「验证链本身不可信」——4 个测试永久失败、8 个 e2e 跑不起来、CI 只覆盖 Linux，而开发机是 Windows。**
>
> **修复状态（同日执行完毕）**：H-1（测试平台口径 + taskkill 分支可测化）、H-2（e2e 包管理器解析 + 启动期快速失败）、H-3（CI 加 windows-test job）、L-1（web `no-console` 清零）已修并复跑验证；M-1（全局 unhandledRejection 兜底）与 L-2（`/tmp` 测试夹具）按需保留。下方正文保留审查当时的证据原貌。

---

## 一、验证基线（本次真实运行）

| 项 | 命令 | 结果 |
|---|---|---|
| engine 测试 | `pnpm --filter @cloudmind/engine test` | ⚠️ **1797 过 / 4 失败**（1801 例、187 文件、183s） |
| web 测试 | `pnpm --filter @cloudmind/web test` | ✅ 309/309（40 文件、9.5s） |
| typecheck | engine `tsc --noEmit` / web `nuxt typecheck` | ✅ 两侧通过 |
| lint | engine `eslint src tests` / web | ⚠️ engine 0 问题；web **4 warning**（`no-console`） |
| e2e | `npx playwright test` | ❌ **web 起不来，0/8 执行** |
| 依赖审计 | `pnpm audit` | ⚠️ 网络 ECONNRESET，未完成（**2026-11-02 换镜像源后用 OSV 完成，见 §六**） |

> 本表是 2026-11-01 的快照。engine 4 例失败、e2e 起不来、依赖审计三项均已于当日/次日修复，末尾「修复台账」章节逐项销记；§六 另有一段末尾补充。

**4 个失败全部集中在 `tests/sidecar/autostart.test.ts`**，且与本次改动无关（既有问题，从 watchdog P1 起每轮都出现）。

---

## 二、问题清单

### 🔴 H-1｜sidecar 自启的三块核心逻辑在 Windows 上等于没有测试

**不是"环境问题"，是测试写错了平台假设。**

| 证据 | 内容 |
|---|---|
| `tests/sidecar/autostart.test.ts:77` | `const base = { ..., repoDir: "/repo" }` |
| `tests/sidecar/autostart.test.ts:87` | `const release = "/repo/crates/zome-sidecar/target/release/zome-sidecar"`（正斜杠、无 `.exe`） |
| `src/sidecar/autostart.ts:44-46` | `winExe()` 在 win32 追加 `.exe` |
| `src/sidecar/autostart.ts:76` | `path.join(...)` 在 win32 产出 `\repo\crates\...\zome-sidecar.exe` |

测试用 `Set.has(path)` 做存在性判定，而实现产出的路径在 Windows 上是 `\repo\...\zome-sidecar.exe` —— **永远不命中**，于是：

- `resolveSidecarBin` 返回 `undefined` → 用例 1（发现序）失败
- `startSidecarIfEnabled` 提前 warn 降级、不 spawn → 用例 2 失败（`spawnCalls` 为空）
- `stopSidecar` 无 child 可停 → 用例 3、4 失败（`killCalls` 为空）

**后果**：发现序五档、env 三键注入、两段式关停（SIGTERM → 5s → SIGKILL）这三块逻辑在 Windows 上从未被真实执行过。它们的功能测试全红 = 等价于零覆盖。

**修法**：测试里用 `path.join` + `process.platform === "win32" ? ".exe" : ""` 构造期望路径（照 `winExe` 的口径）。一行 `const bin = (n) => process.platform === "win32" ? `${n}.exe` : n` 即可。

### 🟠 H-2｜e2e 在本机完全跑不起来，且报错不指向真因

| 证据 | 内容 |
|---|---|
| `scripts/start-e2e.mjs:28` | `spawn("pnpm", ["--filter", "@cloudmind/web", "dev"], ...)` |
| `package.json` | `"packageManager": "pnpm@10.33.0"`（声明用 corepack 固定版本） |
| 实测输出 | `[web-err] 'pnpm' 不是内部或外部命令`；`[engine] Engine listening on 127.0.0.1:8848` ✅ |

corepack 环境下 `pnpm` 不在 PATH（须 `corepack pnpm`），脚本硬编码 `spawn("pnpm")` → web 进程从未启动 → 60s 后抛 `http://localhost:3000 did not become ready`。

**两个问题叠加**：
1. 脚本假设 `pnpm` 在 PATH，与仓库自己的 `packageManager` 声明不自洽；
2. spawn 失败的错误只进 `[web-err]` 日志（被 `tail` 淹没），最终报错是"URL 没就绪"——读者要翻十几行才知道真因。`web.on("exit")` 也未被监听，失败只能靠超时暴露（60s 白等）。

**修法**：`const pm = process.env.npm_execpath ? process.execPath : "corepack"`，用 `[pm, ...(process.env.npm_execpath ? [process.env.npm_execpath] : []), "pnpm", ...]` 形式；或直接 `spawn("corepack", ["pnpm", ...])`。同时监听 `web.on("exit", code => code && fail())` 立即失败。

### 🟡 H-3｜CI 只有 ubuntu，与开发机的 Windows 差异无任何兜底

`\.github/workflows/ci.yml:5` → `runs-on: ubuntu-latest`，单 job 单平台。

H-1 和 H-2 都是同一根因的表现：路径分隔符、`.exe`、`SIGTERM` 语义、`pnpm` 的 `.cmd` shim —— 这些在 Linux 全绿、在 Windows 全红，而 CI 只跑 Linux，所以**永久不会被发现**。

不要求加 Windows runner（成本高），但建议：
- 至少加一条 `matrix: os: [ubuntu-latest, windows-latest]` 只跑 `pnpm test`（跳过 cargo/sidecar 重活），把平台差异挡在合并前；
- 或者退一步：在 `docs/开发指南.md` 明确「Windows 上已知 4 例 sidecar 测试红」，让"红"成为已知态而不是噪音——否则真正的回归会淹没在常年 4 红里。

### 🟡 M-1｜无全局 `unhandledRejection` 兜底（设计取舍，但代价偏高）

全引擎无 `process.on("unhandledRejection")` / `("uncaughtException")`（`shutdown.ts` 只处理 SIGTERM/SIGINT）。上次审计的 H-1（REST resume 浮空 promise）是逐点补的 catch（`api/routes/subagents.ts:98`），本次复查该点已修。

`core/agent-worker.ts:1359` 的注释自己写着「否则队列续跑异常升级为 unhandledRejection 掉进程」——说明作者清楚风险并逐点防范。

**判断**：这是 fail-fast 的有意取舍，不是缺陷。但对**本地长驻服务**而言，一次漏网 = 用户会话中断 + 需手动重启，代价高于收益。建议加一条兜底：`unhandledRejection` 记 error 不退出（保留现场），`uncaughtException` 记 fatal 后走优雅关停退出。两者都写审计日志，便于事后定位。

本次静态扫描的 `void` 调用点（`agent-worker.ts:804`、`handoff/resume-loop.ts:143`、`connection-bridge.ts:116,175`）逐个看过，均在被调方内部 try/catch 或有 `.catch`，**当前无新增泄漏**。

### 🔵 L-1｜web 4 处 `no-console` warning

`composables/useGroupChatStream.ts:165,172`、`stores/chat.ts:175,195` —— 全是"丢弃非 string 的 delta 帧"的协议异常防御日志，内容合理。

问题只是噪音：`pnpm lint` 永远带 4 条 warning，"0 warning"不再是一个可达状态。建议加 `// eslint-disable-next-line no-console -- 协议异常防御` 或换统一 logger。

### 🔵 L-2｜51 处测试夹具用 POSIX 字面量 `workspaceDir: "/tmp"`

`tests/core/react.test.ts`（20+ 处）、`tests/context/integration.test.ts`、`tests/api/ws.test.ts` 等。绝大多数只当字符串用、不做真实 IO，在 Windows 上被解析成 `F:\tmp` 也不影响断言 —— **无害**。

但与 H-1 同源：一旦某个测试开始对这些路径做 `exists()` / `realpath()`，就会重演 H-1。建议统一改 `os.tmpdir()`，成本低、断根。

---

## 三、做得好的部分（对照检查项）

| 维度 | 结论 |
|---|---|
| **命令执行** | `bash` 工具白名单 6 条命令 + 元字符全拒 + 含 `/` 一律拒（防 `./script.sh` 绕过）+ `..`/反斜杠/绝对路径全拒，注释写明每条的动机（`tools/builtin/bash.ts:8-37`） |
| **SSRF** | `baseUrl` 校验含 IPv4/IPv6 归一化、`::ffff:` hex 段解析、DNS 全 A/AAAA 记录逐条判定（`api/routes/compute.ts:208-302`） |
| **路径穿越** | 大小写归一（Windows）、`realpath` 容错版（不存在时向上找已存在祖先）、**Windows 设备保留名** CON/PRN/AUX/NUL/COM1-9/LPT1-9 显式拒绝（`tools/project-paths.ts:8-40`） |
| **XSS** | 全仓 0 处 `v-html` / `innerHTML` / `eval` / `new Function` |
| **密钥** | 0 处硬编码密钥；API Key AES-256-GCM + `enc:` 前缀 + 返回脱敏 `***` |
| **类型严格度** | 全仓仅 1 处 `eslint-disable`（`sidecar/client.ts:107`，动态包定义，合理）；0 处 `@ts-ignore`（`.nuxt` 生成文件除外） |
| **技术债标记** | 0 处 TODO / FIXME / XXX / HACK |
| **文件规模** | 仅 3 个 >700 行：`agent-worker.ts` 1366（核心，合理）、`useEngineClient.ts` 820、`agent-run-batch.ts` 710；前端最大 692 |
| **前端资源** | `addEventListener` 11 : `removeEventListener` 19，25 处 `onUnmounted` —— 清理到位，无泄漏迹象 |
| **WS 重连** | 单点收敛到 `utils/managed-ws`（建连/退避/4401 重建），重连后拉最新消息对账，非静默重试（`stores/chat.ts:100-164`） |
| **存储并发** | `DocumentStore` 全部写操作经 `enqueueWrite` 串行（`plugins/memory/document-store.ts:59`），tmp+rename 原子写 |
| **版本迁移** | `MigrationChain` 逐级迁移、高版本显式抛错（`versioning.ts:61-73`） |
| **上次审计回归** | F1（maxContextTokens 校验）、F5（scheduler onDone）、F6（plans 缓存逐出）、F7（蓝图环检测）、F8（anthropic usage 守卫）**全部已修且带测试** |
| **仓库卫生** | 最大文件 pnpm-lock.yaml，源码最大 68KB；`.gitignore` 完整（含 `undefined/` 这类踩过坑的条目） |

---

## 四、建议处理顺序

1. **H-1**（测试平台假设）—— 半天内可修，且修完 Windows 上立刻全绿，恢复"全绿=可信"的信号价值。
2. **H-2**（e2e 启动脚本）—— 一行级 + exit 监听，修完 8 个 e2e 才能真正守护。
3. **H-3**（CI 平台矩阵）—— 结构性，成本较高；至少先做"文档登记已知红"这一步。
4. **M-1 / L-1 / L-2** —— 有空再说，不影响正确性。

> 本报告只读检查，未修改任何代码。

---

# 续查（2026-11-02）：CI 与依赖安全

第一轮只看了本地验证链，漏了远端。一轮 CI 日志查询翻出两个更大的问题。

## 五、CI 已连续 5 次失败，没人看

`gh run list` 显示最近 5 次 push（含本轮的文档与修复提交）**全部 failure**，最早可追溯到 2026-10-20 之后。失败点单一：

| commit | 耗时 | 失败步骤 |
|---|---|---|
| 41276259955（docs 检查报告） | 7m57s | `Cargo audit (zome-sidecar)` |
| 41269726728 / 41265520519 / 41262643341 / 41260882745 | 5-7m | 同上 |

其余步骤（Lint / Typecheck / 1801 例测试 / Build / cargo fmt+clippy+test+release）**全绿**——所以这不是代码坏了，是依赖库在 10 月公布了新公告，而 `cargo audit` 的失败被当成了"反正一直红"。

这与第一轮 H-1 是同一个病：**红点长期存在 → 信号价值归零 → 真回归也会被一起忽略**。

### 修复

| 项 | 修复前 | 修复后 | 依据 |
|---|---|---|---|
| rustls | 0.23.41 | **0.23.46** | RUSTSEC-2026-0285 / 0346 / 0348 / 0349 共同修复线 |
| rustls-webpki | 0.103.13 | **0.103.16** | RUSTSEC-2026-0382（证书校验接受不可信中间证书） |
| tokio | 1.52.3 | **1.53.3** | RUSTSEC-2026-0386（AsyncFd I/O safety，unsound） |

本机无 Rust 工具链与 MSVC，无法 `cargo update`，改为直接改 `Cargo.lock`。升级前逐项核对 crates.io 元数据：三个新版本的依赖集合与版本约束同现有 lock 完全一致（rustls 仍需 once_cell/rustls-pki-types/rustls-webpki/subtle/zeroize；tokio 仍需 bytes/libc/mio/parking_lot/pin-project-lite/signal-hook-registry/socket2 0.6/tokio-macros ~2.7/windows-sys 0.61），故只需替换 version + checksum，不增删 package 条目。

`bincode 1.3.3` 的 RUSTSEC-2025-0141 是 unmaintained 声明（无 CVE、无修复版本），来自 `hnsw_rs` 传递依赖，新增 `crates/zome-sidecar/.cargo/audit.toml` 显式 ignore 并写明来源/影响面/复查条件。

**验证**：CI run 41410587220 的 `build-and-test` **全绿**（cargo fmt / clippy -D warnings / test / release build / audit 全过）。全量依赖树经 OSV batch 复扫 270 个 registry 包：vulnerability 归零。

### 顺带发现：Rust 编译缓存从未生效

`setup-rust-toolchain@v1` 的输入名写成了 `workspaces`，而有效名是 `cache-workspaces`——日志里一直有 `Unexpected input(s) 'workspaces'` 警告，但没人看。意味着 F15 声称的"显式登记缓存工作区"**从未生效**，CI 每次都冷编 sidecar（这也是 build-and-test 要 7-8 分钟的原因之一）。已改。

## 六、npm 依赖：62 个公告（2026-11-02 已根治）

用 OSV batch 扫 `pnpm-lock.yaml` 的 687 个唯一包：

| 严重度 | 数量 |
|---|---|
| CRITICAL | 4 |
| HIGH | 36 |
| MODERATE | 38 |
| LOW | 5 |

**关键 4 个 CRITICAL**：

| 包 | 当前 | 修复线 | 来源 |
|---|---|---|---|
| `proxy-addr` | 2.0.7 | **2.0.8** | fastify 传递依赖 |
| `simple-git` | 3.36.0 | 4.0.1 | devDependency 链 |
| `@simple-git/argv-parser` | 1.1.1 | 2.0.1 | 同上 |
| `@nuxt/devtools` | 3.2.4 | 3.3.1 | 仅 dev 环境 |

**HIGH 里影响运行时的主干**：`fastify` 5.8.5 → 5.12.2（4 条）、`nuxt` 3.21.8 → 3.21.10（4 条）、`@modelcontextprotocol/sdk` 1.30.0 → 1.32.0（6 条，MCP 客户端）、`js-yaml` 4.3.0 → 4.3.2、`@grpc/grpc-js` 1.14.4 → 1.14.5、`vite` 6.4.3/7.3.5 → 6.4.4/7.3.7、`body-parser` 2.3.0 → 2.4.0。

**根 package.json 的 `pnpm.overrides` 本身就是漏洞源**——它钉的下限已经低于新修复线：

```
brace-expansion  ^5.0.9  → 需 ^5.0.11（另有 @^1 需 ^1.1.20、@^2 需 ^2.1.6）
js-yaml          ^4.3.0  → 需 ^4.3.2
svgo             ^4.0.2  → 需 ^4.1.0
```

**当时为什么没修**：本机 `registry.npmjs.org` 不可达（`curl` 无响应，`pnpm audit` / `pnpm view` 全部 ECONNRESET），无法下载新版本、无法重算 lock。只改 `package.json` 会让 CI 的 `pnpm install`（CI 环境下默认 frozen-lockfile）直接失败。

### 修复结果（2026-11-02）

`registry.npmjs.org` 仍不通，改用 `registry.npmmirror.com`（lockfile v9 只存 `integrity` 不存 tarball URL，换源不影响完整性校验）。复扫口径用 OSV batch（`pnpm audit` 在镜像上没有 `/-/npm/v1/security/audits` 端点）。

| | 修前 | 修后 |
|---|---|---|
| CRITICAL | 4 | **0** |
| HIGH | 36 | **0** |
| MODERATE | 38 | 12 |
| LOW | 5 | 0 |
| 命中包数 | 34 | 11 |

两路并治：直接依赖抬到同分支修复线（fastify / js-yaml / @grpc/grpc-js / @modelcontextprotocol/sdk / nuxt / vue / happy-dom），传递依赖走根 `pnpm.overrides`（proxy-addr / body-parser / qs / browserslist / launch-editor / postcss-selector-parser / @hono/node-server / vite / simple-git / brace-expansion 三档 / js-yaml / svgo）。

值得单说的两点：

- **报告里写的「fastify → 5.12.2」不够**。按 OSV 的 range 逐条核对后，`GHSA-4mh8-r7rc-xpvc`（未处理错误导致 DoS）只在 **5.12.5** 修，5.12.2 仍在其影响区间内。同类偏差还有 `brace-expansion` 5.0.9 → 实际需 **5.0.12**（不是 5.0.11）、`qs` 6.15.2 → 需 **6.16.1**（6.16.0 不够）。原因是公告持续新增，且「最小修复版本」必须按**当前大版本分支**取，跨分支的 fixed 值会误导。
- **`@nuxt/devtools` 的 CRITICAL 不用单独升**：`nuxt@3.21.10` 的依赖声明就是 `@nuxt/devtools: ^3.3.1`，升 nuxt 一并解决。而 `simple-git` 在 devtools 3.3.1 里仍钉 `^3.36.0`（CRITICAL 修复线是 4.0.1），只能靠 override 跨大版本——devtools 仅用它读 git 信息，风险可控。

**剩余 12 条 MODERATE 均为跨大版本修复**，且全部落在构建/开发期依赖：`nuxt` 系 3 条需 4.6.x、`vitest` + `@vitest/mocker` 需 4.1.x、`glob` 需 14.0.2、`minimatch`（3/5/9/10 四个分支）需 11.0.1。框架迁移不在安全修复范围内，已记入路线图。

**顺带补了闸门**：CI `build-and-test` 增 `pnpm audit --audit-level=high`（此前只有 Rust 侧有 `cargo audit`）。闸门定在 high 而非 moderate——后者当前修不掉，定 moderate 等于再造一个长期红灯。无修复版本的例外走 `pnpm.auditConfig.ignoreGhsas`，口径对齐 `crates/zome-sidecar/.cargo/audit.toml`。

### 第二轮：OSV 漏报，`pnpm audit` 才是准绳

闸门加完首跑就红了：**`pnpm audit` 报 3 CRITICAL / 20 HIGH，而 OSV 扫描报 0**。

差集正好是 6 个包，OSV 一条都没报：

| 包 | 当时 | 修复线 | 来源 |
|---|---|---|---|
| `tinypool` | 1.1.1 | **2.1.2**（2 条 CRITICAL：原型污染 gadget → RCE） | vitest 工作线程池 |
| `shell-quote` | 1.10.0 | **1.11.0**（CRITICAL：`quote()` 命令注入） | launch-editor |
| `undici` | 7.28.0 | **7.30.1**（5 条 high：TLS 校验绕过 / 缓存投毒 / DoS） | jsdom |
| `node-forge` | 1.4.0 | **1.4.1**（5 条 high：X.509 绕过 / PKCS#12 MAC 伪造 / ReDoS） | listhen（nuxt dev server） |
| `fast-uri` | 3.1.5 | **3.1.7**（4 条 high：host confusion / SSRF / authority 注入） | ajv / fast-json-stringify（**运行时**） |
| `source-map-js` | 1.2.1 | 1.2.2（high：事件循环 DoS） | vue 编译器 |

**原因**：OSV.dev 对 GHSA 的同步有延迟，这批公告刚发布时 OSV 还没收录；`pnpm audit` 直连 registry 的 `/-/npm/v1/security/advisories/bulk`，同源 GitHub Advisory DB 但实时得多。

**教训**：**OSV 扫描不能当唯一判据**。它在「本机连不上 registry」时是唯一可行手段（本轮一开始正是这种情况），但一旦能跑 `pnpm audit`，就以 audit 为准——两者不是等价信息源，而是「离线兜底」与「权威口径」的关系。这次恰好是「先按 OSV 修完 → 加闸门 → 闸门立刻证明 OSV 漏了 23 条」，链条完整地自证了这一点。

顺带一个反直觉发现：`node-forge` 的 `GHSA-86w9-cpqp-85rv` 在 GitHub 上标 `first_patched_version: null`（看起来「无修复」），但它的影响区间是 `<= 1.4.0`——升到 1.4.1/1.4.2 就已不在区间内。**「无修复」字段可能是元数据缺口，最终判据仍是影响区间**，别看到 null 就直接加豁免。

处置后只剩 1 条 high，走豁免：

- `GHSA-mrhx-c7xc-m3w5`（zod）：影响区间 `zod < 4.6.6`，3.x 全线无修复线。升 zod 4 是破坏性变更——`zod-to-json-schema@3` 与 `openai@4` 的 peer 都钉在 zod 3，engine 全部工具 schema 都建在其上。影响面是「校验超大输入时内存耗尽」，本地单用户场景风险可控。已写入 `pnpm.auditConfig.ignoreGhsas` 并记入路线图待迁移。

### 升级带出的一个真回归（已修）

`vite` 6.4.3 → 6.4.5 后，`tests/plugins/` 下 4 个 external 系文件 20 例整片失败，报 `Cannot find module '...Temp/.../index.mjs'`。

根因不是依赖坏了，而是 **vite 6.4.4 的 `server.fs` 安全修复收紧了 SSR 动态 import**：外部插件夹具写在 `os.tmpdir()` 下，测试里 loader 的 `import()` 经 vite 模块运行器解析，工作区外路径被默认 `allow` 拒掉。生产是原生 ESM 解析、不受影响，所以这是「测试环境口径」问题。

定位方式：先怀疑依赖，用 `git stash` 把四个 package.json + lock 回退到改动前再跑同一文件——旧依赖全绿、新依赖全红，坐实是升级引入；再在 vitest 内探针确认「工作区内路径 OK / 同盘符但工作区外也失败」，排除盘符因素。修法是 `services/engine/vitest.config.ts` 显式 `server.fs.allow: [workspaceRoot, os.tmpdir()]`。

> 结论：这类「安全补丁改了行为、测试恰好踩在旧行为上」的回归，只有全量跑测试才会露头——`pnpm audit` 与 `pnpm test` 必须一起跑。

## 七、windows-test 首次运行即发现 2 例超时

第一轮新增的 `windows-test` job 首次跑是 success，第二次红了——`tests/core/react.test.ts` 两例 5 秒超时：

- `G3 估算含工具定义`：真实 tiktoken 反复计数 20000 字符工具定义 + 15000 字符工具输出
- `保险丝：缺省 100 步撞顶`：刻意跑满 100 步，每步一次真实计数 + 上下文组装

两例本地 1.5-2s，windows-latest runner 慢 2-3 倍即踩线。修法：两例签名自标 30s（语义不可缩——100 步正是被验证的缺省值），`vitest.config.ts` 全局 `testTimeout` 5s → 10s 给其余用例留缓冲。

这恰好证明 windows-test 的价值：**它第二次运行就抓到了 Linux CI 永远看不到的问题**。

