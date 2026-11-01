# 后台看护（Watchdog）：turn 级卡死检测与中断 实施前报告

> 日期：2026-11-01 | 状态：**P1、P2、P3 已实施完成**（见 §4.1–§4.4）；P4 不在本期范围
> 触发：`worker-registry.ts:18-21` 已登记「已知风险（设计取舍，登记不做）」，本文是对该条的风险复核与实施论证；方法参照 DeepSeek Harness《Super-agent 设计探索》§6（外部 Control Loop）。
> 定位：**不是**新增产品功能，是补一条可靠性回路——现有系统一旦遇到 provider 流悬挂，没有任何内部机制能自愈，只能运维重启。

---

## 一、当前情况（事实基线）

### 1.1 登记在案的风险（原文）

`services/engine/src/core/worker-registry.ts:18-21`：

> retire 对在途 turn 无超时、无 abort——waitForIdle 只等自然排空，若 provider 流永久挂起（HTTP 层无超时/流不结束），新 worker 永不创建，该 agent 全通道静默等待直到重启。不强杀的理由：热存储/话题不变量靠「只含完整 step」维持，半截 turn 的取消需要全链路 abort 语义（落盘、话题 tracker、终帧都要定义），代价大于收益；现状由运维重启兜底。若未来引入 turn 级 watchdog，需先定义 abort 的落盘与终帧语义再动这里。

本次核对确认该风险**仍然成立**，且实际暴露面比登记时更宽——见 1.3。

### 1.2 已有的三层保护（都在，但都不是看护）

| 保护 | 位置 | 管什么 | 管不到什么 |
|------|------|--------|-----------|
| ReAct 步数保险丝 | `reactMaxSteps`，缺省 100，clamp 1-500（`turn.ts:305`） | 防无限空转 | 单步内挂死（步数不增长，保险丝永不触发） |
| 工具执行超时 | bash 30s（`bash.ts:8`）、run_command 1–600s（`run_command.ts:7`） | 防命令跑飞 | LLM 调用本身 |
| Provider 重试 | `provider/resilient.ts`：429/5xx/网络/超时分类重试 | 防偶发失败 | 永不返回的流（错误都没抛，重试无从谈起） |

三者共同的前提是「**会有结果返回**」。挂死场景下这个前提不成立，三层全部静默失效。

### 1.3 三个具体缺口（本次新核实）

**缺口 A：`waitForIdle` 无超时，是形态上的死循环**

`agent-worker.ts:516-520`：

```
async waitForIdle(): Promise<void> {
  while (this.runningJob !== null || this.queue.length > 0) {
    await new Promise((r) => setTimeout(r, 10));
  }
}
```

10ms 轮询直到空闲。`worker-registry.ts:74` 的 `await retiring` 也在等这个 promise。turn 不结束 → 此循环永不退出 → `getOrCreate` 永久挂起 → 该 agent **全通道静默**（REST 写入、WS、scheduler、感知注入全部排在这一句后面）。

**缺口 B：超时语义是总时长，且 responses/anthropic 未配置时根本没有超时**

> 更正记录（2026-11-01 复核）：本报告初稿称「requestTimeout 未透传适配器」，**该结论有误**——初稿侦察时 grep 输出被截断，漏看了适配器侧。实际上 `requestTimeout` 是完整接线的：`plugins/llm/index.ts:78,119` → `protocols/index.ts:41,47,51,56,216` → 三个适配器 → `shared.ts:172`（全仓 39 处引用）。以下为复核后的准确结论。

真正的问题有两处：

1. **语义是总时长，对流式不友好。** 三条链路都按「整个请求的总耗时」计：
   - chat：`openai-compatible-chat.ts:36` 透传 OpenAI SDK 的 `timeout`；
   - responses / anthropic：`shared.ts:173` 的 `AbortSignal.timeout(...)`。
   
   流式场景下，长回答（长篇代码、长文）或 reasoning 模型的长思考阶段会整体超时被砍，而不是「卡住才砍」。

2. **未配置时，两条链路无任何超时。** `requestTimeout` 缺省为 `undefined`：
   - chat：回落 OpenAI SDK 缺省（10 分钟总超时）——**有兜底**；
   - responses / anthropic：`options.requestTimeout !== undefined` 才挂 signal，**不配置就完全裸奔**。
   
   而 DeepSeek flash 走 responses（DSML 根治方案），命中面不小。这是「挂死即永久阻塞」最直接的入口。

> **2026-11-01 已修复（P1）**：两处均已在 L0 层解决，见 §4.1。

**缺口 C：abort 只在步与步之间生效**

`turn.ts:306-308` 的 abort 检查在 `for` 循环顶部：

```
for (; step < maxSteps && !watermarkStop; step++) {
  if (input.signal?.aborted) throw new Error("aborted");
```

且 `input.signal` **没有传进 fetch**（fetch 只挂了 `AbortSignal.timeout`）。因此中断只能等到「当前步自然结束」，正在进行的 LLM 调用或工具执行不会被打断。

### 1.4 已有可复用的取消基础设施

不是从零开始——取消语义的骨架已存在：

- `HandoffResumeLoop` + `HandoffLoopRegistry` 的**仲裁面**：已实现「取消该 agent+session 维度全部连接的续跑 loop」（`DELETE /handoff/:id` 走这条路）；
- `chainId` 代际标记：跨连接防旧链复活；
- `AbortSignal` 已贯穿 `runTurn` 入参（只是没接到 fetch）。

---

## 二、关键前置：abort 语义必须先定义

代码注释说得很准：**代价不在检测，在于中断一个半截 turn**。以下四条必须在动手前定死，否则做出来就是数据污染源。

### 2.1 落盘：半截 step 直接丢弃，不变量不动

现有不变量：热存储只含**完整 step**（`turn.ts:386` `onStepAppended` 在每步末尾落盘）。

**决策：abort 时正在进行的 step 不落盘，已落盘的完整 step 原样保留。**

- 不引入「半截消息」这种新形态，`_compressed` / 归档 / reconcile 三条链路零改动；
- 代价：用户在界面上看到过流式输出的部分文字，历史里没有。这是**可接受的不对称**——流式气泡是瞬时视图，历史是既成事实。
- 前端契约：`turn.end` 帧需带中断标记，前端据此把气泡标为「已中断」而非「已完成」（见 2.3）。

### 2.2 话题 tracker：只跳过语义裁判，**不**切断入话题

> 实施修正（2026-11-01）：本条初稿写「abort 回合不参与话题生命周期（话题边界判定 / 话题关闭 / 压缩入队 / usedSkills 收集）」，**范围划错了**。复核发现 `agent-worker.ts` 的 catch 块已有一处 Minor-3 修复：异常 turn 已按 step 落盘的消息**必须**并入话题体系，否则会脱离话题——永不归档/压缩/索引，永久滞留热存储且每轮进上下文。中断路径同样落过完整 step，切断入话题等于把这个已修的坑重新挖开。

**最终实施**：中断回合保留 `onTurnAppended` / 话题关闭 / 压缩入队 / `usedSkills` 收集（与故障路径一致），**只跳过 `maybeRunTopicJudge`**。

理由：语义裁判（每攒 6 轮异步判一次话题边界）以「一次完整交互」为前提，把半截回合送进去只会得到误判，且白烧一次 LLM 调用。其余动作的对象都是**已落盘的完整消息**，与回合是否被中断无关。

### 2.3 终帧：`turn.end` 扩展中断原因

现帧 `turn.end` 语义是「ReAct 循环退出」。需区分正常退出与中断退出：

| 字段 | 取值 | 前端行为 |
|------|------|---------|
| `turn.end` | 现有（无中断字段） | 复位「生成中」，气泡转正常态 |
| `turn.end.aborted` | `{ reason: "watchdog" \| "timeout" \| "shutdown" \| "user" }` | 复位「生成中」，气泡标「已中断」并保留已显示文本 |

`reason` 分档是必要的——watchdog 中断与用户主动取消在排查时是完全不同的事故。

### 2.4 与换班（handoff）的关系：**不写交接书**

水位撞顶的换班会产出 `[交接书]` 并自动续跑。**watchdog 中断不接管换班**：

- 撞顶是「上下文放不下」，任务本身健康，交接书有意义；
- 挂死是「链路故障」，此刻模型未必有产出能力，写交接书可能得到一份垃圾，反而污染下一棒；
- 且 handoff 控制面有自己的状态机（`pending→scheduled→running→…`），让 watchdog 掺进去会把两个故障域耦合起来。

**决策：watchdog 中断后 worker 回 idle，队列中的后续 job 照常处理。任务本身不自动续跑，由用户或 scheduler 决定。**（二期可评估「中断后自动重试一次」，本期不做。）

---

## 三、方案

### 3.1 目标与非目标

**目标**

1. provider 流挂死时，该 agent 能在有限时间内自行恢复，不需要重启进程；
2. 恢复过程不破坏「热存储只含完整 step」与话题快照两条不变量；
3. 故障可观测（日志 + 一个可查的接口）。

**非目标**

1. **不做**文章 §6 那种「用模型判断 Worker 是否有实质进展、方向是否偏离」的语义审查——那是第二期，且需要额外的模型调用预算；
2. **不做**跨进程/跨设备的守护（本项目本地单机，无云端 counterpart）；
3. **不做**自动续跑（见 2.4）。

### 3.2 分层设计

```
L0 请求级：流空闲超时（最底层，先做）
   ↑ 每收到一个 chunk 重置计时器；N 秒无 chunk → abort 该次请求
L1 回合级：step 心跳（turn 每完成一步刷新 lastStepAt）
   ↑ 超阈值 → 判定 stalled → 触发 abort
L2 中断：按 §2 语义安全收尾
L3 语义审查（二期，本期不做）
```

**L0 是本次最关键、也最容易做错的一层。**

不能用「总时长」：长回答（生成长文、大篇代码）与 reasoning 模型的长思考阶段天然会超过任何固定的总时长阈值，直接砍会误杀正常任务。正确的语义是**空闲超时**——发出请求后开始计时（覆盖连接与首字节），每收到一个 chunk 重置计时器，连续 N 秒无任何数据才判定挂死。

- 改造范围：`shared.ts` 的 `postJsonStream` 覆盖 responses + anthropic 两条链路（`AbortSignal.timeout` → `AbortController` + 可重置计时器）；chat 链路因走 OpenAI SDK，需单独处理（SDK 的 `timeout` 仍是总时长，空闲计时需在其外层做，并给 SDK 一个足够大的硬兜底）；
- 缺省值建议：**空闲 180s**（可配）——取 3 分钟是因为 reasoning 模型首 token 前的静默期可能很长，90s 有误杀风险；首字节超时单独设，建议 90s；
- 与 `resilient.ts` 的重试衔接：空闲超时归类为「不可重试」——已产出内容的流重试会造成重复输出，应直接上升为 turn 级中断。实现上需用一个独立的错误名（不复用 `TimeoutError`），避免被 `isNetworkError` 判成可重试；
- 配置入口：`ProviderConfig.requestTimeout` 现被三处当总时长用（含连接测试），切到空闲语义会改变既有行为，需决策（见 §6 开放问题 1）。

**L1 挂点**

- `turn.ts` 每步结束刷新心跳（与 `onStepAppended` 同一位置，零额外成本）；
- 扫描器：新增 `plugins/watchdog/`（第 23 个 Cordis 插件，符合现有 22 插件的组织方式，可整体摘除）；
- 扫描周期建议 30s，只遍历 `WorkerRegistry.all()`，不额外维护注册表。

**L2 挂点**

- 中断入口复用现有 `AbortSignal`（`runTurn` 已收 `input.signal`），但**必须把它接到 fetch**（缺口 C），否则中断仍然要等当前步自然结束；
- 收尾动作按 §2.1–2.4 执行。

### 3.3 阈值与配置

| 项 | 缺省 | 可配 | 说明 |
|---|---|---|---|
| `watchdog.streamIdleTimeoutMs` | 90_000 | 是 | 流空闲超时（L0） |
| `watchdog.firstByteTimeoutMs` | 60_000 | 是 | 首字节超时（L0） |
| `watchdog.stallThresholdMs` | 600_000 | 是 | 单 turn 无 step 进展多久判 stalled（L1） |
| `watchdog.scanIntervalMs` | 30_000 | 是 | 扫描周期 |
| `watchdog.enabled` | true | 是 | 总开关（缺省开——故障恢复不该要用户先发现） |

> 阈值全部走 settings（与 `sidecarAutoStart` 同级），不走环境变量——这是运行期可调的运维参数，不是启动期常量。

### 3.4 观测

- 日志：`[watchdog] agent=<id> turn=<step> stalled <ms> → abort(reason)`，warn 级；
- 接口：`GET /system/watchdog` 返回当前存活 turn 的心跳快照（agentId / step / lastStepAt / 已运行时长），便于排查「到底是挂了还是只是慢」；
- 审计：中断事件落 actions/日志，与既有审批审计同风格（不含对话内容）。

---

## 四、分期

| 期 | 内容 | 独立价值 | 前置 |
|---|---|---|---|
| **P1** ✅ | L0 流空闲超时：`postJsonStream` 改空闲语义 + 三协议缺省兜底 + chat 链路处理 | 单独就能堵住缺口 B（未配置即无超时 + 总时长误杀） | 无 |
| **P2** ✅ | §2 abort 语义四条落地（落盘/话题/终帧/handoff 关系）+ 外部 signal 贯通到 provider | 为任何中断能力打地基 | P1 |
| **P3** ✅ | L1 心跳扫描 + `plugins/watchdog` + `GET /system/watchdog` | 覆盖「有超时但每步都慢」的慢性卡死 | P2 |
| **P4** | L3 语义审查（模型判断是否偏离目标） | —— | 本期不做 |

**P1 可以单独先合。** 它不碰 abort 语义，只是把超时语义修正过来，风险最低、收益最直接。

### 4.1 P1 实施记录（2026-11-01 完成）

**改动**

| 文件 | 内容 |
|---|---|
| `provider/protocols/shared.ts` | 新增 `DEFAULT_STREAM_IDLE_TIMEOUT_MS`（180s）、`StreamIdleTimeoutError`、`resolveIdleTimeoutMs()`、`createIdleTimeout()`；`postJsonStream` 由 `AbortSignal.timeout` 改为 `AbortController` + 可重置计时器；`readSseData` 接收看护句柄，每次 `reader.read()` 后重置、抛错时映射为 `StreamIdleTimeoutError` |
| `provider/protocols/openai-compatible-chat.ts` | SDK `timeout` 固定为 `SDK_HARD_TIMEOUT_MS`（30 分钟硬兜底）；`chat()` 内建看护，`create(params, { signal })` + 每 chunk 重置；超时强制不可重试 |
| `tests/provider/protocols.test.ts` | 新增「流空闲超时」describe（3 例）：长回答不被总时长砍断 / 超时错误名与不可重试 / `resolveIdleTimeoutMs` 取值矩阵；既有「requestTimeout 超时中断」断言由可重试改为不可重试 |
| `tests/provider/resilient.test.ts` | SDK timeout 断言改为 `SDK_HARD_TIMEOUT_MS`（原断言 requestTimeout 值，语义已变） |

**关键取舍**

1. **错误名独立**：`StreamIdleTimeoutError` 不复用 `TimeoutError`，避免被 `isNetworkError` 判成可重试。
2. **缺省启用**：未配置时用 180s 而非「无限」。理由见 §1.3——「未配置即无超时」是缺陷不是特性。
3. **阈值取 180s 而非 90s**：reasoning 模型首 token 前静默期可能很长，90s 有误杀风险。
4. **chat 保留 SDK 总时长**：仅作 30 分钟硬兜底，防「数据一直来但永不结束」的畸形流；常规挂死由空闲超时先接管。

**验证**：`typecheck` 通过；`provider` 套件 84 例全绿（含新增 3 例）；`lint` 通过；engine 全量 1752 例中 1748 通过，4 例失败均在 `tests/sidecar/autostart.test.ts`——经 stash 对照确认为**既有失败**（原始代码同样 4 例失败），与本单无关。

**遗留**：`embedder.ts` 与 `image-gen.ts` 的 OpenAI 客户端未接超时看护（均为非流式短请求，风险低），不在 P1 范围。

### 4.2 P2 实施记录（2026-11-01 完成）

**侦察结论（先于实施，改变了方案形状）**

- `LLMProvider.chat(params)` 没有 signal 参数，`turn.ts` 的中断检查只在**步与步之间**（`step.ts:100` 是每个 event 后检查），而在途 fetch 完全不受控——中断延迟等于一次完整生成。
- 全仓 12 处 `new AbortController` 分布在 plans / blueprint / handoff / subagent / 工具内部，**WS 私聊路径一处都没有**。即：用户在界面上没有「停止生成」能力，`aborted.reason` 的 `"user"` 目前只能来自 plans/blueprint 的超时取消。
- `resilient.ts` 对「不可重试错误」的处理是**降级到备用 provider**。若照搬 P1 的「超时判不可重试」，用户取消会触发换模型重跑——语义荒谬，必须单独拦。

**改动**

| 文件 | 内容 |
|---|---|
| `provider/types.ts` | `LLMChatParams` 增 `signal?`（控制面通道）；`TurnEndEvent` 增可选 `aborted.reason`；新增 `TurnAbortReason` |
| `provider/protocols/shared.ts` | 新增 `TurnAbortedError`（name 独立、message 保留 "aborted" 关键词）、`isTurnAbortedError()`、`mergeSignals()`；`postJsonStream` 合并外部 signal 与空闲超时，错误映射按「外部取消 > 空闲超时 > 原样」排序 |
| `provider/protocols/openai-compatible-chat.ts` | 三个协议统一：合并 signal 传 SDK，catch 里优先判外部取消 |
| `provider/protocols/{openai-responses,anthropic-messages}.ts` | 透传 `params.signal` 到 `postJsonStream` |
| `provider/resilient.ts` | 首事件失败时若为取消错误**直接上抛**：不重试、不降级 |
| `core/react/step.ts` | `params` 带 signal；两处 `throw new Error("aborted")` → `TurnAbortedError` |
| `core/react/turn.ts` | 步边界 abort 抛 `TurnAbortedError`；`stepInput` 透传 `signal`（首版漏传，见 §4.3 断链修复） |
| `core/agent-worker.ts` | 新增 `resolveAbortReason()`（signal.reason 认不出时回落 `"user"`）；catch 块按中断/故障分流；终帧带 `aborted` |
| `apps/web/utils/managed-ws.ts` | `onTurnEnd` 增第二参数；仅在带 `aborted` 时才传，保持既有调用形状 |
| `apps/web/stores/chat.ts` + `composables/useChatRecords.ts` + `components/MessageBubble.vue` | 中断标记 `aborted` 透到气泡，显示「已中断」尾注（已显示文本不丢） |

**关键决策**

1. **signal 放进 `LLMChatParams` 而非加第二参数**：resilient / record-calls / ModelApiModeRouter 三层包装都原样透传 params，零改动；加第二参数要改 8 个实现。
2. **错误分三类而非两类**：`TurnAbortedError`（取消）≠ `StreamIdleTimeoutError`（空闲超时）≠ 网络错误。三者都不可重试，但只有取消**不可降级**。
3. **§2.2 范围修正**（见上）：保留入话题，只跳过语义裁判。
4. **前端只在有 `aborted` 时传第二参数**：正常结束帧形状与调用形状全部不变，老测试零改动。

**验证**

- engine：`provider` 86 例、`core` 280 例全绿（新增 4 例：外部取消立即中断、已 abort 不发请求、中断终帧 reason、无 reason 归 user）
- web：typecheck 通过，303 例全绿
- 全量：见 §4.3 汇总

**遗留**（两条均已在 §4.3 收尾）

- 用户侧取消入口缺失 → §4.3 已补
- 群聊气泡中断标记未消费 → §4.3 已补

### 4.3 P2 收尾（2026-11-01 完成）：停止生成入口 + 信号断链修复

#### 一、首版实施存在断链，P2 的「贯通到 fetch」当时并不成立

补「停止生成」时写的集成测试（`ws.test.ts` 的 `turn.cancel` 用例）超时，顺藤查出根因：

```
job.signal  ✅ agent-worker.ts:981 传给 runTurn
  → turn.input.signal  ✅
  → stepInput  ❌ 构造时漏了 signal 字段
  → step.input.signal  undefined
  → params.signal  undefined
  → provider 拿不到取消信号
```

`turn.ts` 只在**步与步之间**检查 `input.signal`，step 内部的 provider 请求全程裸奔。即用户在流式输出中途取消，仍会等当前步完整生成完才停。

**为什么 P2 的测试没抓到**：provider 层测试直接构造 `params` 调 `provider.chat()`，core 层测试覆盖的是步边界 abort——**没有一条测试穿过 turn → step → provider 的完整链路**。这也是本次补集成用例的直接理由。

修复：`stepInput` 增 `signal: input.signal`。修复后该用例从「超时」变为通过。

> 教训与 §1.3 的 `requestTimeout` 误判同源：**验证要覆盖真实调用链**，仅测单层会把「字段存在」误当成「链路贯通」。

#### 二、停止生成（用户侧入口）

| 层 | 改动 |
|---|---|
| `api/ws/handler.ts`（私聊） | 连接作用域 `inflight: Set<AbortController>`；`enqueue` 时建句柄、传 `signal`、`onDone` 释放；新增 `turn.cancel` 分支 abort 全部在途 job（`reason="user"`） |
| `api/ws/session-handler.ts`（群聊） | 同上。群聊一条消息并行投给多个 agent，**整批一起掐**——只掐一个，其余人形会继续在群里各说各话 |
| `components/MessageInput.vue` | 流式期间发送按钮换成「停止」（危险色，**不 disabled**——禁用的停止按钮等于没有停止）；新增 `stop` emit |
| `stores/chat.ts` | 新增 `stop()`：发 `turn.cancel`。**不本地复位 `isStreaming`**——交给引擎回的 `turn.end` 收尾，本地抢先复位会让界面显示「已完成」而 delta 还在到 |
| `pages/sessions/[id].vue`、`pages/hub.vue` | 各自 `onStop` / `onGroupStop`，透传到群聊连接 |
| `composables/useGroupChatStream.ts` | `closeSlot` 接受 `aborted`，补上 P2 遗留的群聊「已中断」标记（原先数据透传了但没人消费） |

**作用域决策**：取消按**连接**而非 agent。同一 agent 可能开多个标签页，A 页停止不该波及 B 页。排队 job 一并取消——只掐最新那条会误伤（排队的被跳过，真正在跑的反倒继续烧 token）。

**验证**：engine `api/ws.test.ts` 13 例全绿（新增 2 例：中断终帧 `reason="user"` 且不刷错误、空转 cancel 无副作用）；web `MessageInput` 6 例全绿（停止态可点、回车不误发、合成态不发）。

### 4.4 P3 实施记录（2026-11-01 完成）：心跳扫描 + 可观测面

这一层解决的是 L0 管不到的那类卡死：**每一步都刚好在空闲阈值内返回，二十步下来卡一小时**。L0 一次都不会触发，因为它的判据是「单次请求多久没数据」。L1 的判据换成「整个 turn 有没有实质进展」。

#### 一、心跳：什么才算「有进展」

`AgentWorker.getHeartbeat()` 暴露 `{ startedAt, lastActivityAt, stepCount, activeTool? }`，`lastActivityAt` 由三个点刷新：

| 刷新点 | 为什么算进展 |
|---|---|
| 完成一个 step（`onStepAppended`） | 一轮真实交互走完，包括工具结果回灌后的续写 |
| 工具开始 | 一步之内可能只跑一个长工具，期间没有 step 边界 |
| 工具结束 | 同上，且标志阻塞解除 |

瞬态回合（蓝图等）也刷新——刻意放在 `job.ephemeral` 早退之前：瞬态回合卡死与私聊卡死是同一种故障，不该因为不落盘就失去看护。

#### 二、工具的合法长跑必须被排除，否则看护会误杀

这是 P3 最容易做错的地方。缺省停滞阈值 600s，而 `run_command` 的合法上限正好是 600s——**任何一次跑满的命令都会被判死**。所以：

- `Tool` 接口新增可选 `timeoutMs`：工具自报「我最多阻塞多久」；
- `ToolExecutionContext.onToolActivity(callId, tool | null)`：执行前后上报，worker 按 callId 记账；
- 判定阈值 = `max(stallThresholdMs, activeTool.timeoutMs + TOOL_GRACE_MS)`，宽限 60s 留给超时后的收尾（杀进程组、拼结果、落盘）。

**按 callId 记账而非单槽位**：一批工具调用是 `Promise.all` 并发跑的，单槽位会被后启动的覆盖——「一个 600s 的 run_command 在跑」这个事实会被同批一个 30s 的 bash 抹掉，然后按 30s 判死。取最大值而非最新值，保守方向才对。

**未声明 `timeoutMs` 的工具不享受放宽**：它没承诺过执行时长，看护没有依据放宽。已声明的有 `bash`（30s）、`run_command`（600s）、`web_search`（10s）、`dispatch_subagent` / `_batch`（前台 300s）、MCP 包装（按 server 配置的 `callTimeoutMs`）。`generate_image` 刻意不声明——它的生成请求本身没有超时，正是看护该抓到的那类。

#### 三、中断入口：与用户取消共用一条 signal

`processQueue` 为每个 turn 建一只内部 `AbortController`，与 `job.signal` 经 `AbortSignal.any` 合并成 `turnSignal`。`abortCurrentTurn("watchdog")` 动的是内部那只，合并信号的 reason 取自先 abort 的一方，因此归因准确。

**这里修掉一个 P3 自身引入的 bug**：catch 块原本判 `job.signal?.aborted` 决定终帧带不带 `aborted.reason`。看门狗动的是内部 controller，`job.signal` 始终未 abort——结果是**中断确实发生了，但终帧不带原因**：前端把「被判卡死」显示成「正常说完」，日志里也看不出是看护干的。改为统一判 `turnSignal`。这个 bug 由 `agent-worker.test.ts` 的「turn 在跑时有心跳」用例抓出，没有它就会静默上线。

#### 四、插件与可观测面

| 文件 | 内容 |
|---|---|
| `plugins/watchdog/index.ts` | 新增第 23 个内部插件。`inject: ["agents", "config"]`；`ctx.effect` 挂定时器（`unref` 不阻进程退出、摘插件即停扫）；首轮扫描在挂载时立即发起 |
| `config/repository.ts` | `AppSettings.watchdog?`：`enabled` / `stallThresholdMs` / `scanIntervalMs`，全部可选，老配置无需迁移 |
| `api/routes/system.ts` | `GET /system/watchdog`：返回 `{ enabled, scanIntervalMs, stallThresholdMs, turns[] }`，每条含 `idleMs` 与**当前生效阈值**，一读就知道离判定还有多久 |
| `core/agent-worker.ts` | `getHeartbeat()`（返回副本，防外部改到 `lastActivityAt` 让看护静默失效）、`abortCurrentTurn()`、`agentId` 只读访问器、心跳生命周期 |
| `bootstrap.ts` | 挂载位在 agents 之后、http 之前 |

**为什么不让 http 插件 `inject: ["watchdog"]`**：cordis 对未 inject 的服务访问即抛，inject 后 http 会硬依赖本插件——摘掉 watchdog 会让 http 永远 PENDING、整个 engine 起不来，与「可整体摘除」的设计承诺相悖。改为 config 回调（`onProvide` / `getWatchdog`），摘除后 http 拿到 `undefined`，端点如实报告 `enabled: false` 而不是 404——404 会让调用方把「没装看护」误读成「接口不存在」。

**配置归一**：`stallThresholdMs` 传 0 / 负数 / NaN 一律回缺省（600s），绝不让一个非法值把看护关成「永不触发」；`scanIntervalMs` 钳在 5s 以上。

#### 五、验证

- `tests/core/agent-worker.test.ts`「看护心跳」5 例：空闲无心跳、运行中有心跳且中断后清空（终帧 `reason="watchdog"`）、工具期间登记自报上限、未声明也登记、并发取最长上限
- `tests/plugins/watchdog.test.ts` 8 例：超阈值中断、阈值内不动手、工具放宽生效、工具上限已过照常中断、`enabled=false` 不扫描、无在途 turn 不参与、快照字段与生效阈值、非法配置回缺省
- `tests/api/system-info.test.ts` +2 例：未装配时 `enabled=false`（非 404）、装配时透传快照

#### 六、边界与已知限制

- **abort 打不断正在执行的工具**：`ToolContext` 没有 signal，工具无法感知取消。看护中断后，长跑工具仍会跑到自己返回为止，`turn.end` 要等到那时。真正的兜底是工具自己的 `timeoutMs`，看护的作用是「不再无限等」而非「立即掐断」。
- **只判「有没有动」，不判「动得对不对」**：方向偏了但每步都在推进的 turn 不会被发现。这是 §3.1 明确的非目标（P4 语义审查）。
- 阈值是全局的，不按 agent 分别配置。

---

## 五、验收标准

按项目「验收三件套 lint / typecheck / test 打底」+ 本单特有：

1. **挂死自愈**：mock provider 返回响应头后永不出 chunk → 断言在 `streamIdleTimeoutMs` 后 abort、`turn.end` 带 `aborted.reason="timeout"`、worker 回 idle、队列中的后续 job 被处理；
2. **retire 不再永久挂**：provider 挂死 + 触发 `retire()` → 断言 `getOrCreate` 在超时后返回新 worker（直接针对 `worker-registry.ts:18-21` 那条风险）；
3. **不误杀长回答**：正常流式生成持续 5 分钟、每 10s 一个 chunk → 断言**不**被中断（验证是空闲超时而非总时长）；
4. **不变量保持**：中断后热存储中不存在半截 step；`topic-state.json` 的开放话题与前一刻一致；
5. **终帧契约**：前端收到 `aborted` 后气泡标「已中断」且已显示文本不丢；
6. **总开关**：`watchdog.enabled=false` 时行为与现状**逐字节等价**（可回归验证）。

---

## 六、开放问题（需决策）

1. **`ProviderConfig.requestTimeout` 语义切换的兼容策略**：该字段现被三处当「总时长」用（chat 的 SDK `timeout`、responses/anthropic 的 `AbortSignal.timeout`、连接测试）。方案 A：字段语义改为**空闲超时**，连接测试另用固定总超时；方案 B：保留原语义，新增 `streamIdleTimeout` 字段，两者并存。**建议 A**——「请求超时」在流式场景的自然含义本就是「多久没响应」，且能顺带解决「未配置即无超时」的缺省问题，不必新增字段；代价是已配置该值的用户会感知到行为变化（从总时长变空闲），需在设置页加说明。B 更保守，但会留下两个近义字段，长期维护成本更高。
2. **空闲超时是否可重试**：建议不可重试（已产出的流重试会重复输出），但这意味着长文生成中途断流会整体失败。是否需要「从断点续写」能力？建议本期不做，登记待办。
3. **工具执行是否也纳入看护**：当前 bash 30s / run_command ≤600s 已有超时，但工具执行期间 turn 心跳同样不刷新。是否把「工具执行中」视为合法停滞（不 abort）？建议视为合法（工具自己有时限），但需在实现时显式排除，否则长命令会误触 L1。
4. **多连接场景**：同一 agent 可能同时有 WS 私聊 + 感知回合排队。中断时是否要区分「中断谁」？现有队列是 FIFO 单 in-flight，实际只有 runningJob 一个目标，但 `chainId` 代数校验需同步（沿用 handoff 仲裁面口径）。

---

## 七、待办（本期不做）

- L3 语义审查（模型判断是否偏离目标）；
- 中断后自动重试一次；
- 断流续写；
- 前端「后台任务状态」面板（与异步工具执行方案共用，见下）；
- 跨进程守护（无云端形态，不适用）。

---

## 八、与异步工具执行方案的关系

两份方案撞在同一片代码上，实施顺序有耦合：

- 看护（本文）需要把 `AbortSignal` **真正接到 fetch**；
- 异步工具执行（另一份）需要把长命令从 `await` 改成 `start()/stop()`，落点复用 `enqueueSystemNotice`。

**建议先做本文（P1+P2），再做异步工具。** 理由：异步工具会把「一个 turn 里存在后台执行中的东西」变成常态，若此时还没有可靠的中断语义，挂死面会扩大而不是缩小。看护先行，是异步工具的前置。
