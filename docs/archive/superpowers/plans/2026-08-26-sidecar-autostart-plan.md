# sidecar 自启唤醒实施计划

- 日期：2026-08-26
- 范围：`services/engine`（sidecar/autostart + config + plugins + 测试）、`apps/web`（设置开关）、`docs`
- 依据：`docs/archive/superpowers/specs/2026-08-26-sidecar-autostart-design.md`——决策 1-7 不翻案
- 方法：实现子代理 → 独立 review → 主控终审 → `pnpm verify` + `test:e2e` + smoke → 提交

## 阶段 1（引擎 + web 开关）——1 个实现子代理

1. `services/engine/src/sidecar/autostart.ts`（新）：
   - `resolveSidecarBin(): Promise<string | undefined>` 决策 3 发现序；
   - `startSidecarIfEnabled(opts): Promise<void>`——读 config.settings.sidecarAutoStart（缺省 false 直返）；先 `SidecarClient.health()`（200ms 短超时），健康则 info 纳用返回；否则 resolveSidecarBin → 全灭 warn 降级返回；spawn（detached:false，env 注入决策 6，stdio pipe→pino warn）；spawn 'error' 事件 error! 一次不重试；
   - `stopSidecar(): Promise<void>`——SIGTERM → 5s → SIGKILL / win32 taskkill，全程 .catch；
   - 状态仅内存（本进程 spawn 的 child 引用），engine 崩溃侧由 sidecar 收编监控兜底（决策 5）。
2. 接线：bootstrap/plugins 合适点（启动尾部调用 startSidecarIfEnabled、shutdown 链调用 stopSidecar——看现有 shutdown.ts 编排）——实现方读现场定锚点并申报。
3. 配置面：全局 settings schema 加 `sidecarAutoStart`（zod boolean 缺省 false）；`GET/PUT /config/settings` 白名单如已有即入列。
4. web：SystemSettingsPanel 加 checkbox「自动启动向量侧车（sidecar）」（同面板既有开关风格，说明文案含"需本地已有 sidecar 二进制或 cargo 环境"）。
5. 测试：
   - autostart 单测：开关关零 spawn / 健康纳用短路 / 发现序逐档（mock fs/PATH）/ 全灭 warn 降级 / spawn error 一次 / stopSidecar 信号序列与超时升级 / 全程无浮空 promise；
   - config schema 读写；
   - 恒等：开关关时与现状零差异（既有套件零回归）；
   - smoke（`tests/sidecar/autostart.smoke.test.ts` 或并入既有 smoke 配置）：真起 sidecar 二进制（若环境有 cargo build 产物）验证自启链路——环境无产物时 skip 并注明。

**验收：** 引擎全量绿（新增 ≥8 例）+ web 绿；typecheck/lint 绿。

## 阶段 2（文档销记 + 总闸）

- 路线图：sidecar 条目改「自启唤醒（settings.sidecarAutoStart，默认关）」+ supervisor 休眠能力表述更新（已唤醒为 engine 拉起模式）；
- README：sidecar 节补自启说明（手动 cargo run 仍是合法路径）；
- DEPLOY.md：生产部署补 sidecar 二进制准备（cargo build --release / ZOME_SIDECAR_BIN）；
- 架构文档/开发指南：启动流程节同步；
- 全量 `pnpm verify` + `pnpm test:e2e` + `pnpm --filter @mindcloud/engine test:sidecar`（环境允许时）；两笔提交（实现 / 文档）。

## 评审闸

独立 review 重点：① 恒等（默认关零变化）② 关停两段式与浮空 promise ③ 发现序安全（PATH 注入面/恶意二进制风险——ZOME_SIDECAR_BIN 是用户显式配置可接受）④ 纳用短路 ⑤ 降级链不破引擎启动。

## 开放点

- engine 崩溃无人收尸时 sidecar 孤儿窗口（supervisor watch 的既有语义兜底，不新增机制）；
- sidecar 版本与 engine 的版本兼容握手（现状无，记档）；
- 自启后 sidecar 日志接管统一（v1 pipe→warn 即可）。
