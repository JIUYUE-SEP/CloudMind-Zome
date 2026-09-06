# sidecar 自启唤醒设计规格（瘦身版）

> 版本：1.0 | 日期：2026-08-26
> 状态：设计定案（指挥官拍板选项 1：engine 拉起 sidecar）
> 前置侦察：`crates/zome-sidecar/src/supervisor/mod.rs:167-250`（收编语义）、`main.rs:30-50`（sidecar 为父拓扑）、`plugins/http/index.ts:35`（engine.pid）

## 1. 背景

sidecar（向量记忆）在桌面端时代由壳拉起；桌面端砍掉后无进程负责启动它，supervisor 休眠，向量记忆变手动档。本单唤醒：**engine 可选地自动拉起 sidecar 并管生命周期**。拓扑已证安全：engine 先起写 `engine.pid`（plugins/http/index.ts:35），sidecar 启动时 `spawn_node_engine` 发现 pid 走**收编**（纳管监控、身份核验击杀），不重复 spawn——互为监护闭环是既有设计。

## 2. 已定决策（不翻案）

1. **配置**：全局 `settings.sidecarAutoStart: boolean`，**默认 false（与现状恒等）**；web 系统设置面板加 checkbox（顺手小项，同面板既有开关风格）。
2. **纳用优先**：spawn 前先查健康（复用 `sidecar/client.ts` Health）——已有健康 sidecar 在跑（用户手动起的）则**直接纳用不重复 spawn**，只记 info。
3. **二进制发现序**：`ZOME_SIDECAR_BIN` 环境变量 → 仓内 `crates/zome-sidecar/target/release/zome-sidecar` → `target/debug/zome-sidecar` → PATH `zome-sidecar` → `cargo run --manifest-path crates/zome-sidecar/Cargo.toml` 兜底；全灭 → **warn 一次 + 按 sidecar 缺席降级**（引擎照常，恒等语义不破）。
4. **异步拉起不阻塞**：engine 主启动不等 sidecar 就绪——spawn 后健康检查自然接管（向量检索本就按健康降级）；spawn 失败（ENOENT/EACCES）记 error 并降级，不重试风暴。
5. **关停两段式**：engine shutdown 时对子进程 SIGTERM → 5s 超时 SIGKILL（Windows `taskkill /pid /T /F` 同纪律，照 MCP 关停先例）；**浮空 promise 禁令**（全部 .catch）；engine 崩溃时 sidecar 侧收编监控的既有语义兜底（watch_node_health 的 restart/退出级联）。
6. **环境注入**：spawn env 传 `ZOME_SIDECAR_ADDR`（缺省 127.0.0.1:50051）、`CLOUDMIND_DATA_DIR`、`ZOME_LOG_LEVEL`；stdio pipe 进 pino（warn 级）。
7. **测试**：发现序/纳用短路/降级链/关停两段/恒等（开关关零 spawn 调用）单测；真 sidecar 集成走 smoke 档（`vitest.smoke.config.ts` 先例，`test:sidecar`）。

## 3. 验收

1. 开关关：零 spawn 调用、行为与现状逐字节恒等；
2. 开关开 + 无 sidecar：发现序逐档探测、spawn 成功、健康后向量链路可用；
3. 开关开 + 已有健康 sidecar：纳用不重复 spawn；
4. 二进制全灭：warn 降级引擎照常；
5. engine 关停：sidecar 收到两段式终止（mock spawn 断言信号序列）；
6. web 开关可读可写持久；
7. 既有套件零回归；smoke 档真进程用例过。
