# blurb 管理 v3 设计规格（瘦身版）——状态可见 + 手动重生成 + 用户编辑 + 设置子页面

> 版本：1.0 | 日期：2026-08-26
> 状态：设计定案（指挥官三项拍板：skill 也可编辑/独立子页面/页面内徽标）
> 前置：`docs/archive/superpowers/specs/2026-08-26-tool-blurb-llm-design.md`（v2 策展）

## 1. 目标

把 blurb 从"引擎自管的黑盒"变成"用户可见可管的资产"：全部动态工具与 skill 的简介状态可见（llm/user/missing/stale），失败可手动重新生成，用户可编辑且编辑永不被自动覆盖；web 独立路由子页面承载管理面。

## 2. 已定决策（不翻案）

1. **状态模型**（GET 目录返回每件的 status）：
   - `llm`：LLM 策展命中（哈希一致）；
   - `user`：用户编辑命中（永不被自动覆盖——含描述哈希变化时，v2 已埋）；
   - `missing`：无条目（生成失败/从未生成=待生成）；
   - `stale`：有条目但描述哈希已变（llm 源过期——stale 条目展示时标注但运行时仍可用，直至重生成）。
2. **skill 覆盖层**：skill 简介纳入 blurb 存储，key = `skill:<name>` 命名空间（v2 预留扩展位启用）；L1 skill 目录行（`plugins/agents/index.ts:236` 构造处）命中覆盖条目（llm/user）则用覆盖行，否则作者元数据行。**SKILL.md 原文永不动**。skill 不自动 LLM 概括（作者行够用），仅在用户点重生成时概括其描述。
3. **端点三件套**（REST，全局 Bearer 自动涵盖）：
   - `GET /agents/:id/tool-catalog`：三节清单——dynamic（mcp__/ext__ 带 name/blurb/source/status）、skills（name/作者行/覆盖行/source/status）、builtin（只读：name+描述首句，无管理面）；
   - `POST /agents/:id/tool-blurbs/regenerate`：body `{ names?: string[] }`（限定名或 `skill:<name>`；缺省=全部 missing/stale 件）→ 逐类批量概括 → 成功件 upsert source:"llm" → 返回 `{ generated: string[], failed: string[] }`；user 条目跳过不碰；
   - `PUT /tool-blurbs/:name`（name 为限定名或 `skill:<name>`，URL 编码）：body `{ blurb: string(1..200) }` → upsert `source:"user"`；拒绝空串/超长。
4. **web 独立子页面**：`pages/settings/tools.vue`（/settings/tools 嵌套路由），settings.vue 加入口卡片（不动顶部主导航——维持既有口径）；三节对应三清单，徽标四态（待生成/LLM/已编辑/已过期），编辑用行内编辑框，重生成按件/全部按钮；失败提示页面内（徽标+重生成按钮），不做全局通知。
5. **防线**：编辑内容截 200 且 JSON 落盘零执行面；regenerate 走 agent provider 链落 llm_calls 账；端点输入全 zod 校验；PUT 的 name 必须存在于该 agent 目录或 skill 名录（防乱写键名空间）——fail-closed。
6. **不引新依赖**；既有 v2 自动策展行为零变化（ensureBlurbs 照旧）。

## 3. 机制锚点

- skill 目录行构造：`plugins/agents/index.ts:236`；loader ensureBlurbs/store 复用：`core/tool-blurb-store.ts`（读写面直接复用，增 `remove?` 不需要——编辑=upsert）；
- 路由范式：`api/routes/skills.ts:9-36`；设置页入口：apps/web/pages/settings.vue；嵌套路由：apps/web/pages/settings/ 目录。

## 4. 验收

引擎：GET 三清单状态四态正确；regenerate 缺省只碰 missing/stale、指定名单含 skill:<name>、user 条目跳过；PUT 编辑生效且后续 ensureBlurbs 不覆盖；stale 判定正确（改描述后 llm 条目转 stale）；zod 边界；既有套件零回归。
web：子页面三节渲染、徽标四态、编辑保存后 source 转 user、重生成后状态翻转、设置页入口可达；web 测试覆盖关键交互。
