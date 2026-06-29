# Agent 工作规范

## 分支管理

1. **每个新任务必须新建独立分支**，不要直接在 `main` 分支上工作。
2. 分支命名应清晰反映任务内容，例如：
   - `fix/security-review-issues`
   - `feat/multi-tab-agent-editor`
   - `ci/ubuntu-build-fix`

## 合并流程

1. 任务完成后，**只提交并 push 到当前工作分支**。
2. **不要主动合并到 `main`**。
3. 等待用户检查代码，并收到用户明确的「合并」指令后，再执行合并。
4. 合并前必须确保：
   - `pnpm test` 通过
   - `pnpm typecheck` 通过
   - `pnpm lint` 通过
   - 相关 Rust 检查（`cargo fmt --check`、`cargo clippy -- -D warnings`、`cargo test`、`cargo build --release`）通过

## 代码审查

1. 非平凡改动应先进行代码审查（review）。
2. 审查报告需明确区分 Critical / Important / Minor 级别。
3. Critical 问题必须修复后才能合并。
4. Important 问题应记录并优先修复。
5. Minor 问题可以记录为后续优化项。

## 提交规范

1. 使用中文或英文 commit message，保持语义清晰。
2. 多个独立修复应分别提交，便于回滚和审查。
3. 不要在 commit 中包含 secrets、临时文件或大量生成文件。

## CI / 远程

1. 合并到 `main` 后应关注 GitHub Actions 是否通过。
2. 无法直接访问 CI 日志时，应请求用户提供失败 step 的日志文本或截图。
