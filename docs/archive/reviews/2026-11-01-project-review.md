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
| 依赖审计 | `pnpm audit` | ⚠️ 网络 ECONNRESET，未完成（环境限制） |

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
