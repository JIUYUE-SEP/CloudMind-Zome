# services/engine/src/plugins —— CMZ 内部插件居住地

本目录是 Cordis 插件化迁移（方案：`docs/archive/superpowers/plans/2026-08-14-cordis-plugin-migration.md`）中**内部插件的清单地**。P0 期只立地：目录约定 + 模板 + 测试基线，**骨架不接进 bootstrap.ts，一根线都不接**。

## 目录定位

- 迁移 P0–P9 期已完成（2026-08-17）：bootstrap.ts 各模块的构造与接线已全部收口为本目录下的插件（每期范围见迁移方案 B3 表）。
- **bootstrap.ts 已退役为薄组合根**（约 145 行）：22 个插件挂载 → assertServices → `serial("engine/ready")`（启动对账/scheduler start 挂此事件）→ `http.listen()` → 关停钩。
- 迁移第二阶段（外部插件发现，E1–E3 已完成 2026-08-18）：`plugins/external/` 是本目录第 22 个插件——器官清单（全局 `DATA_DIR/plugins.json`、per-agent `DATA_DIR/agents/<id>/plugins.yml`）驱动的外部插件加载器；外部插件本体不住本目录，住 `DATA_DIR/plugins/<name>/index.mjs`（纯 JS ESM）。开发指南见「开发外部插件（器官）」节。

## 插件解剖（四件套）

见 `_template.ts`，形态参照 dsh `packages/context/time-context/src/index.ts`：

| 导出 | 用途 |
|---|---|
| `name` | 插件名，诊断/日志显示用，与目录名一致 |
| `inject` | 激活前必须就位的服务声明；缺依赖 fiber 停 PENDING，到齐才激活（替代手工排序） |
| `Config` | 配置类型面；运行期校验预留 standard-schema 接口（zod 3.24+ 兼容），非法配置加载即失败 |
| `apply(ctx, config)` | 激活入口：只做**可逆**注册（服务上架 + 事件监听），disposer 由 fiber 持有，卸载自动回收 |

## 命名约定

- 插件目录/文件：kebab-case，与 `name` 导出一致。
- 事件名：`插件名/事件名`（如 `perception/inject`），经 `declare module "cordis" { interface Events }` 接口合并获得类型检查；派发模式（emit / waterfall / serial / parallel）是事件公共契约，定义时以 JSDoc `@mode` 注明。
- 服务名：与迁移方案 B1 服务清单对齐（log / config / agents / llm / tools / …）。

## 纪律

- 不写 cordis 封装层/辅助库——直接吃上游 API（迁移方案边界，P0 不立抽象）。
- 行为零变化是每期硬门槛；每期验证命令与保绿测试清单见迁移方案 B3 表。
- 测试基线：`tests/plugins/skeleton.test.ts`（cordis 可 import、模板可挂载）。
