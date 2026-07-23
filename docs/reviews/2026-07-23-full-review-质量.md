# CMZ 全面 review 第 6 块：质量基线（测试质量 + 性能基线）

- 日期：2026-07-23
- 基线：main @ 1768e96，工作树干净（除各 pane 并行的 review 报告）
- 范围：仅测试质量与性能基线。只 review 未改项目代码；临时脚本置于 F:/tmp/cmz-bench/（用完即弃）
- 测试现状核实：`pnpm --filter @mindcloud/engine test` 实测 71 个测试文件、527 个用例全绿，耗时 61.15s
- 实测环境：Windows 11 (26200)，AMD Ryzen 7 8845H（16 线程），31GB RAM，Node v24.15.0，pnpm 10.33.0；sidecar 为 `crates/zome-sidecar/target/release/zome-sidecar.exe`（release 构建），gRPC 127.0.0.1:50051

---

## 一、测试质量

### 1.1 覆盖率分布（v8 provider，`pnpm --filter @mindcloud/engine run test:coverage` 实测）

全库：语句 83.6% / 分支 83.7% / 函数 93.8%。按目录（由 coverage-final.json 聚合）：

| 目录 | 文件数 | 语句% | 分支% | 函数% |
|---|---|---|---|---|
| src/context | 8 | 98.9 | 97.3 | 100 |
| src/conductor | 3 | 100 | 97.1 | 100 |
| src/mind | 1 | 98.6 | 87.9 | 100 |
| src/core | 6 | 96.4 | 89.6 | 100 |
| src/config | 3 | 95.3 | 92.1 | 100 |
| src/memory | 16 | 94.7 | 88.9 | 96.4 |
| src/subagent | 4 | 91.8 | 87.0 | 93.8 |
| src/tools | 11 | 91.7 | 85.1 | 100 |
| src/scheduler | 4 | 89.7 | 77.1 | 87.5 |
| src/api | 19 | 81.2 | 72.5 | 94.4 |
| src/sidecar | 1 | 74.1 | 60.0 | 85.7 |
| src/blueprint | 3 | 69.6 | 80.9 | 86.7 |
| src/skills | 3 | 68.8 | 47.1 | 100 |
| src/provider | 5 | 52.3 | 64.9 | 50.0 |
| src/bootstrap.ts | 1 | 0 | 0 | 0 |

brief 优先看的三个核心模块（context/memory/core）覆盖率都在 94% 以上，数字层面没有问题。真正的洼地是：

- `src/provider/embedder.ts` 0%、`src/provider/image-gen.ts` 0%（整个文件无任何测试引用）、`src/provider/errors.ts` 37.5%
- `src/skills/manager.ts` 0%（loader.ts 91.4% 但分支只有 40%）
- `src/sidecar/client.ts` 74.1%（降级路径 92-95、103-113 未覆盖）
- `src/bootstrap.ts` 0%（装配层完全无测试，属常见但值得记录）

### 1.2 假测试识别

审计方法：全量通读 tests/context（11 文件 118 例）、tests/memory（9 文件 42 例）、tests/core（4 文件 43 例）、tests/mind（3 文件 29 例），共 27 文件 232 例，并对照被测源码核实。总体判断：这套测试质量偏上，多数断言精确到值，含边界与 review 反例回归（M1/M2、Windows EPERM），未发现"严重"级假测试。问题清单：

【一般】

1. `tests/core/react.test.ts:231` "runs non-conflicting tool calls in parallel" —— 名实不符。断言只有 `flags.a/b === true` 和 tool.result 事件数为 2，两个工具串行执行同样全部通过，没有任何观测执行重叠的手段（时间戳/屏障）。实际只测了"两个工具都跑了"。
2. `tests/memory/indexer.test.ts:42` "indexMessage 正常路径调用 upsert" —— 断言 `upsert` 收到 `[0.1, 0.2]`，这是 fake embedder 对任意输入返回的常量，等于"mock 的返回值传给另一个 mock"。对照 `src/memory/indexer.ts:37-42`：trim、空文本早退、2000 字符截断三个真实分支在该测试里完全不可观测。
3. `src/core/react/tool-call.ts` 失败路径零覆盖 —— zod 参数校验失败分支（tool-call.ts:47-54）和 `tool.execute` 抛异常分支（tool-call.ts:76，`Promise.all` 内未包 try/catch，整批 reject 还是隔离为单条 error 行为未钉住）无任何用例。全 tests/ grep 确认无覆盖。

【轻微】

4. `tests/context/token-counter.test.ts:25` "countText 对中文准确计数" —— 断言仅 `toBeGreaterThan(2)`，名实不符（好在 pipeline.integration.test.ts:133 有逐样本精确对比兜底）。
5. `tests/mind/mind-failed-sidecar.test.ts:94` —— 核心断言 `resolves.toBeTruthy()`，返回对象恒 truthy，等于只测"不抛错"。
6. `tests/context/pipeline.integration.test.ts:97` `expectMockReply` —— 断言 MockLLMProvider 的罐头回复，自证（同测试主体断言真实，属附加噪音）。
7. `tests/core/react.test.ts:75` —— 主要断言 Mock provider 固定事件的透传，SUT 行为只有 turn.end 时序一条。
8. `tests/core/agent-worker.test.ts:831` —— 唯一断言 `search not.toHaveBeenCalled()`，未断言关闭检索后消息组装正常。
9. `src/memory/document-store.ts:148-152` JSONL 坏行容错分支无用例（该文件其余 9 个用例质量很高）。
10. `src/memory/indexer.ts` 输入侧边界（空文本早退 :37-38、截断 :42）无直接用例。
11. `tests/memory/repositories/llm-call.test.ts:33` 仅 1 个快乐路径用例，无任何边界。

### 1.3 mock 依赖度（关键链路真实路径验证缺口）

| 链路 | 源文件数 | 相关测试文件 | 纯 mock 占比 | 真实路径验证 |
|---|---|---|---|---|
| LLM 调用链 | 7 | 6 | 100%（6/6） | 0：无真实 HTTP、无回放/契约/fixture（全 tests/ grep nock/msw 0 匹配） |
| sidecar gRPC | 2(TS) | 3(TS)+1(Rust) | 67%（2/3） | 部分：进程内 proto 契约测试 + Rust 侧自测；TS↔Rust 跨进程 0 验证 |
| WebSocket 端到端 | 3 | 2(vitest)+1(e2e) | 0%（传输层全真） | 有：真实 fastify listen + 真实 ws 客户端 + Playwright 真实浏览器；但下游 LLM 全部 mock |

缺口最严重的点：

1. **全仓库唯一 e2e（`tests/e2e/chat.spec.ts:25`）断言 `toContainText("mock")`**。`scripts/start-e2e.mjs:12` 设 `NODE_ENV=e2e`，`src/bootstrap.ts:182` 直接返回 `new MockLLMProvider()`。真实 LLM 路径在端到端层面零验证。
2. **`src/provider/embedder.ts:17` 与 `src/provider/image-gen.ts:17` 零测试**。且 `MockEmbedderProvider.embed`（embedder.ts:36）返回 `Math.random()` 随机向量——若语义检索链路在 e2e 被触发，行为不可复现。
3. **TS↔Rust sidecar 链路从未在测试中真实跑通**：TS 侧（`tests/sidecar/client.test.ts:28-38`）用真实 proto 起的是 JS 手写假 server；Rust 侧（`crates/zome-sidecar/tests/grpc_integration_test.rs:20-43`）是 Rust 自测，不经过 TS `SidecarClient`。tests/ 中无任何 spawn 真实二进制的用例。proto 漂移只有字段名级别被兜住。
4. `tests/provider/llm.test.ts:69` 通过整体替换私有 client 字段测试，从未发出真实 HTTP；baseURL 拼接、错误透传无回放兜底。
5. WS 真实测试（`tests/api/ws.test.ts:38`、`tests/api/ws-session.test.ts:40`）注入的都是 MockLLMProvider，"WS→真实 LLM 流式回传"组合（如 LLM 中途报错经 WS 的表现）未验证。

辅助设施现状：`tests/helpers/` 只有 env.ts 一个文件，无共享 mock 工厂；`MockLLMProvider/MockEmbedderProvider/MockImageGenProvider` 住在生产源码里（llm.ts:136、embedder.ts:30、image-gen.ts:31）并被 bootstrap 的 e2e 分支用于装配；`buildTestContext()` 样板在 chat/ws/ws-session 三个测试文件里各复制一份。

**一个有力的旁证**：本次性能实测手工拉起真实 sidecar 二进制，第一次让 TS↔Rust 链路真实运转，立即暴露一个 Blocker 级性能缺陷（见 2.2）。527 个全绿测试从未跑过这条链路，所以从未有机会发现它。

### 1.4 flaky 风险

issue `docs/issues/2026-07-17-scheduler-flaky.md` 所述修复均已核实存在：

- `renameWithRetry`：`src/memory/document-store.ts:24-39`（EPERM/EBUSY/EACCES 五次递增退避），`writeJsonInner`/`writeLinesInner` 统一走该路径，`src/memory/topic/store.ts:53`、`src/mind/mind-files.ts:343` 已复用
- 并发读句柄回归测试：`tests/memory/document-store.test.ts:18-32`（持有读句柄 200ms，未修复必抛 EPERM）
- scheduler 墙钟断言已改 `vi.waitFor`：`tests/scheduler/scheduler.test.ts:87`

仍存在的同类风险：

【一般】

1. `tests/memory/repositories/agent.test.ts:107` 和 `:126` —— fs.watch 外部变更测试用固定 300ms 墙钟等待后正向断言，无 `vi.waitFor` 兜底。fs.watch 在 Windows 走 ReadDirectoryChangesW，投递时机不受控，turbo 满载/杀毒扫描时 300ms 可能不够。与已修的 scheduler flaky 最同构的一处。
2. `tests/scheduler/scheduler.test.ts:182` "prevents concurrent runTask" —— 仍残留固定 10ms 睡眠窗口（issue A 修复遗漏点），满载下 `getAgentWorker` 可能尚未被调用而误判。

【轻微】scheduler.test.ts:124 手写轮询（1s 预算偏紧）、run_command.test.ts:146 子进程时长区间断言、run_command.test.ts:234 POSIX 500ms 等待、indexer.test.ts:52 `Date.now()` 性能式断言（余量 66 倍，仅验证不挂死）、ws 测试 300ms 排序保险（逻辑上无失败路径）。套件级缓解：`vitest.config.ts` 的 `fileParallelism: false` 串行配置降低了多数时序窗口被拉长的概率。

---

## 二、性能基线（2026-07-23 实测，基线数据，非打分）

方法：临时脚本（F:/tmp/cmz-bench/）经 tsx 直调 engine 源码模块，数据目录指向临时目录（CLOUDMIND_DATA_DIR）；sidecar 用真实 release 二进制 + 临时数据目录 + stub engine（ZOME_ENGINE_ENTRY）。所有数字为本机单次运行结果，标注 avg/p50。

### 2.1 延迟基线

**token 计数（engine，`TiktokenCounter` 单例）**

| 操作 | avg | p50 |
|---|---|---|
| countText 130 字 | 0.17ms | 0.13ms |
| countText ~960 字 | 0.37ms | 0.32ms |
| countText ~9600 字 | 2.87ms | 2.77ms |
| countMessages 100 条 | 19.45ms | 19.04ms |
| countMessages 500 条 | 87.67ms | 87.71ms |

**ContextPipeline.assemble（+L4x10 +L5x5 +7 工具）**

| 历史规模 | avg | p50 |
|---|---|---|
| 10 条 | 3.21ms | 2.99ms |
| 100 条 | 21.65ms | 21.56ms |
| 500 条 | 99.05ms | 100.05ms |
| 200 条但预算压到 1800（触发完整降级序列） | 402.36ms | 395.12ms |

注意最后一行：降级循环每步都全量重算 `countMessages + countTools`（`src/context/pipeline.ts:119-146`），8 步降级 ≈ 8 次全量计数，是 assemble 的最坏路径。

**L4 语义检索一轮（SemanticRetriever，gRPC 以本地 stub 代替，其余全真：真实 messages.jsonl + 真实压缩档）**

| 消息规模 | 压缩档 | avg | p50 |
|---|---|---|---|
| 1000 条 | 0 | 2.85ms | 2.50ms |
| 10000 条 | 0 | 29.40ms | 26.70ms |
| 10000 条 | 100 | 31.12ms | 27.37ms |
| 10000 条 | 1000 | 95.44ms | 75.92ms |

每轮对话的 L4 检索在万条消息 + 千个压缩档时要付约 95ms（其中 archivedMessageIds 缓存命中仍约 54ms）。

**sidecar gRPC（真实 Rust 二进制，384 维向量）**

| 操作 | 规模 | 实测 |
|---|---|---|
| upsert（含增量落盘） | — | 单条 2.2-3.4ms |
| search topK=10 稳态 | 100 / 1000 / 3000 / 10000 条 | 1.77ms / 2.33ms / 5.15ms / 1.5-2.8ms |
| **search 首次（dirty 触发 HNSW 全量重建）** | 100 条 | **479ms** |
| 同上 | 1000 条 | **3969ms（已超 TS 客户端 3000ms deadline）** |
| 同上 | 3000 条 | **17676ms** |
| 同上 | 10001 条 | **123773ms（123.8 秒）** |
| CountTokens 新 model 首次 | — | 5.0ms |
| CountTokens ~240 字稳态 | — | 1.76ms |

### 2.2 增长曲线

- **消息存储（JSONL）**：appendLine 单条成本恒定 0.63-0.78ms（100/1000/10000 条不变）；readLines 随规模线性，1000 条 3.39ms、10000 条 31.09ms（冷读）。listBySession(limit=100)：1000 条 2.05ms → 10000 条 25.25ms（每次调用全量解析文件再截取）。
- **压缩档**：archivedMessageIds 冷读 100 档 14.38ms、1000 档 124.39ms（约 0.12ms/档线性）；缓存命中 5.91ms / 54.47ms。
- **向量索引**：upsert 恒定 ~2-3ms/条（增量落盘）；**HNSW 重建成本超线性爆炸**：100 条 0.48s → 1000 条 4.0s → 3000 条 17.7s → 1 万条 123.8s。稳态检索本身始终为毫秒级。
- **Blocker 机理**：`vector/mod.rs:37-42` 每次 dirty 后 search 前全量重建 HNSW，重建是 CPU 密集计算且持有 `state.write()` 锁，同时阻塞 tokio runtime（实测重建期间其余 RPC 全部超时/RESOURCE_EXHAUSTED）；TS 侧 `SidecarClient` deadline 3000ms（`client.ts:79`），超时后 `MemoryIndexer.search` 静默降级返回空（`indexer.ts:59-70`）。生产上每条新消息都会 upsert 置 dirty，即每轮对话的 L4 检索都触发一次全量重建——**索引到约 1000 条时重建即超过 3s deadline，L4 实质失效且用户无感知；万条时单次重建 2 分钟，sidecar 全程卡死**。

### 2.3 内存

engine 混合负载（append + assemble + listBySession）200 轮采样：rss 271.6MB → 291.1MB（+19.5MB，约 0.1MB/轮），heapUsed 在 61-92MB 区间波动、未见单调爬升。短期（200 轮 ≈ 200 条消息）无明显泄漏迹象。两个结构性隐忧（未实测到失控，但无上限）：`DocumentStore` 模块级 readCache（document-store.ts:17）按文件驻留无逐出；sidecar `INDEX_CACHE`（vector/mod.rs:115）按 agent 驻留无逐出。长跑（数千轮、多 agent）趋势本次未测，受单机运行时间限制，如实说明。

### 2.4 7月22日优化项的效果验证

5 个 perf 提交（ee8c738 读缓存、853fb5a 按档缓存、a002b10 增量持久化+惰性重建、5c9ee58 tokenizer 缓存、e487192 健康检查复用 client）逐一核对 commit message 与 diff：**均未附带任何基准数据**（最有数据味的一句是"cargo bench 编译验证通过"——只验证了编译）。`services/engine/bench/` 三个 bench 文件是 6 月 26 日引入，早于优化且未覆盖优化点（document-store.bench.ts:36 的计时区内 append 会删缓存，测的是冷读）。结论：**优化上线时凭定性判断，没有前后对比数据**。本次实测补齐：

| 优化项 | 实测效果 | 评价 |
|---|---|---|
| DocumentStore 读缓存 | 10000 条：冷读 31.09ms → 缓存命中 24.23ms（-22%） | 有效但收益被命中路径的 `structuredClone` 深拷贝（document-store.ts:136）吃掉大半；规模越大克隆越贵 |
| archivedMessageIds 按档缓存 | 1000 档：124.39ms → 54.47ms（-56%） | 有效，但命中后仍是每轮 L4 的显著成本项 |
| sidecar tokenizer 按 model 缓存 | 新 model 首调 5.0ms → 稳态 1.76ms（-65%，含 gRPC 往返） | 有效，绝对值小 |
| sidecar Upsert 增量持久化 | upsert 单条 2.2-3.4ms（每次 append 重新 open 文件） | 方向正确；消除了"每条全量重写"，但 per-append open 仍有优化空间 |
| sidecar 惰性索引重建 | 重建 100 条 0.48s / 1000 条 4.0s / 1 万条 123.8s | **在 1k+ 规模是负资产**：重建从"每次 upsert 付一次"变成"每轮 search 付一次完整重建"，频率没降，单次成本未降，且阻塞整个 sidecar runtime |

---

## 三、风险分级清单

### Blocker

- **B1. sidecar HNSW 全量重建随规模失控，L4 语义检索在千条索引即实质失效。** 实测：1000 条重建 3969ms 超 TS 客户端 3000ms deadline；1 万条 123.8s，期间整个 sidecar runtime 阻塞（其余 RPC 超时/RESOURCE_EXHAUSTED）。生产路径每条消息 upsert 置 dirty → 每轮对话 L4 检索都触发全量重建 → 超时后 `MemoryIndexer.search` 静默返回空（`indexer.ts:59`），用户无感知地失去语义检索。证据：`crates/zome-sidecar/src/vector/mod.rs:37-42`、`services/engine/src/sidecar/client.ts:79`、2.1/2.2 实测表。任何真实测试都没覆盖这条链路，是 527 全绿背后的最大盲区。

### Major

- **M1. LLM 调用链从单元到 e2e 100% mock，两个 provider 零测试。** embedder.ts/image-gen.ts 覆盖率 0%；唯一 e2e 断言 "mock"（chat.spec.ts:25 + bootstrap.ts:182）；无回放/契约设施。MockEmbedderProvider 返回随机向量（embedder.ts:36）。
- **M2. TS↔Rust sidecar 跨进程链路零验证。** TS 侧只测 JS 假 server，Rust 侧自测不经 TS 客户端；proto 漂移、序列化、真实二进制行为均无保障（B1 即为直接后果）。
- **M3. ContextPipeline 降级循环重复全量计数。** 每次降级迭代重算 countMessages+countTools（pipeline.ts:119-146），实测触发完整降级序列时 assemble 402ms（同输入正常路径 21.65ms），超预算轮次主链路多付约 380ms。
- **M4. L4 每轮固定成本随数据规模显著增长。** 万条消息 + 千压缩档时 retrieve 95ms/轮，其中 archivedMessageIds 缓存命中仍需 54ms；listBySession/getByIds 每次全量解析 messages.jsonl（万条 25/22ms）。
- **M5. tool-call 失败路径零覆盖。** zod 校验失败（tool-call.ts:47-54）与 execute 抛异常（:76）行为未钉住，后者在 Promise.all 内未隔离，健壮性盲区。

### Minor

- **m1.** 假测试 3 项一般 + 8 项轻微（1.2 节清单），最典型：react.test.ts:231 并行测试名实不符、indexer.test.ts:42 mock→mock。
- **m2.** flaky 遗留 2 处一般：agent.test.ts:107/126（fs.watch 300ms 墙钟）、scheduler.test.ts:182（残留 10ms 窗口，issue A 修复遗漏）。
- **m3.** 读缓存收益被 structuredClone 限制（-22%），且 readCache/INDEX_CACHE 均无逐出上限，长跑内存依赖 agent/文件数量自然封顶。
- **m4.** 测试基础设施薄弱：helpers/ 形同虚设、Mock provider 住生产源码、buildTestContext 三份复制、bench/ 三个 bench 未覆盖 7/22 优化点。
- **m5.** 覆盖率洼地：skills/manager.ts 0%、sidecar/client.ts 降级路径未覆盖、bootstrap.ts 0%。

## 四、总评

测试质量：**数字好、骨架好、盲区集中**。核心模块（context/core/memory/mind）覆盖 94-99%，断言质量整体偏高，降级序列、EPERM、M1/M2 反例都有真实回归；但所有关键外部边界（LLM HTTP、sidecar gRPC 跨进程、真实 e2e）全部用 mock 短路，且 mock 替身住在生产源码里。527 全绿证明的是"引擎内部逻辑在受控输入下正确"，不证明"系统能跟真实外部世界一起工作"。

性能基线：**内部路径健康，外部边界有一个活火山**。token 计数、assemble、JSONL 存储在正常规模都是毫秒级且增长可预期；内存短期无泄漏迹象。但 sidecar 向量索引的 HNSW 重建是 Blocker：这不是理论推测，是第一次把真实二进制拉起来就实测到的 123.8 秒级故障，且 7/22 的"惰性重建"优化在没有基准数据的情况下恰好把这个雷埋得更深。建议优先级：B1（增量索引或后台重建+读写分离）> M1/M2（至少给 TS↔Rust 链路加一条真实二进制的冒烟测试，本次 F:/tmp/cmz-bench 的脚本就是现成原型）> M3（降级循环增量计数）> 其余。

7/22 优化的最终评价：五个提交方向都对，四个有实测正收益，但全部"凭感觉上线"——没有前后对比数据，bench 设施也没跟上；其中惰性重建一项在真实规模下为负收益。性能优化没有基线的代价，这次由基线本身做了演示。
