// tauri beforeBuildCommand 的统一入口（cwd 是 apps/desktop）：
// 转发到仓库根的 sidecar 准备脚本，实际逻辑见 scripts/prepare-sidecar.mjs
import "../../../scripts/prepare-sidecar.mjs";
