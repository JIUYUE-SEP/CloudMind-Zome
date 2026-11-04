# 全量检查与修复（2026-11-04）

> 范围：整仓（`services/engine`、`apps/web`、`packages/shared`、`crates/zome-sidecar`、`docs`、CI 配置）。
> 方法：静态闸门全跑（lint / typecheck / vitest / build / playwright）+ 依赖审计 + 逐模块代码审读（core / provider / tools / memory / handoff / scheduler / api / web），按「静默失效、安全边界、数据一致性」三条线找实质缺陷，每条修复都配回归用例。
> 结论：**基线全绿**（189 个测试文件 / 1821 用例、8 条 E2E、lint/typecheck/build 零告警），审读发现 **8 个实质缺陷（2 高 / 3 中 / 3 低）**，全部已修并补测；另有 2 项环境/政策类发现登记在第四节。

---

## 一、基线（修复前）

| 检查 | 结果 |
|------|------|
| `pnpm lint` | ✅ 3 包全绿 |
| `pnpm typecheck` | ✅ 4 任务全绿 |
| `pnpm test` | ✅ 187 文件 / 1800 用例（1 skipped） |
| `pnpm build` | ✅ 3 包产物正常（web 2.74 MB / 675 kB gzip） |
| `npx playwright test` | ✅ 8/8 |
| `pnpm audit --audit-level=high` | ✅ 通过（high 1 项走 `auditConfig.ignoreGhsas`，moderate 23 / low 3 按 CI 政策放行） |
| `cargo fmt --check` / `clippy` / `test` | ⚠️ 未执行——本机无 Rust 工具链（见 §4） |

静态闸门干净说明问题不在编译面，而在**语义面**：配置字段有 UI 无消费方、第三方 SDK 回调被覆盖、边界判定用错前缀长度。以下每条都给出可复现证据。

---

## 二、缺陷与修复

### H-1（高）`AgentConfig.persona` 从未进入 prompt——编辑器「人设」页静默失效

- 证据：L1 组装只读 SOUL.md（`core/agent-worker.ts:900` `loadSoul`）；全仓 `persona` 仅出现在 routes 白名单、web 表单与 shared 类型，引擎侧**零消费**（`grep -rn "config.persona" services/engine/src` 为空）。UI 上「人设」是独立标签页（`components/agent-edit/AgentEditPersona.vue`），用户写下的文字对行为没有任何影响。
- 修复：新增 `mind/mind-files.ts#composePersonaLayer`（经 `ctx.mind` 上架，避免重引 core→mind 值边），worker 用它合成 L1 人格层，装配层传 `persona`。合成规则：
  - SOUL.md 仍是默认模板（从未自定义）→ persona **取代**模板（避免「新诞生的数字心智」与自定人设互相打架）；
  - SOUL.md 已自定义 → persona 作为「# 人设补充」段追加；
  - persona 空/纯空白 → L1 与旧行为**逐字节一致**（缓存前缀不破）。
- 用例：`tests/mind/mind-files.test.ts`（4 例合成规则）+ `tests/core/agent-worker.test.ts`（L1 断言含 persona、默认模板不并列）；既有 12 处 L1 字节级断言全部未动且仍绿。
- 文档：`docs/架构文档.md` L1 行 + 新增「L1 人格层合成」段；`docs/API.md` 补 `persona` 语义。

### H-2（高）MCP 断线处理覆盖了 SDK 的 `onclose`——在途调用不立即失败、自愈重连不触发

- 证据：`tools/mcp/client-manager.ts` 在 `client.connect(transport)` 之后直接 `transport.onclose = …`。SDK 在 `Protocol.connect()` 里把「旧 onclose + 自己的 `_onclose`」组合挂上（`@modelcontextprotocol/sdk/dist/esm/shared/protocol.js:224-228`），`_onclose` 负责把在途请求以 `ConnectionClosed` 拒掉、清空响应表/超时表。覆盖后：server 崩溃 → 在途 `callTool` 只能等到调用超时（`RequestTimeout`，属 `McpError`），而 wrapper 把「服务器已应答」判为不可恢复（`wrapper.ts:118`）→ 自愈重连永不触发。
- 复现（修复前）：InMemoryTransport 桩 server 挂起不返回 → 触发 `onclose` → 2s 内 promise 既不 resolve 也不 reject（60s 后超时）。
- 修复：新增 `chainOnClose(prev, next)` 组合器（先跑既有链、旧链抛错不阻断本层记账），接线改为 `chainOnClose(transport.onclose, …)`。
- 用例：`tests/tools/mcp/onclose-chain.test.ts`（4 例，含真实 Client + InMemoryTransport 断连后 `ConnectionClosed` 立即拒绝的集成断言）。

### M-1（中）`PUT /agents/:id` 把两个合法字段判成未知字段 → 400

- 证据：`api/routes/agents.ts:12-23` 的 `KNOWN_AGENT_FIELDS` 缺 `topicBoundaryModel` / `twoPassCompression`，而 `packages/shared/src/index.ts:32,34` 有定义、`plugins/agents/index.ts:262-268` 在用、`docs/API.md:46,54` 也早就把它们列为合法配置项。后果：前端编辑器整表回传（`AgentEditor.vue` `{...src}`）时保存直接 400；REST 也无从配置这两个开关。
- 修复：白名单补齐两字段 + `FIELD_HINTS` 补 snake_case 提示。
- 用例：`tests/api/agents.test.ts`「PUT 接受 topicBoundaryModel / twoPassCompression 并原样回显」（含 GET→PUT 回传路径）。

### M-2（中）`embedderModelId` 硬编码——嵌入型号配置无效

- 证据：`provider/embedder.ts` 请求体写死 `model: "text-embedding-3-small"`；`plugins/llm/index.ts#createEmbedder` 只传 apiKey/baseUrl，`AgentConfig.embedderModelId` 在引擎侧无消费方（只有 web 表单在用）。
- 修复：`OpenAIEmbedderProvider` 增加 model 参数（缺省 `DEFAULT_EMBEDDING_MODEL`，保持旧行为），工厂传 `agentConfig.embedderModelId`。
- 用例：`tests/provider/embedder.test.ts`（3 例：传参生效 / 缺省回落 / 常量口径）。

### M-3（中）SSRF 判定：IPv6 link-local 只判 `fe80:` 前缀，`fe81::`–`febf::` 全段漏网

- 证据：`api/routes/compute.ts#isPrivateIp` 旧实现 `normalized.startsWith("fe80:")`。link-local 是 **fe80::/10**（fe80–febf），`http://[fe90::1]/` 这类 baseUrl 会被判为公网放行，可直连链路上任意主机；同函数对未压缩写法 `0:0:0:0:0:0:0:1` 也漏判（只认 `::1`）。
- 修复：改用 `expandIpv6` 展开成 8 个 16 位分组后按位掩码判：`fe80::/10`、`fec0::/10`、`fc00::/7`、`ff00::/8`、IPv4-mapped/compatible、NAT64 `64:ff9b::/96`；解析失败 fail-closed。顺带补齐 IPv4 侧的 192.0.0/24、198.18/15、≥224（组播/保留）。
- 用例：`tests/api/compute.test.ts` 新增 7 条（fe80/fe90/febf/fec0/fd12/ff02/未压缩 loopback），既有 mapped/compatible 矩阵与「公网 mapped 不误伤」全部仍绿。

### L-1（低）群聊历史读失败时把空历史塞进 job

- 证据：`api/ws/session-handler.ts` `messages: history`；私聊有 `history.length > 0 ? history : [userMessage]` 兜底，群聊没有。读失败或该 agent 的 append 失败时，本轮 job 一条用户消息都没有。
- 修复：与私聊同口径兜底。
- 用例：`tests/api/ws-session.test.ts` 既有「历史读失败降级为空」用例补断言（job 至少带本条用户消息）。

### L-2（低）`POST /agents` 先落盘再校验 mind，500 时留下半成品

- 证据：`api/routes/agents.ts` 原顺序 save → `if (!context.mind) 500` → `ensureMindFiles`。装配异常时留下「配置在、人格文件没生成」的 agent。
- 修复：校验前移到 save 之前。

### L-3（低）压缩归档失败用例确定性抖动

- 证据：`tests/core/agent-worker.test.ts`「归档失败时隔离压缩档」用 `vi.waitFor(warn)` 等全局 logger 告警，而 `CompressionQueue` 缺省重试链是 5s/15s/45s——全量并行时会被其他用例的残留告警提前唤醒，断言抢在压缩档回滚之前执行。本轮全量跑确实红了这一次（单跑/整文件跑均绿）。
- 修复：`AgentWorkerConfig` 增 `compressionQueueOptions`（测试注入，缺省生产值），用例注入 `retryDelaysMs: []` 后 `await worker.drainCompression()` 再断言，并断言告警文案（重试耗尽口径）。

---

## 三、诚实性修正（不是缺陷，但会让用户误判）

- **记忆参数四项（`settings.memory.*`）**：`compactThreshold` / `keepRecent` / `hotMemoryLimit` / `warmMemoryLimit` 属早期阈值压缩管线，当前版本由话题压缩接管，引擎侧**无消费方**，但设置页仍给可编辑输入框。处置：`pages/settings.vue` 与 `SystemSettingsPanel.vue` 改为废弃说明（指向 Agent 级话题压缩参数），config 字段保留（老 config.json 仍可读，不破坏兼容）；`docs/架构文档.md` §6.1 同步标注。
- **`pnpm build` → `pnpm dev`/E2E 的缓存坑**：build 重写 `.nuxt` 后 Vite 预打包缓存仍是旧的，dev 报 `Failed to resolve import "#app-manifest"`；本轮还叠加了 nitro `prepareDir` 清理 `apps/web/dist` 失败。处置已写入 `docs/开发指南.md` §6.1（删 `.vite` / `.nuxt` / `dist` 三个生成物）。

---

## 四、未修 / 环境与政策项

| 项 | 结论 |
|----|------|
| Rust 侧闸门（fmt / clippy / test / cargo audit） | 本机无 `cargo`/`rustup`，未能本地执行；CI 侧仍由 `ci.yml` 的 cargo job 覆盖。改动未触及 `crates/`。 |
| `pnpm audit` 27 项（1 high 已 ignore / 23 moderate / 3 low） | 集中在构建与测试期依赖（nuxt dev 链、vitest、@modelcontextprotocol/sdk 的 hono/ip-address 传递依赖）。CI 闸门定在 `high`，当前通过；按仓库既有政策（`ci.yml:35-40`）不再逐个 override——强升 hono/ip-address 属未验证的传递依赖变更，收益低于回归风险。 |
| `message.archiveAndRemove` 归档行重复 | 归档 append 中途失败时，重试会重复写已成功的行（读取侧按 id 去重、不影响正确性，只涨文件体积）。属罕见崩溃窗口，未改。 |
| `DocumentStore` 读缓存与并发写的指纹竞态 | 仅在「同尺寸 + 同 mtime」的低分辨率文件系统上可命中；NTFS/POSIX 的 mtime 精度下不可达。保持现状（写路径已 delete 缓存 + 指纹兜底）。 |

---

## 五、修复后验证

| 检查 | 结果 |
|------|------|
| `pnpm lint` | ✅ 3 包 |
| `pnpm typecheck` | ✅ 4 任务 |
| `pnpm test` | ✅ **189 文件 / 1821 用例**（+2 文件 / +21 用例，1 skipped） |
| `pnpm build` | ✅ 3 包 |
| `npx playwright test` | ✅ 8/8（清理生成物后复跑） |

新增/加强的用例分布：`tests/mind/mind-files.test.ts`（+4）、`tests/provider/embedder.test.ts`（+4，新文件）、`tests/tools/mcp/onclose-chain.test.ts`（+4，新文件）、`tests/api/compute.test.ts`（+7）、`tests/api/agents.test.ts`（+1）、`tests/core/agent-worker.test.ts`（+1 且修 1 例抖动）、`tests/api/ws-session.test.ts`（+2 断言）。
