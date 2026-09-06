# 前端全面检查报告（第二轮）

生成时间：2026-07-21
范围：apps/web 全部页面、组件、stores、路由、API 封装、全局样式（对照 services/engine 两侧源码核实）

## 背景

距上次全面排查（07-18）之后的前端改动：

- 流式输出 UI（打字机 + 思考折叠 + 工具卡片）
- `/agents` 列表页拆分（列表/新建/编辑三页分离，共享 `AgentEditor`）
- 返回按钮固定路径（`BackButton` 必传 `to`，移除 `router.back()`）
- 文档全面重写

基线：57 个单元测试、`nuxt typecheck`、eslint 全部通过。本报告问题均在测试覆盖之外。所有 P0/P1/P2 条目已对照前端与 engine 两侧源码逐条复核；P3 中标注「存疑」的条目触发面低或未实际复现。

## 问题统计

| 级别 | 数量 | 定义 |
|------|------|------|
| P0 | 3 | 功能实际坏掉 |
| P1 | 4 | 用户必踩 / 数据丢失风险 |
| P2 | 5 | 体验硬伤 |
| P3 | 2 + 35 | 边界缺陷与工程债 |

---

## 一、P0：功能实际坏掉

### P0-1 群聊多 Agent 并发流交错进同一气泡，无发言人归属

- 位置：`apps/web/composables/useEngineClient.ts:527`、`apps/web/pages/hub.vue:207-249`、`apps/web/pages/sessions/[id].vue:89-131`；engine 侧 `services/engine/src/api/ws/session-handler.ts:216`、`services/engine/src/conductor/conductor.ts:22`
- 说明：engine 群聊每帧都带 `agentId`，且不 @任何人时默认广播全体成员并发回复；前端 `onTextDelta` 只取 `data.delta`，`agentId` 在 composable 边界被丢弃，hub/sessions 两处 handler 都是「凡 delta 拼到最后一条流式消息」。两个 Agent 的 token 逐字交错进同一气泡，任一 Agent 的 `step.end` 还会提前封口。另 `DisplayMessage`（`useChatRecords.ts:13-21`）无 `agentId` 字段，群聊气泡本就不显示发言人
- 建议：回调透出 `agentId`，群聊按 agentId 维护独立流式消息槽；历史归属需 engine 持久化补字段（跨端改动）

### P0-2 群聊历史中用户消息按成员数重复渲染，`v-for` key 撞车

- 位置：`services/engine/src/api/ws/session-handler.ts:168-177`、`services/engine/src/api/routes/sessions.ts:77-84` → 前端 `apps/web/composables/useChatRecords.ts:30`、`apps/web/components/GroupChatView.vue:13`
- 说明：engine 把同一条用户消息（同一 id）写进每个成员的仓库，历史接口直接合并不去重。N 人群聊刷新后每条用户消息渲染 N 次，且 N 份共享 `:key="msg.id"`，后续流式 push 触发错误的 DOM 复用
- 建议：前端 `recordsToDisplay` 按 id 去重可缓解；根治需改 engine 存储模型（用户消息会话级存一份）

### P0-3 快速切换 Agent/会话时，后返回的历史加载覆盖当前消息

- 位置：`apps/web/stores/chat.ts:25-28`、`apps/web/components/ChatView.vue:52-68`、`apps/web/pages/hub.vue:172-180`
- 说明：`loadMessages` 在 store 内部直接赋值 `messages.value`；`connectSeq`/`groupSelectSeq` 守卫只挡 `connect` 挡不住这个回写。A→B 快速切换时 A 的迟到响应把 B 的历史整个冲掉，此后 B 的流式 delta 拼到 A 的消息上。代码注释声称防的就是这个竞态，但只防了一半
- 建议：loader 改为返回 records、由调用方在 seq 校验通过后赋值；或 store 内维护请求代际 token

---

## 二、P1：用户必踩 / 数据丢失风险

### P1-1 名称/代号输入框逐键 trim，打不出含空格的名字

- 位置：`apps/web/components/agent-edit/AgentEditBasic.vue:56-59`
- 说明：每次 input 事件都对 name/codename 做 `trim()` 并经 `:value` 回写，输入 "My Agent" 时空格被实时吃掉，最终只得 "MyAgent"
- 建议：input 阶段不 trim，保存校验前统一 trim（顺带解决「纯空格名字通过非空校验」）

### P1-2 编辑页数据加载完成前表单可编辑，空表单覆盖保存丢数据

- 位置：`apps/web/components/agent-edit/AgentEditor.vue:86-88, 116-121`
- 说明：`agentForm` 初始为空壳，`agents.load()` 异步进行，模板无加载门控。用户在 load 返回前输入一个字，`formDirty` 置位挡住后续 sync，此时保存会把近乎全空的配置整体 PUT，`persona`/`skills`/`tools` 等服务端原有值被清空。engine 响应慢时真实可触发
- 建议：`loadDone` 为 false 时禁用表单（fieldset disabled 或加载遮罩），`save()` 开头对非新建场景检查 `loadDone`

### P1-3 Agent ID 无前端格式校验，错误语义被 fetch 层压成状态码

- 位置：`apps/web/components/agent-edit/AgentEditor.vue:132`、`apps/web/composables/useEngineClient.ts:189`；engine 侧 `services/engine/src/api/routes/agents.ts:23`
- 说明：engine 强制 ID 为 `/^[a-zA-Z0-9_-]{1,64}$/`，前端只查非空；client 丢弃 400 响应体里的 `{error}` 消息，用户只看到 "Failed to create agent: 400"。同类：scheduler 非法 cron 的 400（`scheduler.ts:34-36`）、compute 测试连接的 502（`compute.ts:157`），后端精心返回的错误体全部到不了用户眼前
- 建议：client 在 `!res.ok` 时尝试解析响应 body 的 `error` 字段拼入错误消息；前端对 ID/cron 做预校验并给中文提示

### P1-4 `step.end` 被当成「一轮生成结束」，工具执行期间输入框错误解锁

- 位置：`apps/web/stores/chat.ts:84-90`、`apps/web/pages/hub.vue:243-249`、`apps/web/pages/sessions/[id].vue:125-131`；engine 侧 `services/engine/src/provider/llm.ts:108`、`services/engine/src/core/react/step.ts:46`
- 说明：engine 每个 ReAct step 末尾都发 `step.end`，`tool_use` 时循环继续；前端每个都复位 `isStreaming`。后果：工具执行期间输入框错误解锁、状态栏在「生成中/已连接」间闪烁、工具徽章在「执行中/已完成/等待审批」间来回跳（`MessageBubble.vue:91-93` 的兜底逻辑放大此问题）
- 建议：engine 增加 turn 级结束帧（如 `turn.end`），前端只在 turn 结束 / error / close 时复位（跨端改动）

---

## 三、P2：体验硬伤

### P2-1 蓝图执行跑的是「服务端已保存版本」，画布未保存修改被静默忽略

- 位置：`apps/web/pages/blueprints/[id].vue:94-105`；engine 侧 `services/engine/src/api/routes/blueprints.ts:61-63`
- 说明：画布改了节点/连线没点保存就点执行，跑的是旧版本，UI 无任何提示；画布局部「执行」按钮在 120s 执行期间也无视觉反馈
- 建议：执行前自动保存一次（或检测 dirty 提示「将执行已保存版本」），running 态传入画布禁用执行按钮

### P2-2 compute「测试连接」30 秒无任何进行中反馈

- 位置：`apps/web/pages/compute.vue:164-171`（`useEngineClient.ts:297` 显式放宽到 30s）
- 说明：点击后无 spinner、按钮不禁用；`testResult` 是单一全局值，连点两个 Provider 的测试，先返回的结果被后返回的静默覆盖
- 建议：加 `testingId` ref，按钮按 provider 禁用并显示「测试中...」，结果与 providerId 绑定

### P2-3 `updateModel`/`deleteModel` 的 modelId 未 URL 编码，含 `/` 的模型 ID 直接 404

- 位置：`apps/web/composables/useEngineClient.ts:313, 323`（同组 providerId 也未编码：`:281, 291, 297, 303`）
- 说明：`openai/gpt-4o` 这类 OpenRouter 风格模型 ID 含斜杠是常态，未 `encodeURIComponent` 时 URL 多出一级路径段，Fastify 匹配不到路由。engine 端会自动 decode，补上即可
- 建议：所有路径段统一 `encodeURIComponent`

### P2-4 LogPanel 缺卸载清理，离开后全页面无法选中文字

- 位置：`apps/web/components/LogPanel.vue:148-151`（全文件无 `onBeforeUnmount`）
- 说明：拖拽时注册 document 级 `mousemove/mouseup` 并设 `body.style.userSelect = "none"`，拖拽中途离开主页则监听泄漏、`userSelect: none` 永久残留 body。另两个面板（`WallpaperPanel.vue:208-212`、`SystemSettingsPanel.vue:234-239`）都有兜底，这块是漏的
- 建议：照抄另两个面板的 `onBeforeUnmount` 清理

### P2-5 self-image / user-profile 底部内容被 56px 底栏遮挡

- 位置：`apps/web/pages/self-image.vue:142-146`（`.si-body` padding 20px）、`apps/web/pages/user-profile.vue:151-158`（`.up-body` padding 24px）
- 说明：两页根容器 `inset: 0`，底栏高 56px 固定压底，滚动到底时末尾内容约 36px 永久被半透明底栏盖住。其他页面均预留 56~80px，这两页是漏网（07-18 时即存在，非本轮回归）
- 建议：底部 padding 补到 ≥76px

---

## 四、P3：边界缺陷与工程债

### P3-Major 级（边界场景的真 bug）

**P3-1 WS 干净关闭时，流式气泡永远卡在「生成中」**
`apps/web/stores/chat.ts:107-110`：`onClose` 不复位最后一条消息的 `isStreaming`（`onError` 有这段，`onClose` 漏了），光标永闪 + 打字机 rAF 空转至卸载。engine 重启/优雅关闭发生在生成中时触发。

**P3-2 审批回执发送失败 → 审批卡片永久死态**
`apps/web/components/ApprovalCard.vue:83-87` 的 `responded` 闩锁在 emit 前同步置位；store 发送失败只提示「请重试」（`chat.ts:150-153`），但闩锁已置位按钮永远点不动，且断连时 engine 侧不会回 `tool.result`，卡片永停「等待审批」。

### P3-Minor（流式/聊天）

- 打字机追平后 rAF 仍 60fps 空转：`apps/web/components/MessageBubble.vue:67-73`（tick 无条件再调度）
- 实时工具结果不上屏，与历史渲染不一致：`apps/web/stores/chat.ts:75-79`（历史侧 `role:"tool"` 渲染成灰色气泡，同段对话刷新前后样貌不同）
- 工具卡片出现时不触发自动滚动：`apps/web/components/ChatView.vue:71-82`、`GroupChatView.vue:70-81`（watch 源不含 toolCalls）
- `ApprovalCard` 参数为 `undefined` 时 computed 抛错（存疑）：`apps/web/components/ApprovalCard.vue:56-64`（`JSON.stringify(undefined)` 返回 undefined，`json.length` TypeError）
- 旧 socket 迟发帧与新连接无代际隔离（存疑）：`apps/web/stores/chat.ts:30-111`（关闭握手完成前旧 handler 仍可写共享 messages）
- 三处消息 handler（store/hub/[id]）逐行雷同，应收敛为一个按 agentId 路由的 composable（P0-1 修复时一并处理）

### P3-Minor（agents 模块）

- notFound 状态下保存/删除按钮仍可点击：`apps/web/components/agent-edit/AgentEditor.vue:8-13, 20-21`
- 编辑页 load 失败静默显示空表单（无错误分支、无重试）：`AgentEditor.vue:82-84`
- 路由跳转拼接未 `encodeURIComponent`（防御性缺口）：`apps/web/pages/agents/index.vue:86`、`AgentEditor.vue:142`、`apps/web/pages/hub.vue:37`
- 列表页刷新失败掩盖已有数据且无重试入口：`apps/web/pages/agents/index.vue:16`
- 已勾选但 engine 已下架的工具不可见、无法取消：`apps/web/components/agent-edit/AgentEditTools.vue:6-18`
- 新建保存成功后未用 `replace`，后退可回到新建表单重复提交：`AgentEditor.vue:142`
- `formDirty` 在 `agentId` prop 切换时不复位（当前无直达触发路径，隐患）：`AgentEditor.vue:88, 121`
- store 的 `currentId`/`select`/`current` 是拆分残留死代码：`apps/web/stores/agents.ts:9, 41, 44-48`
- 遗留 `model` 字段与 `modelId` 不同步（存疑，读取侧均 modelId 优先）：`apps/web/components/agent-edit/AgentEditModel.vue:102-111`

### P3-Minor（其余页面）

- sessions/[id] 列表加载失败零错误展示、历史加载失败被静默吞：`apps/web/pages/sessions/[id].vue:59, 63-67`（hub 同类失败会上屏，口径不一）
- sessions/[id] 路由参数变化不触发重载（存疑，当前无详情直达详情入口）：`sessions/[id].vue:43, 54-69`
- settings 数字输入清空后空字符串随 save 入库：`apps/web/pages/settings.vue:20-33`、`apps/web/components/SystemSettingsPanel.vue:43-56`（engine `config.ts:25` 不做类型校验）
- compute 模型 id 不查重（`:key` 撞车）、`testProvider` 返回的 `discovered` 列表被丢弃：`apps/web/pages/compute.vue:173-184, 49`
- 加载中态口径不统一（多处 isLoading 期间只渲染空白）：`apps/web/pages/sessions/index.vue:27-28`、`compute.vue:9-10`、`hub.vue:42, 60`
- blueprints/[id] 初始加载无 loading 态、「已保存」不随再次编辑清除：`apps/web/pages/blueprints/[id].vue:10-23, 85`
- BlueprintCanvas 节点删除无确认无撤销、tool 参数 JSON 失败静默置 `{}`：`apps/web/components/BlueprintCanvas.vue:184-191, 164-168`
- self-image 保存失败谎报「已保存」：`apps/web/stores/self-image.ts:50-58` 吞错 + `self-image.vue:84-87` 无条件置态（对照 user-profile 实现是正确的）
- sessions/index 未按 type 过滤会话（存疑，intermind 类型暂无 UI 入口）：`apps/web/pages/sessions/index.vue:30`（hub.vue:134 有过滤）
- 蓝图 120s 超时文案误导，且前端 abort 不取消 engine 侧执行：`apps/web/utils/fetch.ts:16`、`useEngineClient.ts:503-509`
- 原生 confirm/alert 在 Tauri macOS WKWebView 下可能不弹（存疑，取决于目标平台）：`compute.vue:156, 160`、`scheduler.vue:124`、`blueprints/index.vue:57`、`WallpaperPanel.vue:128, 144, 156`

### P3-Minor（API 封装）

- `updateSession`/`updateProvider` 类型签名承诺了 engine 静默丢弃的字段：`useEngineClient.ts:240, 280`（engine `sessions.ts:51-52` 只应用 name/agentIds，`compute.ts:106-124` 只应用 displayName/baseUrl/apiKey）
- baseUrl 尾部斜杠未归一，配置以 `/` 结尾时全部路由 404：`useEngineClient.ts:178` 起所有拼接
- sessions/scheduler/blueprints 的 id 未 `encodeURIComponent`（口径不一，目前为 UUID 无实际风险）：`useEngineClient.ts:241, 251, 258, 382, 392, 483-505`
- `fetchWithTimeout` 会静默覆盖调用方自带 signal；超时只覆盖到响应头、body 读取阶段无保护：`apps/web/utils/fetch.ts:13`
- 非超时网络错误（`TypeError: Failed to fetch`）未包装成中文提示，与超时路径体验割裂：`apps/web/utils/fetch.ts:14-18`
- `testProvider` 返回类型含永远不会出现的 `error` 字段（失败路径是 502）：`useEngineClient.ts:295`
- WS `onClose` 不透传 code/reason（engine 用 4001/4002/4003/4004/4403 携带具体原因）：`useEngineClient.ts:439, 557`
- `setMode` 依赖 `this`，解构调用即丢失：`useEngineClient.ts:457, 575`
- 私聊 `connect()` 的 `session.mode_changed` 分支是死代码（只有群聊 handler 发该帧）：`useEngineClient.ts:426-428`
- `getSessionMessages` 的 limit 是 per-agent 语义（N 个 agent 最多返回 N×limit）：`useEngineClient.ts:255` 对照 `sessions.ts:78-82`
- `ScheduledTask` 类型缺 `createdAt`/`updatedAt`；create 的 Omit 允许传 engine 会忽略的 `lastRunAt`/`nextRunAt`：`useEngineClient.ts:59-68`

### P3-Minor（样式）

- `BlueprintCanvas.vue:296-426` 几乎复制整套色板（#0b0f17/#d8e1ec/#00e5c9 等字面量）
- 危险红有两套：`--mc-danger: #ef4444`（main.css:9）vs 散落的 `#ff5c5c`（`blueprints/index.vue:126`、`scheduler.vue:255`、`BlueprintCanvas.vue:426`），同屏删除按钮颜色不一致
- `rgba(255,255,255,…)` 共 90 处 / 30 个文件未收口（alpha 0.04~0.12 不等，无法统一调整）
- 注：CSS 变量本身干净——使用中的 `--mc-*` 共 10 个，与 `:root` 定义 10/10 对应，无「用了未定义」

### P3-Minor（Tauri / 配置）

- `get_backend_url` 为动态端口预留的间接层：端口一旦动态化，首屏请求可能先于 invoke resolve 打向默认端口：`useEngineClient.ts:144-175`（当前 sidecar 固定 8848，无害）
- Tauri 检测成功但 invoke 失败时，`NUXT_PUBLIC_ENGINE_URL` 永远不会被应用（存疑，是否故意）：`useEngineClient.ts:171`
- `nuxt.config.ts:7` 顶层（私有）`engineUrl` 无消费者，仅 `public.engineUrl` 生效，可删

---

## 五、确认无问题的项

- **路由**：pages/ 实际路由表与全部 `navigateTo`/`router.push`/`NuxtLink`/`BackButton` 目标比对，无死链，无旧 `/agents/:id`（不带 /edit）残留；BackButton 12 处调用点全部显式传 `to` 且均为逻辑父页
- **前后端契约**：七组 REST 路由（agents/sessions/compute/scheduler/blueprints/config/logs）URL/方法/字段与 engine 实现逐一对齐；WS 8 种帧类型（text.delta/thinking.delta/tool.call/tool.result/tool.approval_request/step.end/session.mode_changed/error）与 engine 发送端逐字比对无拼写偏差、无遗漏分发
- **布局**：`showBottomBar`（/agents/** 隐藏）与 `showRightNav`（仅 /）规则无误伤；z-index 层级（layout 100 < 悬浮钮 110 < 面板 120 < 弹窗 200）无冲突
- **状态管理**：agents store 的 create/update/remove 与 UI 一致；保存/删除连点有 `saving`/`deleting` 闩锁防护；scheduler `loadSeq`、hub `groupSelectSeq` 竞态防护在位（P0-3 是另一半缺口）
- **SSR/边界**：localStorage 读写有 JSON 校验兜底与 window 守卫；子组件 IME 合成态 Enter 处理在位

## 六、修复路线建议

1. **P0**（群聊流式归属 → 历史去重 → 切换竞态）：三者同源——群聊实现仍建立在「同一时刻只有一条流式消息」的私聊假设上。建议顺手把三份消息 handler 收敛成一个按 agentId 路由的 composable
2. **P1**（trim → 空表单覆盖 → ID 校验/错误透出 → step.end）：其中 P1-3 的错误透出（client 解析响应 body `error` 字段）一处改动可覆盖一串同类问题；P1-4 需 engine 补 turn 级帧
3. **P2**：均为独立小修，可直接批量排期
4. **P3**：随迭代顺手收敛；其中 P3-Minor（API 封装）的编码口径统一可与 P2-3 一次做完

**跨端依赖清单**（需 engine 配合）：P0-1 历史归属字段、P0-2 存储模型去重、P1-4 turn 级结束帧、P3 的 WS onClose code/reason 透传利用。
