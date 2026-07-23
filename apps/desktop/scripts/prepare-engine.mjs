// tauri beforeBuildCommand 的统一入口（cwd 是 apps/desktop）：
// 转发到仓库根的 engine 打包脚本，实际逻辑见 scripts/prepare-engine.mjs
import "../../../scripts/prepare-engine.mjs";
