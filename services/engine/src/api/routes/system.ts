import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { FastifyInstance } from "fastify";
import { DEFAULT_ENGINE_PORT } from "@cloudmind/shared";
import type { ApiContext } from "../context.js";
import { getDataDir } from "../../config/paths.js";
import { getGitShortHash } from "../../git-commit.js";
import { logger } from "../../logger.js";

/**
 * 模块目录：esbuild CJS bundle 下 import.meta.url 为空、fileURLToPath 抛错，
 * 兜底 process.cwd()（git-commit.ts 同款防御）——version 查找退回 cwd 分支
 */
const MODULE_DIR = (() => {
  try {
    return path.dirname(fileURLToPath(import.meta.url));
  } catch {
    return process.cwd();
  }
})();

/**
 * 从 startDir 向上找 engine 自身 package.json 并读 version（findBuiltinSkillsDir
 * 向上查找先例）：dev(tsx) 起自 src/api/routes、tsc 产物起自 dist/src/api/routes
 * 都能命中包根；name 校验防向上途中命中 monorepo 内其他包的 package.json
 */
async function readEngineVersion(startDir: string): Promise<string | undefined> {
  let dir = startDir;
  for (let i = 0; i < 6; i++) {
    try {
      const pkg = JSON.parse(await fs.readFile(path.join(dir, "package.json"), "utf-8")) as {
        name?: unknown;
        version?: unknown;
      };
      if (pkg.name === "@cloudmind/engine" && typeof pkg.version === "string") {
        return pkg.version;
      }
    } catch {
      // 不存在/不可读/非 JSON → 继续向上
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return undefined;
}

// 版本运行期不变，模块级缓存避免每请求读盘；undefined 表示尚未查过（"unknown" 也缓存）
let versionCache: string | undefined;

async function getEngineVersion(): Promise<string> {
  if (versionCache !== undefined) return versionCache;
  // 模块目录优先（不随进程启动目录漂移），cwd 兜底（bundle/异常启动目录场景）
  versionCache = (await readEngineVersion(MODULE_DIR)) ?? (await readEngineVersion(process.cwd()));
  if (versionCache === undefined) {
    logger.warn("[system] 未找到 engine 的 package.json，version 按 unknown 返回");
    versionCache = "unknown";
  }
  return versionCache;
}

export async function registerSystemRoutes(app: FastifyInstance, context: ApiContext) {
  app.get("/system/info", {
    schema: { summary: "Get engine system info", tags: ["system"] },
  }, async () => {
    // 无 git（打包分发）时省略 gitCommit 字段，与启动 banner 同口径（S1）
    const gitCommit = getGitShortHash();
    return {
      version: await getEngineVersion(),
      ...(gitCommit !== undefined ? { gitCommit } : {}),
      dataDir: getDataDir(),
      // 与 http 插件 listen 面同一 PORT env 解析表达式（plugins/http/index.ts）
      port: Number(process.env.PORT || DEFAULT_ENGINE_PORT),
      uptimeSec: Math.floor(process.uptime()),
      sidecar: {
        // configured 含义 = SidecarClient 已装配进 ApiContext：构造时
        // ZOME_SIDECAR_ADDR 缺省即回退默认地址（sidecar/client.ts），
        // 故不代表 sidecar 进程实际在跑，只表示引擎侧客户端存在
        configured: context.sidecarClient !== undefined,
      },
    };
  });
}
