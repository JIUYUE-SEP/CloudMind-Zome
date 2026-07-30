# kimi-code 四大功能迁移 CMZ 实施计划

> 依据：`docs/reviews/2026-07-29-kimi-code-migration-assessment.md`（迁移形式/耦合度/落点均出自该报告，行号证据在其中）。
> 执行方式：每阶段一个 Kimi 任务包，走五道工序（实现 → vivi 亲验 → 独立 review → 修复 → 复验）+ 验收三件套（lint/typecheck/test）。

**Goal:** 把 kimi-code 的 MCP 自愈机制、子 Agent 纪律与韧性、Swarm 批量调度、Skill 工具化分阶段迁入 CMZ，prompt 资产零成本先行。

**Architecture:** 适配移植为主——只搬低耦合机制层（纯函数/普通类），不引入 kimi 的 DI/wire/eventBus 底座；服务层按 CMZ 的 bootstrap 函数式组装重写。

**Tech Stack:** TypeScript / Fastify / vitest / zod；复用 CMZ 现有 DocumentStore、provider/classify.ts 错误分类、SubagentDispatcher。

---

## 阶段 0：纪律 prompt 资产吸收（0.5 天，P0，立即）

**Objective:** 三份纯文本纪律 prompt 进 CMZ 工具描述，与代码零耦合，当天见效。

**Files:**
- Modify: `services/engine/src/tools/builtin/dispatch_subagent.ts`（工具描述）
- Modify: `services/engine/src/skills/loader.ts` 或其 prompt 组装处（skill 注入纪律）
- Test: `services/engine/tests/tools/`（工具描述快照断言，如已有此类测试则更新）

**内容：**
1. `dispatch_subagent` 工具描述迁移 `agent.md` 七条纪律：
   - 委派纪律四条：当同事简报（零上下文，给全已知信息）/ 查找类给确切路径或命令 / 调查类给问题不给步骤 / 不委派理解（关键路径自己先找到）
   - 反委派三条：琐事不委派（委派有上下文交接成本）/ 不并行重做子 agent 的工作 / 不中途抛弃手动收尾
   - 结果可见性：subagent 产出对调用者可见，用户要看由你转述
2. skill 注入区迁移 `skill.md` 复用纪律：同 name 同 args 已加载过的 skill 不重复调用，直接遵循已加载内容
3. 预留 `agent-swarm.md` 批次纪律文案（阶段 3 工具落地时进描述）：一响应一批、items≥2、模板含 `{{item}}`、展开后 prompt 互异

**验证:** `pnpm --filter @mindcloud/engine exec vitest run tests/tools` 通过；lint/typecheck 零错误。

**Commit:** `docs(engine): 迁移 kimi 委派/skill 纪律 prompt 资产进工具描述`

---

## 阶段 1：MCP 包 2 — 自愈机制迁移（2-3 天，P0）

**Objective:** server 崩溃自愈 + 调用侧封顶一次重试 + tool-naming 直搬，替代原包 2 的熔断器方案（采纳 kimi「封顶一次」哲学）。

**Files:**
- Create: `services/engine/src/tools/mcp/naming.ts`（直搬 kimi `agent/mcp/tool-naming.ts`，27 行零依赖：字符白名单 + 下划线折叠 + 64 字符封顶 FNV-1a 哈希后缀）
- Modify: `services/engine/src/tools/mcp/wrapper.ts`（sanitizeMcpName 换用 naming.ts，保留 `mcp__` 前缀；execute 加调用侧自愈）
- Modify: `services/engine/src/tools/mcp/client-manager.ts`（补 single-flight reconnect + attemptId 代际戳防竞态；意外断开保留工具注册语义）
- Modify: `services/engine/src/tools/mcp/types.ts`（server 配置加 `callTimeoutMs`）
- Test: `services/engine/tests/tools/mcp/`（新增 self-heal.test.ts、naming.test.ts）
- Docs: README MCP 行、路线图「### MCP」节与第二节加固项行

**关键实现要点（证据见评估报告一章）：**
1. **调用侧自愈（wrapper.execute）**：失败分类——服务器已应答的错误直接抛；歧义错误先 5s ping 探活（任何应答含 MethodNotFound 都算活），活着原地重试一次；传输已死则 single-flight 重连后重试一次。**每次调用重连封顶一次**；429 判定复用 `provider/classify.ts`
2. **single-flight 重连（client-manager）**：同名重连合并（inFlight map），attemptId 代际戳——旧尝试迟到完成不覆盖新状态；engine close() 后置 disposed 不再重连
3. **断线保注册**：bootstrap 快照注入天然符合，文档明确「server 掉了工具不消失，调用降级为失败而非 tool not found」
4. **审批覆盖（toolOverrides）**：按原计划做（评估确认 CMZ 的 fail-closed 比 kimi 严，保留）；`allowRemember` 查询通道接 WS handler

**TDD 顺序：**
1. naming.test.ts：白名单/折叠/64 封顶哈希/空名拒绝 → 搬 naming.ts → 绿
2. self-heal.test.ts：可崩溃 fixture server——断开后下次调用触发自愈恢复 / ping 活原地重试 / 重连封顶一次 / 关停期不重连
3. toolOverrides 优先级测试（沿用原包 2 设计：免审批覆盖、强制审批、allowRemember 放行与默认禁止）

**验证:** engine 全量 test/lint/typecheck 三件套；fake server 崩溃→自愈 e2e。

**Commit:** `feat(engine): MCP 包2 自愈——断线保注册/single-flight 重连/调用封顶一次重试/tool-naming 直搬/审批覆盖`

---

## 阶段 2：子 Agent 韧性批次 — 持久化 + lost 语义（2-3 天，P1）

**Objective:** 后台任务表持久化，重启不蒸发，僵尸任务精确标 lost。

**Files:**
- Modify: `services/engine/src/subagent/background.ts`（任务表接 DocumentStore）
- Create: `services/engine/src/subagent/task-persist.ts`（参考 kimi `agent/task/persist.ts` 写 ~30 行 DocumentStore 适配）
- Modify: `services/engine/src/subagent/types.ts`（状态机加 `lost`）
- Modify: `services/engine/src/bootstrap.ts`（启动 reconcile：running → lost）
- Test: `services/engine/tests/subagent/`

**关键实现要点：**
- 状态机 `running → completed|failed|timed_out|killed|lost`；重启后 running 一律标 **lost**（比 failed 精确：不知死活而非已知失败）
- 输出双轨：内存 preview（截断）+ 全量落盘 `output.log` 供翻页（REST 读取）
- 通知三键幂等可简化（CMZ 无 undo/compaction 对账复杂度）：building/delivered 两键 + 重启 reconcile 补投

**验证:** 三件套 + 重启恢复测试（任务跑到一半换进程视角 → lost）。

**Commit:** `feat(engine): subagent 后台任务持久化——重启 lost 语义/输出双轨落盘`

---

## 阶段 3：Swarm — AgentRunBatch 换核接入（2-3 天，P1）

**Objective:** 批量并发派发落地，用 kimi 的 653 行纯调度器换掉 42 行骨架内核。

**Files:**
- Create: `services/engine/src/subagent/agent-run-batch.ts`（直搬 kimi `session/swarm/agentRunBatch.ts`：`isProviderRateLimitError` 换 `provider/classify.ts` 429 判定；retry npm 包换 ~20 行自实现退避）
- Modify: `services/engine/src/subagent/batch.ts`（保留对外形状，内部委托 AgentRunBatch；Launcher 四回调接 dispatcher）
- Create: `services/engine/src/tools/builtin/dispatch_subagent_batch.ts`（模板 + items 校验 ≥2/去重/上限 16（桌面场景调小，kimi 128）；结果 `<agent_swarm_result>` XML 渲染直搬；批次纪律文案进描述）
- Test: `services/engine/tests/subagent/agent-run-batch.test.ts`（fake provider 限流场景）

**关键实现要点：**
- burst-then-throttle 启动坡道（先 5 连发，后每 700ms 放一个）
- 限流任务 unshift 回队头**续跑非重开**；容量衰减（每 2s 减 1 下限 1，3 分钟恢复 +1）；最后一个任务不重排直接 failed
- 部分失败不拖死整批，结果按下标原位聚合
- 批次排他：CMZ ReActLoop 顺序执行工具天然满足，无需 veto，但纪律文案进工具描述

**验证:** 三件套 + 限流自适应 fake provider 测试 + 16 并发 e2e。

**Commit:** `feat(engine): dispatch_subagent_batch——AgentRunBatch 调度核/限流自适应/结果聚合`

---

## 阶段 4：子 Agent resume + 完成通知注入（2-3 天，P1-P2）

**Objective:** 失败/超时 subagent 可续跑（保留上下文），后台完成通知进父会话。

**Files:**
- Modify: `services/engine/src/tools/builtin/dispatch_subagent.ts`（`resume` 参数）
- Modify: `services/engine/src/subagent/dispatcher.ts` + `background.ts`
- 通知注入：向父会话消息队列 push 合成 user 消息（复用群聊消息通道；CMZ 无 loop StepRequest 体系，从简）
- **坑预警**（评估报告原话）：kimi 的 resume 跨重启无自动重物化路径（get miss 不 create）——CMZ 直接做 get miss → create-by-id fallback

**Commit:** `feat(engine): subagent resume 续跑 + 后台完成通知注入父会话`

---

## 阶段 5：Skill 工具化（一期 0.5 天 → 二期 3-4 天，P2）

**一期（可提前插入任何间隙）：** system prompt 的 skill section 改清单格式（name + 截 250 字 description + whenToUse + 来源分组优先级 Project > User > Extra > Built-in），全文注入暂保留。

**二期（公共 Skill 池落地前）：** 完整工具化——搬 `registry.ts` 参数展开（`$ARGUMENTS` tokenize + XML 转义 + 无占位符兜底）与块渲染为 `skills/catalog.ts`；新增 `Skill` 内置工具；ReActLoop 工具结果类型加 `delivery?: { kind: "steer"; message }` 注入当前 turn；嵌套深度显式传参（kimi 的播种机制生产未接线，CMZ 不做隐式）。

---

## 独立轨道（不在本迁移序列）

- **Intermind + Agent 私信**：灵魂功能，kimi-code 无参考（它是单 agent CLI）。需与指挥官先做设计讨论（人形自主发起对话的边界、隐私隔离），再排期
- **记忆审计接口（Phase 4）**、**Provider 用量统计聚合**（drift 审计登记的 stub）：小项，间隙穿插

## 风险与开放问题

1. **agentRunBatch.ts 直搬的接口适配**：653 行调度器依赖 Launcher 四方法抽象，CMZ dispatcher 的 spawn/retry 语义需逐一对齐（尤其 AbortSignal 贯穿度）——阶段 3 开工时先花半天做接口映射表
2. **通知注入与群聊通道复用**：阶段 4 的通知消息会不会触发父 agent 的不必要回复循环？设计讨论时定「通知消息不触发 LLM 回合、仅入上下文」还是「触发轻量回合」
3. **工具数量膨胀与 L6 预算**：MCP server + swarm + 更多内置工具加入后，L6-ext 裁剪从预留变刚需——阶段 3 后评估是否提前
4. **每阶段完成后更新路线图与 README**（维护规则），drift 审计报告作为修订基准

## 执行顺序总览

```
阶段 0（0.5d）→ 阶段 1（2-3d）→ 阶段 2（2-3d）→ 阶段 3（2-3d）→ 阶段 4（2-3d）
                                                          ↘ 阶段 5 一期（0.5d，任意间隙）
Intermind 设计讨论（指挥官时间允许时并行启动，不占 Kimi 通道）
```
