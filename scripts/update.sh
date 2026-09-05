#!/usr/bin/env bash
# CloudMind-Zome 本地安装更新脚本（手动更新，非自动更新器）：
#   git pull → pnpm install → pnpm build → （默认）pnpm verify
# 用法：
#   scripts/update.sh              # 完整更新 + 全量验证（推荐）
#   scripts/update.sh --skip-verify  # 只更新构建不跑验证（快，约省 3 分钟）
#
# 不做的事：不在后台运行、不检查新版本、不重启你的 engine/web——
# 更新完成后请自行重启进程生效。数据目录（DATA_DIR）不受影响；
# 落盘格式经 schemaVersion 读时惰性迁移（见 docs/DEPLOY.md「更新」节）。

set -euo pipefail
cd "$(dirname "$0")/.."

SKIP_VERIFY=false
for arg in "$@"; do
  case "$arg" in
    --skip-verify) SKIP_VERIFY=true ;;
    -h|--help) sed -n '1,12p' "$0"; exit 0 ;;
    *) echo "未知参数：$arg（--skip-verify | --help）" >&2; exit 2 ;;
  esac
done

echo "==> 1/4 git pull"
git pull --ff-only

echo "==> 2/4 pnpm install"
pnpm install

echo "==> 3/4 pnpm build（shared + engine + web）"
pnpm --filter @cloudmind/shared --filter @cloudmind/engine --filter @cloudmind/web build

if [ "$SKIP_VERIFY" = true ]; then
  echo "==> 4/4 已按 --skip-verify 跳过 pnpm verify"
else
  echo "==> 4/4 pnpm verify（lint + typecheck + test + cargo 三关）"
  pnpm verify
fi

echo
echo "更新完成。请重启你的 engine 与 web 进程生效。"
echo "若你在使用 sidecar（向量记忆），请一并重 build：cargo build --release --manifest-path crates/zome-sidecar/Cargo.toml"
