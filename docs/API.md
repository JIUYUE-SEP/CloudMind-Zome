# CloudMind Zome Engine API

Engine 默认监听 `http://127.0.0.1:8848`（可用 `PORT` 环境变量修改）。所有端点**无前缀**（直接挂在根路径下）。

## 鉴权

除 `GET /health` 与 `/ws/*`（WebSocket 握手经 `Sec-WebSocket-Protocol` 携带 token）外，**所有 REST 端点（含 `/docs`）**都要求 `Authorization: Bearer <token>`：

- token 为 32 字节随机值，自动生成并落盘 `DATA_DIR/auth-token`（权限 0600）；可用环境变量 `CLOUDMIND_AUTH_TOKEN` 覆盖。文件读取失败或内容损坏会显式报错，绝不静默重建覆盖
- 未携带或错误 token 返回 `401`；比较为常量时间
- 浏览器直开 Swagger UI 会因缺 token 得到 401——前端 dev 模式下 Nuxt dev server 经 `/api/engine-token` 自动下发 token，无需手动配置

## OpenAPI / Swagger

启动 engine 后访问：

```
http://127.0.0.1:8848/docs
```

Swagger UI 包含所有 REST 端点的摘要、标签和参数说明，可用于在线调试。

## 主要端点

### Health

- `GET /health` — 健康检查，返回 `{ "status": "ok" }`

### Agents

- `GET /agents` — 列出所有 Agent
- `POST /agents` — 创建 Agent（**重复 id 返回 409**，不静默覆盖现有配置）
- `GET /agents/:id` — 获取 Agent
- `PUT /agents/:id` — 更新 Agent（**合并语义**：未传字段保留原值；显式清空传空数组/空串。2026-08-01 前为整体覆盖，部分更新会丢失未传字段）
- `DELETE /agents/:id` — 删除 Agent

**Agent 配置项（`AgentConfig`，创建/更新时可传的可选字段）**：

| 字段 | 类型 | 缺省 | 说明 |
|---|---|---|---|
| `maxContextTokens` | number | 80000 | 上下文窗口总预算（32k/128k 窗口模型应显式配置） |
| `reactMaxSteps` | number | 100 | ReAct 循环单轮最大步数（防空转保险丝，越界 clamp 1-500）；上下文水位为主判据，撞顶后强制一次无工具总结兜底，绝不静默 |
| `compressionModel` | string | 主模型 | 话题压缩模型；压缩失败不 fallback 主模型 |
| `topicBoundaryModel` | string | compressionModel → 主模型 | 话题边界 LLM 裁判/压缩前复核模型（方案 C）：每攒 6 轮异步语义判切，压缩前复核拆分 |
| `topicDetectionWindowMinutes` | number | 30 | 话题检测时间窗（分钟），超过视为新话题 |
| `topicMessageThreshold` | number | 20 | 当前话题消息数达到该值即关闭并压缩 |
| `semanticSearchEnabled` | boolean | true | 语义检索（L4）开关，同时门控检索与 embed 索引 |
| `semanticTopK` | number | 10 | L4 注入条数上限 |
| `semanticMinScore` | number | 0 | L4 最低相关度（相似度 × 时间衰减，0-1） |
| `trustAllTools` | boolean | false | 全部信任开关：开启后该 agent 有审批通道时所有工具自动批准（含不可免问五工具），每次自动放行写审计事件 `trusted-auto-approve`；无审批通道仍 fail-closed |

> 非法取值由引擎归一并 warn：`topicMessageThreshold < 4` clamp 到 4；`semanticTopK < 1` 重置为默认值 10。ID 仅允许 `[a-zA-Z0-9_-]{1,64}`。

### Files（agent 工作区文件，只读）

- `GET /agents/:id/files/*` — 读取 agent 工作区 `files/` 子树内的单个文件（generate_image 落盘产物经此供 web 取图）。仅 GET；全局 Bearer 鉴权与其他 REST 端点同口径。
  - 路径：`*` 为 `files/` 下的相对路径；resolve 后必须仍在 `files/` 子树内，`..` 穿越返回 **400**。
  - 错误码：非法 agent id **400**；agent 不存在 **404**；文件不存在 **404**；目标是目录（不列目录）**400**；扩展名不在白名单 **415**。
  - content-type 按扩展名白名单映射：`.png → image/png`、`.jpg/.jpeg → image/jpeg`、`.webp → image/webp`、`.gif → image/gif`；响应带 content-length，读流回包。
  - 浏览器侧经 nuxt 代理 `GET /api/agent-file?agentId=..&path=..` 访问（img 标签无法带 Authorization header；token 只留服务端）。

### Chat

- `GET /chat/:agentId/messages?sessionId=xxx&limit=xxx&before=xxx` — 获取用户可见完整历史（`sessionId` 必填）：热存储与话题压缩归档合并、按时间序返回；`before` 为消息 id 游标，支持跨归档/热存储边界翻页。话题压缩只收她的上下文，聊天记录不因压缩消失
- WebSocket `GET /ws/:agentId?sessionId=xxx` — 与单个 Agent 实时对话（sessionId 缺省 `default`）

### Sessions（群聊）

- `GET /sessions` — 列出所有会话
- `POST /sessions` — 创建群聊会话
- `GET /sessions/:id` — 获取会话
- `PUT /sessions/:id` — 更新会话
- `DELETE /sessions/:id` — 删除会话
- `GET /sessions/:id/messages?limit=xxx&before=xxx` — 获取会话历史消息（合并各成员仓库：按消息 id 去重，assistant/tool 消息带 `agentId` 归属标注，`limit` 为合并后总量；limit clamp 缺省 100、上限 500，非法值回落缺省；`before` 为消息 id 游标，跨成员透传 + 合并后按时间序截取游标之前一页，可翻进归档层；未知游标按无游标处理）
- WebSocket `GET /ws/sessions/:sessionId` — 群聊实时对话

### Compute

- `GET /compute/providers` — 列出 Provider
- `POST /compute/providers` — 创建 Provider（`models` 数组逐型号走白名单校验；**重复 id 返回 409**）
- `PUT /compute/providers/:id` — 更新 Provider（改 baseUrl/apiKey/apiMode/超时后，引用它的 worker 会被退役重建，下一次调用即生效）
- `DELETE /compute/providers/:id` — 删除 Provider（引用它的 worker 一并退役；删除后相关 agent 报"Provider 不存在"明确错误，不会回落旧快照）
- `POST /compute/providers/:id/test` — 测试 Provider 连接
- `GET /compute/usage` — 获取用量统计。实时扫描 `DATA_DIR/agents/*/llm_calls.jsonl`（逐行流式读，无 100MB 上限；不缓存）。响应骨架 `{ dates, tokens, byAgent }`：`dates: [{ date, promptTokens, completionTokens, calls, errorCalls }]`（`date` 为本地时区 `YYYY-MM-DD`）、`tokens: [{ provider, model, promptTokens, completionTokens, calls }]`（provider+model 联合键，缺省 provider 记 `"unknown"`）、`byAgent: [{ agentId, promptTokens, completionTokens, calls }]`。仅统计 token 用量，不折算费用；token 为 0 的历史记录照常计入调用数
- `POST /compute/providers/:id/models` — 为 Provider 添加模型（字段同 `buildModelFromBody` 白名单校验；型号 id 已存在返回 409）
- `PUT /compute/providers/:id/models/:modelId` — 更新模型（`id` 不可改；`apiMode` 接受三族值，传 `null` 表示显式清除型号级覆盖、回退 provider 级）
- `DELETE /compute/providers/:id/models/:modelId` — 删除模型

> 三个型号端点（POST/PUT/DELETE）在配置保存成功后同样退役引用该 provider 的全部 worker（与 provider 级 PUT/DELETE 同语义），首个型号级 `apiMode` 覆盖保存后下一次调用即生效，无需重启。

**Provider 配置字段（`ProviderConfig`）**：

| 字段 | 类型 | 缺省 | 说明 |
|---|---|---|---|
| `displayName` | string | — | Provider 显示名 |
| `baseUrl` | string | — | API 根地址（禁内网/文件协议） |
| `apiKey` | string | — | 落盘 AES-256-GCM 加密，API 返回脱敏为 `"***"` |
| `models` | ModelInfo[] | `[]` | 模型列表 |
| `requestTimeout` | number | SDK/网络默认 | 单请求超时（ms），透传协议适配器 |
| `maxRetries` | number | 2 | 同一 Provider 失败重试次数（resilient 层） |
| `apiMode` | `"responses" \| "anthropic" \| "chat_completions"` | `chat_completions` | 协议族选择（2026-08-08）：responses 与 anthropic 为主路，chat 为兼容层；POST/PUT 校验三值，非法值 400 |

**型号字段（`ModelInfo`，POST/PUT 模型与 POST Provider 的 `models` 数组同口径校验）**：

| 字段 | 类型 | 缺省 | 说明 |
|---|---|---|---|
| `id` | string | — | 型号 id（必填，trim 后非空；PUT 时只能由路径决定，body 中改 id 返回 400） |
| `displayName` | string | modelId | 显示名（提供了就必须非空） |
| `modelType` | `"llm" \| "embedding" \| "image" \| "stt"` | — | 型号类型白名单，非法值 400 |
| `contextWindow` | number | — | 可选正整数（上下文窗口，驱动水位 W 与 pipeline 预算） |
| `maxOutputTokens` | number | — | 可选正整数 |
| `supportsReasoning` / `supportsToolCalling` / `supportsMultimodal` | boolean | — | 能力标记，可选 |
| `apiMode` | `"responses" \| "anthropic" \| "chat_completions"` | provider 级 | 型号级协议覆盖（2026-08-10 B 方案）：缺省 = 沿用 `ProviderConfig.apiMode`；`null` 仅 PUT 模型时用于显式清除覆盖 |

> `apiMode=responses`：POST `{baseURL}/responses`（input items / SSE 终态事件携带 usage）；
> `apiMode=anthropic`：POST `{baseURL}/anthropic/v1/messages`（DeepSeek Anthropic 兼容端点，
> baseUrl 以 `/anthropic` 或 `/anthropic/v1` 结尾时不重复拼接）；
> `apiMode=chat_completions`（缺省）：OpenAI Chat Completions 兼容层，行为与迁移前一致。
> 型号级覆盖经 `ModelApiModeRouter` 按 `(providerId, effectiveApiMode)` 选路：型号无覆盖 → provider 级 → chat_completions；型号表 PUT 后下一次调用即走新协议（活配置 + config.json mtime/size 短缓存热更），无需重启。

### Handoffs（换班移交）

上下文水位撞顶（90%）时本轮不静默死亡，而是产出 `[交接书]` system 消息并进入**自动续跑**（换班移交，见架构文档 §4.3）。以下 REST 端点读写控制面 `handoff-state.json`：

- `GET /handoff?agentId=xxx&sessionId=xxx` — 列出换班移交记录（过滤条件可选；按 updatedAt 升序）。每条返回：`{ id, agentId, sessionId, reason, status, shift, maxShifts, bookMessageId, bookText, used, window, createdAt, updatedAt, resumeJobId?, abortReason?, chainId? }`——`status` 为 `pending | scheduled | running | completed | aborted | fused | lost`；`chainId` 为链代际标记（随 record 持久化，重启后闩锁/对账仍可追溯）；`bookText` 在 list 端点为**摘要**（截 500 字符 + `bookTextTruncated` 标记），全文经 `GET /handoff/:id/book` 按需读取
- `GET /handoff/:id/book` — 读取单条记录的交接书全文（未知 id 返回 404）
- `DELETE /handoff/:id` — 手动打断自动续跑（与用户消息打断同语义，`abortReason=manual`）：先经 `HandoffLoopRegistry` 仲裁面取消该 agent+session 维度**全部连接的续跑 loop**（清定时器 + abort 在途 job，含 running 期），再落控制面 `aborted`；无活跃 loop 时由 `manager.abort` 兜底。记录不存在返回 404；终态条目原样返回（不转移状态）

> 续跑状态变化同时通过 WS 帧 `handoff.update` 推送给私聊连接（见下）。

### Config

- `GET /config` — 获取系统设置（凭据脱敏为 `"***"`）
- `PUT /config` — 更新系统设置
- `GET /config/tools` — 列出内置工具

### 内置工具（agent 白名单授权）

内置工具经 `agentConfig.tools` 白名单显式授权后可用（`GET /config/tools` 返回完整清单）；傀儡上下文、蓝图等无审批/无记忆场景按工具各自 fail-closed。

- `read_file` / `list_files` — 读文件、列目录（免审批）
- `write_file` / `edit_file` / `bash` / `run_command` — 写类/执行操作（需人工审批；`run_command`/`write_file`/`edit_file` 不可本会话免问）
- `dispatch_subagent` / `dispatch_subagent_batch` — 派发子任务/swarm 批量傀儡（需人工审批）
- `skill` — 按名取技能规程正文（免审批）
- `web_search` — Tavily 联网搜索（需人工审批，可本会话免问）
- `generate_image` — 生图（需人工审批，可本会话免问）：型号链 `imageProviderId`/`imageModelId` 配置 → 工具参数 `model` 临时覆盖 → 缺省回落 dall-e-3；provider 返回 url 下载落盘 `files/images/`（15s 超时 / 20MB 上限 / png·jpeg·webp·gif 白名单），返回 data 直接写盘；下载失败回退 `persisted:false + sourceUrl`；未配置 imageProviderId 的 agent 调用返回配置指引错误
- `load_tool` — 按需工具取回（免审批）：按限定名取回 `mcp__`/`ext__` 动态工具的完整描述 + parameters JSON Schema 并注入后续步骤（session 粘性 LRU 16 取回序）；原子 fail-closed——未知名返错误+可用名录、内置名返「已常驻无需取回」，任一非法整体不生效
- `send_private_message` — Intermind 人形间私信（免审批、审计留痕；傀儡不可用）
- `read_private_messages` — Intermind 读全文（免审批；傀儡不可用）
- `recall` — 回忆工具（上阁楼）：`action=topics` 浏览压缩档目录、`action=read` 按 `topicId`/`query` 取归档原文（分页 + 翻页指引，单条/总输出截断护栏；免审批、需白名单授权、傀儡硬禁；归档原文不经 L4 自动注入）

### Blueprints

- `GET /blueprints` — 列出 Blueprint
- `POST /blueprints` — 创建 Blueprint
- `GET /blueprints/:id` — 获取 Blueprint
- `PUT /blueprints/:id` — 更新 Blueprint
- `DELETE /blueprints/:id` — 删除 Blueprint
- `POST /blueprints/:id/execute` — 执行 Blueprint

### Scheduler

- `GET /scheduler/:agentId` — 列出 Agent 的定时任务
- `POST /scheduler/:agentId` — 创建定时任务
- `PUT /scheduler/:agentId/:taskId` — 更新任务
- `DELETE /scheduler/:agentId/:taskId` — 删除任务

### Plans

- `POST /agents/:agentId/plans` — 创建计划
- `GET /agents/:agentId/plans` — 列出计划
- `GET /agents/:agentId/plans/:planId` — 获取计划
- `POST /agents/:agentId/plans/:planId/run` — 执行
- `POST /agents/:agentId/plans/:planId/pause` — 暂停
- `POST /agents/:agentId/plans/:planId/resume` — 恢复
- `POST /agents/:agentId/plans/:planId/retry` — 重试指定步骤

> 计划经 `plans.jsonl` 持久化，engine 重启自动恢复（重启时 running 的步骤标回 pending 可续跑）。

### Subagents

- `GET /subagents/background` — 列出后台子代理任务
- `GET /subagents/background/:taskId` — 查询单个后台任务
- `GET /subagents/background/:taskId/output?agentId=<parentAgentId>` — 读取任务全量输出（超 10MB 返回 413；缺 agentId 返回 400，非 owner 按不存在返回 404 不泄露归属）
- `POST /agents/:agentId/subagents/:taskId/resume` — 续跑终态任务（completed/failed/lost）：同简报重跑、复用原记录（taskId 不变、attempts+1）；running 拒绝 409，非 owner 404
- `GET /puppet-models` — 列出 Puppet 型号（内置 + 自定义），每项 `{ name, description, personaSnippet, suggestedTools?, source }`，`source` 为 `builtin` / `custom`；自定义走 `DATA_DIR/puppet-models/*.json`（同名覆盖内置），第一版只读

> 子代理通过 `dispatch_subagent` / `dispatch_subagent_batch` 工具创建，无 REST 创建端点。任务持久化于 `subagent-tasks.jsonl`（engine 重启时 running 标 `lost`，不自动续跑）；列表/详情中 `output` 为截尾 preview（超 ~4KB，`outputTruncated` 标记），全量走 output 端点；`kind` 区分 `delegate`（借用人形）/ `puppet`（傀儡分身）。
> `dispatch_subagent` 的 `kind=puppet` 可选 `puppetModel`（型号名）：persona 片段拼入傀儡基础设定，`suggestedTools` 对傀儡工具集做交集窄化（只窄化不扩权；交集为空或型号不存在返回明确错误）。

### Intermind（人形间私信）

- `GET /agents/:id/intermind` — 列出该 Agent 的 intermind 会话：`[{ peer, lastMessageAt, count }]`（对端、最后消息时间、条数，按最后时间倒序）
- `GET /agents/:id/intermind/:peerId/messages?limit=&before=` — 分页读取与对端的来往消息（消息带 `agentId` 发送方归属；limit 默认 100、上限 200，before 为消息 id 游标）

> 私信经 `send_private_message` 工具发送（免审批但需 agent 白名单授权；傀儡上下文不可用）。会话空间按对端一个会话（`intermind:<peerId>`），邮箱对称双写——接收方来信线程与发送方来往线程各持全量往来；信到触发接收方感知回合，感知回合内回信搭车（只入队不再次唤醒）。感知通知只带 200 字摘要，内容被截断时通知追加读全文指引，agent 可用 `read_private_messages` 工具（参数 `from: {senderId}`，免审批、需白名单授权、傀儡不可用）从 `intermind:<from>` 会话读取完整来往信件（含方向/时间/全文；对端无会话返回空列表）。设计文档：`docs/design/intermind.md`。

### Memory

- `GET /memory/:agentId?limit=xxx&offset=xxx` — 列出 Agent 的记忆（limit clamp 缺省 100、上限 500，非法值回落缺省；offset 非法回落 undefined）
- `GET /memory/:agentId/:id` — 获取单条记忆

### Topics（压缩档审计，2026-08-19 Phase 4）

- `GET /agents/:id/topics?limit=xxx&offset=xxx` — 压缩档列表（`compressedAt` 倒序；每条含 topicId/label/importance/sourceId/sourceName/compressedAt/msgCount；损坏档跳过、高版本档 500）
- `GET /agents/:id/topics/:topicId` — 单档全文（frontmatter 各字段 + summary + keyPoints + msgIds；档不存在 404）
- `POST /agents/:id/topics/:topicId/restore` — 恢复即删档：该档消息从归档写回热存储（已在热存储的 id 跳过、归档缺行计数 missing、全缺 409 不动档），随后删除压缩档并重新索引原文向量（恢复后原文回 L3/L4、L5 不再注入该摘要）；返回 `{ restored, missing }`；重复 restore 404

### System / Plugins（2026-08-19 前端完善轮）

- `GET /system/info` — 引擎系统信息：`{ version, gitCommit?, dataDir, port, uptimeSec, sidecar: { configured } }`（gitCommit 无 git 时省略；configured 只表示引擎装配了 sidecar 客户端，不代表 sidecar 在跑）
- `GET /plugins` — 外部插件加载结果：`{ loaded: string[], skipped: { name, reason }[], perAgent: { agentId, name, status }[] }`（reason/status 取值见 `plugins/external/index.ts` 的 SkipReason 契约）

**Plugins 管理面（2026-08-21 M1/M2）**：

- `GET /plugins/manifest` — 全局清单管理视图：`{ plugins: [{ name, enabled, config, hasEntry: true }], unregistered: string[] }`（unregistered = 目录有 index.mjs 但未登记入全局清单的名字；清单文件损坏返回 409 不覆盖）
- `PUT /plugins/manifest/:name` — 单条写：body `{ enabled?: boolean, config?: object }`（至少一个；config 必须 JSON 对象非数组非标量）。未登记→登记；返回 `{ name, enabled, config, requiresRestart: true }`（**无热重载**：变更重启 engine 生效）。非法名/类型错 400、目录不存在 404、清单损坏 409
- `GET /agents/:id/plugins/manifest` — 该 agent 的 plugins.yml 内容：`{ plugins: [{ name, enabled, config }] }`（文件缺失按空清单；agent 不存在 404）
- `PUT /agents/:id/plugins/manifest/:name` — 同全局单条语义写回 plugins.yml（js-yaml dump 会重写排版并丢弃手写注释——语义保留）

### Actions

- `GET /actions/:agentId?limit=xxx&offset=xxx` — 列出 Agent 的动作记录（limit clamp 缺省 100、上限 500，非法值回落缺省；offset 非法回落 undefined）

### Skills

- `GET /skills` — 列出可用 Skill
- `POST /agents/:agentId/skills/reload` — 热重载 Agent 技能目录（清解析缓存 + worker 退役重建，改完 SKILL.md 无需重启）
- `GET /agents/:agentId/skill-history?limit=N` — Skill 工具调用记录（默认 50，上限 200，倒序）

### Logs

- `GET /logs` — 查询 engine 内存环形缓冲中的日志

## WebSocket 协议

**Client → Server**：

| 帧 | 说明 |
|---|---|
| `{ "text": "..." }` | 聊天消息（无 type 字段，最长 10000 字符） |
| `tool.approval` | 审批回执（`approvalId` / `approved` / `remember`；`run_command` / `write_file` / `edit_file` / `dispatch_subagent` / `dispatch_subagent_batch` 不可 remember） |
未知 type 帧静默忽略。

**Server → Client**：

| 帧 | 说明 |
|---|---|
| `text.delta` / `thinking.delta` | 流式正文 / 推理内容（群聊帧带 `agentId`） |
| `tool.call` / `tool.result` | 工具调用与执行结果（群聊帧带 `agentId`） |
| `step.end` | ReAct 单步结束（每个 step 都发，tool_use 时循环继续） |
| `turn.end` | 一轮生成结束（ReAct 循环退出；前端在此复位"生成中"状态） |
| `handoff.update` | 换班移交状态变化（`status` / `shift` / `maxShifts` / `bookMessageId?` / `reason?`，仅私聊连接推送，帧带 `agentId`） |
| `tool.approval_request` | 审批请求（60s 未回复视为拒绝） |
| `error` | 错误 |

握手时校验 Origin（无 Origin 的非浏览器客户端放行；`NODE_ENV=e2e` 全放行）。

## 通用约定

- 所有 REST 响应均为 JSON。
- 删除操作成功返回 `204 No Content`（例外：`DELETE /handoff/:id` 返回 `200` + 记录摘要——它需要把打断后的状态回传给调用方）。
- 资源不存在返回 `404 Not Found`。
- 资源冲突（重复 id 等）返回 `409 Conflict`。
- 参数校验失败返回 `400 Bad Request`。
- 实现细节见 `services/engine/src/api/routes/` 与 `services/engine/src/api/ws/`。
