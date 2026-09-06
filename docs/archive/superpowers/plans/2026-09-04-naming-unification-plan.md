# 命名统一（A 案：@mindcloud → @cloudmind）实施计划

- 日期：2026-09-04
- 范围：npm 包层重命名 + 引用面 + 文档面 + lockfile 重建
- 性质：纯机械重命名，零行为变化；一次完成，不分阶段

## 任务（1 个实现子代理）

1. 包名：`services/engine/package.json`、`apps/web/package.json`、`packages/shared/package.json` 的 name 改 `@cloudmind/*`；根 `package.json` name 改 `cloudmind-zome`。
2. 精确替换 `"@mindcloud/"` → `"@cloudmind/"`：全部 `services/`、`apps/`、`packages/`、`scripts/`、`tests/`、`crates/`（如有）、`.github/` 下的 ts/vue/json/mjs/yaml 文件（排除 node_modules、.turbo、dist、pnpm-lock.yaml）。
3. 文档替换（同规则）：`README.md`、`docs/开发指南.md`、`docs/DEPLOY.md`、`docs/API.md`、`docs/架构文档.md`、`docs/项目导览.md`、`docs/路线图.md`。**不动** `docs/archive/superpowers/`、`docs/archive/reviews/` 历史档案。
4. README 克隆地址 `https://github.com/yourname/MindCloud-Zome.git` → `https://github.com/JIUYUE-SEP/CloudMind-Zome.git`（真实 remote）。
5. `pnpm install` 重建 lockfile（@cloudmind scope 生效）。
6. 残留扫描：`grep -rn "@mindcloud\|mindcloud-zome" --exclude-dir=node_modules --exclude-dir=.turbo --exclude=pnpm-lock.yaml .` —— 残留只允许出现在 docs/archive/superpowers 与 docs/archive/reviews 历史档案中（逐条核对清单入报告）。

**验收：** `pnpm verify` 全绿（lint/typecheck/vitest/cargo）+ `pnpm build` 3/3 + `pnpm test:e2e` 2/2 + `pnpm install` 后 lockfile 无 @mindcloud 残留；git diff 全为重命名无逻辑变化。

## 评审与提交

主控终审：diff 抽查 + 残留清单复核 + 总闸亲跑。两笔提交（代码重命名 / 文档+lockfile）。随后 push（指挥官已要求统一后同步）。
