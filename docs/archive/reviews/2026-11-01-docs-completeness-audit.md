# 文档完整性审查（2026-11-01）

> 范围：`docs/` 全部 60 篇 Markdown + 根 `README.md`，对照 `services/`、`apps/`、`crates/`、`packages/` 实际代码。
> 方法：全量链接校验、代码路径引用校验（162 处）、REST 端点差集（代码 73 个 vs 文档 77 条）、模块与常量覆盖扫描、数字口径交叉核对。
> 结论：**体系完整、执行到位，但存在 3 类实质缺口（2 处路径失效、1 张环境变量表缺 7 项）与 3 处数字内部矛盾。**
>
> **修复状态（同日执行完毕）**：P1-1、P1-2、P2-3、P2-4、P2-5、P3、P4-11 已修并复核；P4-6/7/8/9/10/12 按需保留（本轮不动）。下方正文保留审查当时的证据原貌，不随修复回改。

---

## 一、总评

| 维度 | 结论 | 证据 |
|------|------|------|
| 结构分区 | ✅ 优 | 现行区 / archive 档案区二分 + 单一地图（`docs/README.md`）+ 维护规则四条 |
| 索引完整性 | ✅ 优 | 现行区 11 类入口 + 单篇明细，实际文件 60 篇零孤儿 |
| 链接有效性 | ✅ 良 | 相对链接零死链；仅 archive 区 2 处反引号路径失效（见 P4-12，按「只增不改」可豁免） |
| API 契约覆盖 | ✅ 优 | 代码注册 73 个 REST 路由，文档 100% 覆盖，无遗漏端点 |
| 架构覆盖 | ⚠️ 良 | 19 个顶层模块全覆盖，但插件清单漏 1 项、前端仅 1 行 |
| 代码路径引用 | ⚠️ 良 | 162 处引用，158 处可解析；4 处不可解析中 2 处为真漂移（P1） |
| 配置/常量覆盖 | ❌ 有洞 | 环境变量实际 17 个，总表 10 个，2 个变量全文档零提及（P3） |
| 数字一致性 | ❌ 有矛盾 | 插件数、测试规模在不同现行文档给不同值（P2） |
| 时效性 | ✅ 优 | 8 篇现行文档最后修改均在 2026-11-01 |

---

## 二、P1 — 事实性错误（指向不存在的文件，会误导读者）

### P1-1 `tools/registry.ts` 不存在

- 证据：`docs/开发指南.md:83` 关键文件表列 `services/engine/src/tools/registry.ts` — 工具注册中心。
- 实际：`services/engine/src/tools/` 只有 `builtin/`、`external/`、`mcp/`、`project-paths.ts`、`types.ts`；无 `registry.ts`。注册装配在 `services/engine/src/plugins/tools/`（Cordis 插件）与 `src/api/server.ts`。

### P1-2 `document-store.ts` 已迁至 `plugins/memory/`，文档三处未跟上

- 证据：
  - `docs/开发指南.md:420` — `services/engine/src/memory/document-store.ts:81-84`（带行号，错得更实）
  - `docs/架构文档.md:79` — `src/memory/ # document-store、indexer、repositories...`
  - `docs/架构文档.md:245` — `DocumentStore（memory/document-store.ts）`
- 实际：`services/engine/src/plugins/memory/document-store.ts`。`src/memory/` 现仅含 `indexer.ts`、`recall.ts`、`reconcile.ts`、`repositories/`、`topic/`。
- 影响面：这是「文档销记永远在最后」纪律的反例——Cordis 插件迁移（`docs/archive/superpowers/plans/2026-08-14-cordis-plugin-migration.md`）把该文件搬走后，正文未同步。

---

## 三、P2 — 数字 / 口径内部矛盾

### P2-3 插件数量：同一文档自相矛盾

| 出处 | 说法 | 与代码 |
|------|------|--------|
| `docs/架构文档.md:5` | 「插件数 22 → 23（新增 `plugins/watchdog`）」 | ✅ 23 正确 |
| `docs/架构文档.md:74` | 清单实列 22 个，**无 watchdog** | ✗ 与同文 L5 矛盾 |
| `docs/开发指南.md:117` | 「22 插件挂载」+ 清单 22 个 | ✗ 数字与清单都漏 watchdog |

实际：`services/engine/src/bootstrap.ts` 中 `import * as` 与 `root.plugin(` 均为 **23** 次（含 `watchdog`）。`plugins/approval-audit/` 是被 import 的模块（`core/agent-worker.ts:42` 等），不是挂载插件，不计入。

### P2-4 测试规模：三份现行文档三个数

| 出处 | 标注日期 | 数字 |
|------|----------|------|
| `docs/开发指南.md:377` | 2026-08-19 实测 | engine 167 文件 / 1547 例；web 29 / 200；e2e 2 |
| `docs/项目导览.md:185` | 2026-09-06 实测 | engine 184 文件 / 1749 例；web 37 / 303；e2e 8 |
| `docs/路线图.md:106` | 2026-11-01 实测 | engine 187 文件 / 1801 例；web 40 / 309；e2e 8 |

实际现状（`vitest list` 复核）：`services/engine/tests/` 下 190 个 `*.test.ts`，其中默认套件收集 **187** 个（3 个 `*.smoke.test.ts` 被 `vitest.config.ts` exclude，走 `test:sidecar`）；用例 **1801**；web 40 文件 / **309** 用例；e2e 8 个 spec。
**即：路线图的数字与实际完全一致，另两处是没跟上的旧快照。矛盾不在数字本身，在「谁该写数字」——三份现行文档各自维护同一事实。**

### P2-5 `config.json` 结构示例不完整

- 证据：`docs/架构文档.md:368-378` 的 JSON 示例只含 `settings.memory` 与 `settings.tavilyApiKey`。
- 实际 `settings` 还有：`watchdog`（`enabled`/`stallThresholdMs`/`scanIntervalMs`/`semanticReview.{enabled,afterMs,cooldownMs}`）、`sidecarAutoStart`（见 `services/engine/src/config/repository.ts`）。
- 说明：watchdog 参数在 `docs/看门狗调参.md` 讲得很细、`sidecarAutoStart` 在 `docs/架构文档.md:103` 有正文，但**全仓库没有一处给出完整的 config.json 骨架**，`§6.1` 又恰好是唯一以「完整示例」姿态出现的地方。

---

## 四、P3 — 环境变量表不完整（最实质的完整性缺口）

`docs/开发指南.md:46-57` 的表列 10 个。代码实际使用 17 个 `CLOUDMIND_*` / `ZOME_*`：

| 变量 | 代码使用处 | 文档覆盖 |
|------|-----------|----------|
| `CLOUDMIND_DATA_DIR` | 242 | ✅ §1.4 |
| `CLOUDMIND_AUTH_TOKEN` | 13 | ⚠️ 仅在 `API.md:11`、`架构文档` 正文，**总表无** |
| `CLOUDMIND_STREAM_IDLE_TIMEOUT_MS` | 8 | ⚠️ 仅在 `API.md:113`，**总表无** |
| `CLOUDMIND_MASTER_KEY` | 5 | ✅ |
| `CLOUDMIND_ALLOWED_ORIGINS` | 2 | ✅ |
| `ZOME_LOG_LEVEL` | 3 | ✅ |
| `ZOME_SIDECAR_ADDR` | 2 | ✅ |
| `ZOME_SIDECAR_BIN` | 1 | ⚠️ 仅在 `DEPLOY.md:42`，**总表无** |
| `ZOME_PROTO_PATH` | 3 | ✅ |
| `ZOME_STARTUP_RECONCILE` | 3 | ✅ |
| `ZOME_BUILTIN_SKILLS_DIR` | 7 | ❌ **全文档零提及** |
| `ZOME_PLAN_STEP_TIMEOUT_MS` | 4 | ❌ **全文档零提及** |
| `PORT` / `NODE_ENV` | 9 / 24 | ✅ |
| `NUXT_PUBLIC_ENGINE_TOKEN` | 3（web） | ✅ |
| `ENGINE_URL` / `ENGINE_TOKEN` | 2 / 2（e2e） | ❌ **全文档零提及** |

**两个零覆盖项值得单独注意**：`ZOME_BUILTIN_SKILLS_DIR`（7 处使用，打包后内置 skill 目录定位）与 `ZOME_PLAN_STEP_TIMEOUT_MS`（Plan 步骤超时）—— 使用者遇到相关行为时无处可查。

---

## 五、P4 — 结构性缺失（可选补充，非缺陷）

| # | 项 | 现状 |
|---|-----|------|
| 6 | `CONTRIBUTING.md` | 无。`开发指南.md` 实质承担该职责（§7 提交前检查清单、§8 隐私红线），可接受 |
| 7 | `CHANGELOG.md` | 无。更新日志在 `apps/web/content/changelog.ts`（`路线图.md:97` 提及），仓库根无标准位 |
| 8 | 前端独立文档 | 无。17 个页面 / 37 个组件，仅 `开发指南.md:87-102` 12 行表格 + `路线图.md:94-99` 一段描述；`架构文档.md:96` 对前端只有一行 |
| 9 | `spikes/` 说明 | 仅 `README.md:202` 结构树一行「throwaway 实验」，无索引 |
| 10 | `packages/*` README | 无。`packages/skills` 仅 1 个 `core/SKILL.md` + `schema.json` |
| 11 | README 常用命令 | 缺 `pnpm verify`、`pnpm bench`、`pnpm test:coverage`、`pnpm test:e2e:ui`；未提根目录 `start-dev.bat` / `start-dev.ps1`；`.github/workflows/ci.yml` 存在但无 CI 说明 |
| 12 | archive 死链 2 处 | `plans/2026-08-14-cordis-plugin-migration.md` 引 `cordis-primer.md`（该文件已不存在）；`specs/2026-07-02-remove-python-backend-design.md` 引 `2026-06-24-cloudmind-docs-rewrite-design.md`（同上）。按「只增不改」纪律可豁免 |

---

## 六、建议修复顺序

1. **P1-1 / P1-2**（4 处路径，5 分钟）：改成 `plugins/tools/`、`plugins/memory/document-store.ts`。
2. **P3**（补 7 行表）：`开发指南.md:46` 总表补齐，其中 `ZOME_BUILTIN_SKILLS_DIR` / `ZOME_PLAN_STEP_TIMEOUT_MS` / `ENGINE_URL|TOKEN` 需先从代码注释确认语义再落表。
3. **P2-3**（插件清单）：`架构文档.md:74`、`开发指南.md:117` 补 `watchdog`，统一为 23。
4. **P2-4**（测试数字）：路线图保留唯一权威值，另两处改为引用。
5. **P2-5**（config 示例）：`架构文档.md §6.1` 补 `watchdog` / `sidecarAutoStart` 两段，或明确标注「节选，完整字段见 X」。
6. **P4**：按需，不阻塞。

---

## 附：审查未发现问题的部分（供对照）

- REST 端点：73/73 全覆盖，`/health`、`/ws/*`、nuxt `/api/agent-file` 三个非 routes 目录端点也有文档。
- 内置工具：README 声明的 15 个与 `src/tools/builtin/*.ts`（去掉 `index.ts`）逐一对应，无多余无遗漏。
- 模块目录：`架构文档.md:71-98` 的 engine 子目录清单与 `src/` 实际 22 个顶层目录一致（除 P1-2 的 document-store 归属）。
- 文档互引：`README.md` ↔ `docs/README.md` ↔ 各篇之间引用链完整，无悬空入口。
