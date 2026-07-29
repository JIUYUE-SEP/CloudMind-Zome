# Spike 001: MCP 接入可行性验证

## 问题与假设

- **问题**：MindCloud-Zome 路线图规划接入 MCP。官方 TypeScript SDK 能否在 engine（Node + Fastify）场景下完成「连接 server → 列工具 → 调用工具」全链路？MCP tool 的 schema/annotations 能否映射到 engine 现有的 Tool 接口与审批模型？
- **假设**：① stdio 方式可稳定 spawn 本地 MCP server；② `inputSchema`（JSON Schema）可转换到 engine 的 zod `parameters`；③ `ToolAnnotations` 足够支撑 engine 的「只读免审批 / 写类需 WS 人工审批」策略。
- **目录约束**：所有产出在 `spikes/001-mcp-integration/` 内，独立成包（自带 `pnpm-workspace.yaml` 隔断 workspace 根），不改 engine 主代码。

## 环境

- Node: **v24.15.0**（engine 目标 Node 22，spike 未验证 22，但 SDK 无高版本特性依赖）
- pnpm: 10.33.0
- **@modelcontextprotocol/sdk: 1.30.0**
- server: **@modelcontextprotocol/server-everything 2026.7.4**（npm 包，server 自报 `mcp-servers/everything@2.0.0`）
- zod: 3.25.76（SDK 内部用 zod v4 core API，3.25.x 已内置兼容层，共存无冲突）
- 平台：Windows 11 + Git Bash

## 方法

1. **server**：优先官方示例 `npx -y @modelcontextprotocol/server-everything`（stdio）；另自写 `src/server-local.ts`（SDK `McpServer` 高级 API，read_file/delete_file 两个带完整 annotations 的工具）作离线兜底与注解演示。
2. **client**：`src/demo-client.ts` 用 SDK `Client` + `StdioClientTransport` spawn server 子进程，connect 后 `listTools()` 打印每个工具的 annotations 原文，`callTool()` 实际调用只读工具并打印返回。
3. **schema 转换**：`src/convert.ts` 实现 `mcpToolToEngineSpec()`（name/description/inputSchema/annotations → engine `Tool` 规格），`jsonSchemaToZod()` 做最小 JSON Schema → zod 映射；`src/convert.test.ts` 用 `node:assert` 断言审批映射与 zod 行为。

复现：

```bash
cd spikes/001-mcp-integration
pnpm install
pnpm demo         # 官方 server-everything
pnpm demo:local   # 本地自写 server
pnpm test         # 转换断言
```

## 结果

官方 server-everything 一次真实运行的输出节选：

```
=== 连接成功 ===
server info: {"name":"mcp-servers/everything","title":"Everything Reference Server","version":"2.0.0"}
instructions: # Everything Server – Server Instructions ...（完整 instructions 原文）

=== listTools（含 annotations 原文）===
共 13 个工具

- echo
  description: Echoes back the input string
  annotations: {"readOnlyHint":true,"destructiveHint":false,"idempotentHint":true,"openWorldHint":false}
  inputSchema.required: ["message"]
- gzip-file-as-resource
  annotations: {"readOnlyHint":false,"destructiveHint":false,"idempotentHint":true,"openWorldHint":true}
- toggle-simulated-logging
  annotations: {"readOnlyHint":false,"destructiveHint":false,"idempotentHint":false,"openWorldHint":false}
...（共 13 个，含 get-sum / get-tiny-image / simulate-research-query 等）

=== callTool: echo ===
{
  "content": [{ "type": "text", "text": "Echo: hello from CMZ spike" }]
}
```

本地 server 模式同样跑通：`read_file` 经 MCP 真实读取并返回了 `package.json` 全文。转换断言 `convert.test.ts: 全部断言通过 ✔`（5 组：只读免审批、required 校验、破坏性需审批+禁 remember、无 annotations fail-closed、枚举/数组/整数转换）。

### annotations → 审批映射调研

SDK 1.30.0 的 `ToolAnnotations` 全部字段（`types.d.ts` 中 `ToolAnnotationsSchema`，均可选）：

| 字段 | 语义 | 映射建议（结合 engine 审批模型） |
|---|---|---|
| `title` | 人类可读显示名 | 审批弹窗显示名，不影响决策 |
| `readOnlyHint` | true=不改变环境 | **true → 免审批**（对应 engine 无 `requiresApproval` 的只读工具） |
| `destructiveHint` | true=可能破坏性修改（仅在 readOnlyHint=false 时有意义） | **true → 需审批 + 禁止「本会话免问」**（对应 engine `NO_REMEMBER_TOOLS`） |
| `idempotentHint` | 重复调用无额外副作用 | 不改审批结论，可用于 UI 提示 |
| `openWorldHint` | true=与开放世界交互（如网络），false=封闭域（如本地文件） | 不改审批结论；用于粗填 `accesses[].resource`，正式接入需人工确认 |

关键规则（fail-closed，已在 `mapAnnotationsToApproval()` 实现）：

- `readOnlyHint === true` → 免审批；**其余一切情况（false 或缺失）→ 需审批**——annotations 全部可选，缺失是常态，必须默认危险。
- 非明确只读的 MCP 工具一律 `noRemember`（禁止「本会话免问」）——第三方 server 的注解不可信，remember 白名单应由 CMZ 配置而非 server 自报决定。
- annotations 只是 **hint**（spec 明确"不保证准确"），正式接入应支持按 server/工具名的本地配置覆盖。

另发现：SDK 1.30 的 Tool 还有 `execution.taskSupport`（`optional|required|forbidden`），标识工具是否支持 task 化长运行，未来可对接 engine 的异步任务。

## 坑

1. **【最大坑，Windows 特有】`StdioClientTransport` spawn `npx` 直接失败**：SDK 内部 `spawn(command, args, { shell: false })`，而 Windows 上 `npx` 是 `npx.cmd` 批处理 shim，无 shell 无法执行。解法：`command: "cmd.exe", args: ["/c", "npx", ...]`，或 spawn `node` 真实 exe 直接跑 server 入口 JS。任何「让用户配置 MCP server 命令」的功能在 Windows 都必须处理 `.cmd`/`.bat` shim 问题。
2. **pnpm 污染 workspace 根**：spike 目录内 `pnpm add` 会向上找到 monorepo 根并改写根 `pnpm-lock.yaml`。解法：spike 内放 `pnpm-workspace.yaml`（`packages: []`）自立门户。（已还原根 lockfile。）
3. **stdio server 不能 `console.log`**：stdout 是协议通道，server 侧调试输出必须走 stderr（demo 中 `stderr: "inherit"` 透传，server-everything 的 `Starting default (STDIO) server...` 即 stderr 输出）。
4. **annotations 缺失是常态**：官方 everything server 13 个工具全部带注解是「模范生」，生态里大量 server 不提供 annotations，映射策略必须以缺失为默认分支。
5. **小坑**：`pnpm init` 生成的 package.json 需手动设 `"type": "module"`（SDK 是纯 ESM）；`zod` 我装的 3.25.x 与 SDK 内部的 zod v4 core 共存无碍，但 engine 侧若锁死 zod 3 老版本需注意。

## Verdict: VALIDATED

最小链路（连接 → 列工具含 annotations → 调用只读工具 → 拿到真实返回）在官方 server 与自写 server 上均真实跑通；schema 转换与审批映射有可运行的断言支撑；SDK API 稳定、类型完整，未遇到阻塞性问题。

## 对正式接入的建议

### 传输层选型：stdio 为主，Streamable HTTP 为辅

CMZ 是**桌面单用户**场景，结论：

- **首选 stdio**：MCP server 天然以「本地命令」分发（npx/uvx），stdio 是最广兼容的接入方式；子进程生命周期随 engine 管理，无端口占用、无网络面、无鉴权问题，天然单租户。跨平台问题集中在 Windows 的 spawn shim（坑 #1），一次性封装即可解决。
- **Streamable HTTP 作为可选远程扩展**：仅在用户显式配置远程 server（如公司内部共享 server）时启用；它引入鉴权（OAuth）、会话管理、网络可靠性等复杂度，不应进入首版。**注意 SSE 传输已被 Streamable HTTP 取代（spec 2025-03-26 起），新代码不要基于旧 SSE 实现。**
- child process 管理要点：引擎退出时统一 kill 子进程树（Windows 无进程组信号，需 `taskkill /T` 或 tree-kill 类封装）、崩溃自动重启、stderr 转发到 engine 日志。

### 接入点

- 新增 `services/engine/src/tools/mcp/` 模块：`McpClientManager`（按配置 spawn/连接 server、维护 Client 池）+ `mcpToolToEngine()`（把每个 MCP tool 包装成 engine `Tool` 接口，`execute` 内转发 `client.callTool`）。
- 包装后的 Tool 走 `bootstrap.ts` 现有工具数组注入 agent-worker，**审批通道（WS 帧 + remember + 审计）自动生效，无需改协议**。
- `parameters`：spike 的最小 jsonSchemaToZod 够用，正式版建议引入成熟转换（如 `@n8n/json-schema-to-zod`）或放宽 `Tool.parameters` 类型接受 JSON Schema 直存。

### 预估工作量

| 项 | 估时 |
|---|---|
| McpClientManager（spawn/生命周期/重连/Windows shim 封装） | 2 天 |
| 工具包装 + schema 转换（含边界 schema 处理） | 1.5 天 |
| annotations→审批映射落地 + 本地配置覆盖 + NO_REMEMBER 接入 | 1 天 |
| 配置面（用户 MCP server 配置格式、UI 展示） | 1 天 |
| 测试（集成测试用 InMemoryTransport + 真实 stdio e2e） | 1.5 天 |
| **合计** | **约 7 人日（首版仅 stdio）** |
| Streamable HTTP + OAuth（二期） | +3~4 人日 |

### 风险清单

- **annotations 不可信**：第三方 server 可谎报 readOnlyHint；本地配置覆盖与白名单是必需项，不是增强项。
- **Windows 进程管理**：`.cmd` shim、进程树杀不干净会导致端口/句柄泄漏，需要专门的封装与测试。
- **schema 转换边界**：JSON Schema 的 `oneOf`/`anyOf`/`$ref`/format 等超出最小映射范围，需选型成熟库或降级为 `z.unknown()` + 服务端校验。
- **server 质量参差**：超时、不响应、协议不完整的 server 需要统一的超时与熔断策略。
- **SDK 版本演进快**：1.x 仍在快速迭代（如本次新发现的 `execution.taskSupport`），升级需回归测试。
