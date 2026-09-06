# blurb 管理 v3 实施计划

- 日期：2026-08-26
- 范围：`services/engine`（store/loader/agents/routes + 测试）、`apps/web`（settings/tools.vue + 入口 + 测试）、`docs`
- 依据：`docs/archive/superpowers/specs/2026-08-26-blurb-management-v3-design.md`——决策 1-6 不翻案
- 方法：阶段 1 引擎 → review → 阶段 2 web → review → 销记总闸提交

## 阶段 1（引擎端点 + skill 覆盖层）——1 个实现子代理

1. `core/tool-blurb-store.ts` 扩展：`descHashOf` 导出既有；增 `upsertOne(name, entry)` 单件写（编辑用，读-改-写合并同款）。
2. `core/tool-catalog-service.ts`（新）：聚合三清单——
   - dynamic：worker 注册表全量动态工具（mcp__/ext__：tools forAgent 或 loader 名录）× store 条目 → status（命中哈希→llm/user；无条目→missing；哈希变→stale）；
   - skills：`ctx.skills.list(agentId)` 作者行 × `skill:<name>` 条目 → 同四态；
   - builtin：`getBuiltinTools()` 名 + 描述首句（firstSentenceBlurb 复用），status 恒 "core" 无管理面。
3. skill 覆盖层接线：`plugins/agents/index.ts:236` skillCatalog 构造——命中 `skill:<name>` 条目（哈希与当前 SKILL.md 描述一致或 source=user）则用覆盖行，否则作者行。
4. 路由 `api/routes/tool-blurbs.ts`（新，注册进 server）：
   - `GET /agents/:id/tool-catalog`（幽灵 404）；
   - `POST /agents/:id/tool-blurbs/regenerate`：zod `{ names?: string[] }`；缺省=missing+stale 全件；user 跳过；dynamic 件走动态工具概括、skill: 件走 SKILL.md 描述概括（同一 summarizer）；返回 `{ generated, failed }`；
   - `PUT /tool-blurbs/:name`：zod `{ blurb: string().min(1).max(200) }`；name 必须在全局动态工具或某 agent skill 名录内（fail-closed 404）；upsert source:"user"。
5. 测试：service 三清单四态/覆盖层接线（L1 行翻转）/三端点（状态机、缺省 regenerate 只碰 missing+stale、user 跳过、PUT 边界与 404、skill:<name> 重生成）；既有套件零回归。

**验收：** 引擎全量绿（新增 ≥12 例）；typecheck/lint 绿。

## 阶段 2（web 子页面）——1 个实现子代理（阶段 1 review 过后）

1. `pages/settings/tools.vue`：三节（MCP 工具 / Skills / 内置工具）；徽标四态（待生成=missing 灰、LLM 蓝、已编辑=user 绿、已过期=stale 黄）；行内编辑（铅笔→输入框→保存调 PUT）；重生成按钮（按件 + 「全部重新生成」调 POST）；builtin 节只读。
2. `pages/settings.vue` 加入口卡片（「工具与技能简介」→ /settings/tools）。
3. store/composable：GET 拉取 + 变更后刷新；错误 toast 页面内。
4. web 测试：三清单渲染、徽标映射、编辑保存后 source 转 user 与刷新、重生成调用参数（缺省/指定）。

**验收：** web 全量绿（新增 ≥4 例）+ typecheck/lint。

## 阶段 3（销记 + 总闸）

- 路线图：blurb 条目补「v3 管理面（目录端点/重生成/用户编辑/设置子页面）」；README 功能清单一行；API.md 三端点小节；架构文档 tool-blurbs.json 加 source 语义与 skill 命名空间。
- 全量 `pnpm verify` + `pnpm test:e2e`；三笔提交（引擎 / web / 文档）。

## 评审闸

阶段 1 review 重点：① status 四态正确性（stale 判定）② user 永不覆盖全链路 ③ PUT fail-closed（键名空间校验）④ skill 覆盖层不动原文 ⑤ 端点鉴权涵盖。阶段 2 review 重点：交互真实可达、状态翻转、无绕过引擎直接改文件的前端路径。

## 开放点

- regenerate 对 skill 的概括素材是 SKILL.md 的 description 字段（非全文）——若作者描述本身空，重生成也产不出好 blurb（记档）；
- 全局通知通道（指挥官已选页面内徽标，通道不建）；
- stale 条目运行时仍可用是否太宽容（备选：stale 即回退作者行/机械行——留真机观察）。
