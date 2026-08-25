# generate_image 生图工具落地计划（阶段 0 侦察 + 设计 + 分阶段实施）

- 日期：2026-08-25
- 范围：`services/engine`（工具/provider/路由）、`apps/web`（工具卡渲染 + 代理）、`packages/shared`（无改动，字段已齐）、`docs`
- 性质：中小特性。spec 合入本 plan（§设计前提即设计定案）；路线图"规划中"的 generate_image 工具由此单落地
- 方法：阶段 0 只读侦察由主控亲做（结论全部带 `文件:行`）；实现由子代理分阶段执行；每阶段独立子代理 review + 主控终审复核 diff；全量 `pnpm verify` + `pnpm test:e2e` 绿才销记
- 人力分工纪律（指挥官钦定）：主控（维克托）不写实现代码，只侦察、写 plan、派活、复核

**设计前提（已定决策，不翻案）：**

1. **型号从配置来，不硬编码**。链：`AgentConfig.imageModelId` → provider 默认型号；工具参数 `model` 可临时覆盖；都不给回落 `"dall-e-3"`。provider 由配置显式选定，`supportsModel` 不做名字白名单（配置即信任）；接口保留，未来第二协议族照 LLM 侧 `apiMode` 三族先例扩，第一版不臆造。
2. **审批**：`requiresApproval: true`（出网 + 计费，从严档）；不进 NO_REMEMBER 五高危名单——与 `web_search` 同档，允许「本会话免问」。
3. **结果落盘优先**：provider 返回 url 则下载到 `files/images/`（工作区子树，png/jpg 按 content-type）；返回 data（b64/data-url）则直接写盘。下载失败回退返回 url 并标注 `persisted: false`。下载超时 15s，体积上限 20MB。
4. **不引新依赖**：文件回包手写（读流 + content-type），不引 `@fastify/static`；真要引，回 plan 评审翻案。
5. **未配置 imageProviderId 的 Agent**：工具照常注册，调用返回明确配置指引错误（同 `web_search` 未配 tavilyApiKey 口径），不崩不静默。
6. **Mock 保 e2e**：`MockImageGenProvider` 同步支持型号透传（参数断言用）。
7. **文件服务最小面**：`GET /agents/:id/files/*` 只读、仅限 `files/` 子树、路径穿越防护、content-type 白名单（image/png、jpeg、webp、gif），不列目录。
8. **隐私口径沿用 §8.1**：prompt 进日志/落档一律截 500；响应正文不落日志。

---

## A. 阶段 0 侦察结论（现状真相）

### A1. 工具管线

- `Tool` 接口：`services/engine/src/tools/types.ts:52-60`（name / description / parameters(zod) / accesses / requiresApproval / execute）。
- 服务注入缝：`ToolServices`（`tools/types.ts:17-31`）——subagentDispatcher / skillService / configRepository 等已在此。**当前无 imageProvider 条目**。
- worker → ToolContext 透传点：`core/agent-worker.ts:892` `services: this.config.services`——**只透传 config.services，worker 自有的 imageProvider 没有合并进去**（断点 1）。
- 内置工具注册表：`tools/builtin/index.ts:16-32` `getBuiltinTools()`，当前 13 个。
- 模板：`tools/builtin/web-search.ts`——zod describe / services 守卫（`:150-153`）/ 结构化错误 / 截断纪律 / `requiresApproval: true`（`:141`）。
- 审批免问名单：`NO_REMEMBER_TOOLS` 五高危（write_file / edit_file / run_command / dispatch_subagent / dispatch_subagent_batch），generate_image 天然不在其列（`api/ws/handler.ts:243` 附近注释佐证机制）。

### A2. 生图 provider 现状

- 接口：`provider/types.ts:116-122` `ImageGenProvider`——`generate(prompt, options?: { size? }): Promise<{ url?; data? }>` + `supportsModel(model)`。**options 无 model 字段**（断点 2）。
- 实现：`provider/image-gen.ts:5-29` `OpenAIImageGenProvider`——`supportsModel` 只认 `dall-e*`（`:14`）、`generate()` 硬编码 `model: "dall-e-3"`（`:20`）（断点 3）。
- Mock：`image-gen.ts:31-39` `MockImageGenProvider` 返回 `{ url: "data:image/png;base64,mock" }`。
- 装配：`plugins/llm/index.ts:154-164` `createImage(agentConfig)`——e2e 或未配 `imageProviderId` 给 Mock；找到 provider 配置给 OpenAI 实现。**`agentConfig.imageModelId` 拿到后被丢弃**（断点 4）。
- worker 持有：`core/agent-worker.ts:147` `imageProvider?: ImageGenProvider` 选项已存在；`plugins/agents/index.ts:163` 已调 `createImage` 并传入 worker——**这条线活着，只是到不了工具**。

### A3. 配置面（已齐，零改动）

- `packages/shared/src/index.ts:19-20`：AgentConfig 已有 `imageProviderId?: string` 和 `imageModelId?: string`。
- REST 白名单：`api/routes/agents.ts:17` 两字段均在 `KNOWN_AGENT_FIELDS`；`FIELD_HINTS` 有 `image → imageProviderId` 提示（`:30`）。
- 既有测试：`tests/api/agents.test.ts:335,353` 已钉 `imageProviderId` 落盘回显。

### A4. 结果展示链

- web 工具卡：`apps/web/components/MessageBubble.vue:23-24` 按 `toolCalls`（`DisplayToolCall[]`）渲染工具卡；`ChatView.vue:23` 透传。
- **engine 当前无任何 agent 文件服务路由**（`api/routes/` 无 files.ts）——图片落盘后 web 拿不到，需新端点（决策 7）。
- 全局 REST Bearer 鉴权；浏览器侧 token 由 nuxt server 持有（`/api/engine-token` 开发通道）——**img 标签无法带 header**，故图片经 nuxt 代理转发（决策见 B 阶段 2）。

### A5. 测试模式

- 工具单测范式：`tests/tools/*.test.ts`（如 `tests/tools/write.test.ts`、`tests/tools/web-search*.test.ts` 风格：直接构造 tool.execute 的 ToolContext，Mock services）。
- Mock 环境：`NODE_ENV=e2e` 时 llm 全家走 Mock（`plugins/llm/index.ts:155`）。
- vitest forks + fileParallelism:false，新测试文件自动并入（`services/engine/vitest.config.ts`）。

---

## B. 阶段划分

### 阶段 1（引擎核心）——1 个实现子代理

**任务：**

1. `provider/types.ts`：`ImageGenProvider.generate` 的 options 增加 `model?: string`。
2. `provider/image-gen.ts`：
   - `OpenAIImageGenProvider` 构造接受 `defaultModel?: string`（缺省 `"dall-e-3"`）；`generate()` 用 `options?.model ?? this.defaultModel`，删硬编码；`supportsModel` 放宽为恒 true（配置即信任，注释写明决策 1）。
   - `MockImageGenProvider.generate` 签名同步接受 options（便于测试断言透传）。
3. `plugins/llm/index.ts` `createImage`：把 `agentConfig.imageModelId` 传入 `OpenAIImageGenProvider` 构造。
4. `tools/types.ts` `ToolServices` 增加 `imageProvider?: ImageGenProvider`。
5. `core/agent-worker.ts:892` 附近：ToolContext.services 合并 `{ ...this.config.services, imageProvider: this.config.imageProvider }`（this.config.services 优先还是 imageProvider 兜底——imageProvider 以 worker 自有为准，services 内不覆盖，注释说明）。
6. 新工具 `tools/builtin/generate_image.ts`（模板 web-search.ts）：
   - schema：`prompt`（min 1，max 4000）、`size`（enum 可选：`1024x1024` / `1792x1024` / `1024x1792`，缺省不传）、`model`（可选覆盖）。
   - `accesses: [{ resource: "network", action: "read" }, { resource: "file", action: "write", path: "files/images/" }]`；`requiresApproval: true`。
   - execute 流程：解析参数 → `ctx.services?.imageProvider` 守卫（决策 5 错误文案）→ `generate(prompt, { size, model })` → url 则下载落盘（15s 超时 / 20MB 上限 / content-type 白名单 png,jpeg,webp,gif → 扩展名映射），data/data-url 则解码写盘 → 文件名 `files/images/<yyyyMMdd-HHmmss>-<6随机>.<ext>`（原子写 tmp+rename，沿用 document-store 纪律）→ 输出 `{ path, model, size, persisted: true, sourceUrl?: <仅回退时> }`。
   - 下载失败：回退 `{ persisted: false, url, model }` 并 success: true（标注），不吞不崩。
   - 错误全结构化，不抛裸异常；prompt 截 500 进任何日志。
7. `tools/builtin/index.ts` 注册（第 14 个）。
8. **测试** `tests/tools/generate_image.test.ts`：
   - schema 校验（空 prompt / 非法 size / 非法参数类型）；
   - 无 imageProvider 注入 → 决策 5 错误；
   - `requiresApproval === true` 钉死；
   - Mock provider 返回 data-url → 落盘成功，路径在 `files/images/` 下，内容字节一致；
   - Mock provider 返回 url + 本地下载 mock（nock 或 stub fetch）→ 落盘 + `persisted: true`；
   - 下载失败 → `persisted: false` + url 回退；
   - **型号透传**：spy provider.generate，断言收到 `options.model` = 工具参数覆盖值 / 缺省 undefined；
   - 20MB 上限与 content-type 白名单拒绝路径；
   - prompt 不出现在输出/错误里超 500 字符。
9. **provider 单测** `tests/provider/image-gen.test.ts`：构造 `defaultModel` → generate 未传 model 用 defaultModel；传了用传的；Mock 行为不变。

**验收：** `pnpm --filter @mindcloud/engine test` 全绿（新用例 ≥9）；typecheck/lint 绿；未配置 agent 调工具拿到指引错误（单测覆盖）。

### 阶段 2（文件服务 + web 渲染）——1 个实现子代理（阶段 1 验收后开工）

**任务：**

1. 引擎路由 `api/routes/files.ts`（注册进 server）：`GET /agents/:id/files/*`——
   - agentId 校验（复用现有 agents 路由同款 id 校验，幽灵 agent 404）；
   - 路径解析：拼接 `DATA_DIR/agents/<id>/files/<*>`，resolve 后必须以 files 目录为前缀（防 `..` 穿越；穿越 400）；
   - 不存在 404；目录 400；仅 GET；
   - content-type 按扩展名白名单映射（png/jpeg/webp/gif），其余 415；
   - 读流回包，不引新依赖（决策 4）；
   - 测试：穿越 400 / 幽灵 404 / 不存在 404 / 目录 400 / 非白名单 415 / 正常 200 + content-type。
2. nuxt 代理 `apps/web/server/api/agent-file.get.ts`：query `agentId` + `path` → 服务端带 token 转发 engine `/agents/:id/files/<path>`，流式回传 content-type 与 body；token 不出服务端。
3. `MessageBubble.vue` 工具卡：识别 tool result output 形状 `{ path, model, persisted }`（generate_image）→ 渲染 `<img :src="/api/agent-file?agentId=..&path=..">`（失败占位 + 路径文本）；`persisted: false` 时渲染 sourceUrl 链接。agentId 从会话上下文取。
4. web 测试：工具卡图片渲染（mock toolCalls 数据断言 img src 拼接正确；persisted:false 分支渲染链接）。

**验收：** web vitest 绿；引擎新增路由用例绿；手测链（或 e2e 增补 1 例：Mock 环境 agent 调 generate_image → 工具卡出图）可选，不强制进本单。

### 阶段 3（文档销记 + 总闸）——1 个子代理（或主控亲办）

- `docs/路线图.md`：generate_image 从「三、规划中」挪「一、已实现」（工具节，注明型号透传/审批档/落盘纪律）；「二、部分实现」image-gen provider 行删除或改写为已完成；工具数 13 → 14。
- `README.md`：功能清单内置工具数与列表加 `generate_image`；「规划中」删 generate_image。
- `docs/API.md`：新增 `GET /agents/:id/files/*` 端点小节；工具清单同步。
- `docs/开发指南.md`：如需（工具清单提及处）同步。
- 全量 `pnpm verify` + `pnpm test:e2e` 绿。

---

## C. 评审与闸门

1. 每阶段实现完 → **独立 review 子代理**（与实现者不同会话/不同上下文，只读审查 diff + 跑测试，结论带 文件:行，零误报标准）。
2. 主控终审：亲读全部 diff，对照本 plan 决策 1-8 逐条核。
3. review 不过不合并；修复后复验（存在性验证先行，禁止按报告瞎修）。
4. 阶段 3 完成才动路线图/README——文档销记永远在最后。

## D. 风险与开放点

- **dall-e-3 的 url 时效约 1h**——落盘优先策略（决策 3）已兜住；`persisted: false` 回退场景下 web 渲染远端 url 可能过期，可接受（标注即可）。
- **非 OpenAI 报文形态的生图端点**：第一版不管（决策 1），遇上再扩协议族。
- **工具卡形状识别耦合**：MessageBubble 按 output 形状特判 generate_image——若未来更多媒体工具，抽通用 media 渲染。本单不抽象。
- 开放点（不阻塞）：e2e 增补生图用例；image-gen 的用量统计是否进 `llm_calls.jsonl`（倾向：进，字段复用，阶段 1 实现时顺手，review 时定夺）。
