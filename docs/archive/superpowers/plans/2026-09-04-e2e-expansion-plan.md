# e2e 扩护甲实施计划（2 → 8 例）

- 日期：2026-09-04
- 范围：`tests/e2e/` 扩例 + e2e 限定注入端点（引擎，NODE_ENV=e2e 限定注册）
- 阶段 0 侦察结论（已定案）：MockLLMProvider 支持 tool call（`provider/llm.ts:38-48` setNextToolCalls），但仅进程内可调——需 e2e 限定端点注入；纯 UI 流场景（群聊/编辑器/设置页）无此依赖。

## 决策（不翻案）

1. **注入端点**：`POST /e2e/mock/tool-calls`（body `{ toolCalls: [{ toolCallId, name, arguments }] }`）——**仅 `NODE_ENV=e2e` 注册**（生产构建路径零存在，路由注册处环境判定）；非 e2e 环境 404。调用当前 agent worker 的 Mock provider setNextToolCalls（无 worker/非 Mock 时 fail-closed 明确错误）。
2. 新用例全部经 `scripts/start-e2e.mjs` 既有链路（Playwright webServer 自动起）；选择器优先 `data-testid`（无则在断言可维护处补 data-testid 到组件——夹带需申报）。
3. 每例独立 agent（前缀区分）防互相污染；严守 fileParallelism:false 同套纪律。

## 场景清单（8 例 = 既有 2 + 新增 6）

| # | 场景 | 依赖 |
|---|------|------|
| 1-2 | 既有：建 agent 发消息 / 日志面板 | — |
| 3 | 群聊：建 a/b 两 agent，群聊会话发消息 @a，断言 a 回 b 不回（或全员回复口径按现状），消息分帧正确 | 无 |
| 4 | agent 编辑器：改 persona 字段保存 → 重开页面断言持久 | 无 |
| 5 | 设置子页面 /settings/tools：三清单渲染、builtin「常驻」徽标、无动态工具空态 | 无 |
| 6 | 审批流：注入 `run_command` tool call → 审批卡片出现（60s 倒计时）→ 批准 → 工具执行结果帧、卡片状态翻转 done | 注入端点 |
| 7 | 生图工具卡：注入 `generate_image` tool call → 批准 → Mock 图落盘 → 工具卡 img（src 含 /api/agent-file）渲染；**注：为当初搁置的生图 e2e 翻案** | 注入端点 |
| 8 | 单/多模式：切单 → 选择器选人直达私聊 → 刷新保持（localStorage 持久） | 无 |

## 任务（1 个实现子代理）

1. 引擎：`api/routes/e2e-mock.ts`（新）+ 注册（NODE_ENV=e2e 判定，见 server.ts 注册区先例）+ 单测（e2e 注册/非 e2e 404/注入成功/非 Mock fail-closed）。
2. e2e 用例 3-8（`tests/e2e/` 每场景一文件或按域聚合），含必要的 testid 补齐（申报）。
3. 全量 `pnpm test:e2e` 绿（8/8）+ `pnpm verify` 绿。

**验收：** 8/8 e2e 绿（真实运行，非 skip）；注入端点生产环境 404（单测钉）；verify 全绿。

## 评审与销记

独立 review（端点生产零面/用例非假绿/选择器纪律）→ 主控终审 → 全量闸 → 销记（路线图工程节 e2e 数字刷新 + 导览如提及）→ 提交 push。
