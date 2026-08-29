import { describe, it, expect, afterAll } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  resolveSidecarBin,
  startSidecarIfEnabled,
  stopSidecar,
  __hasSpawnedChildForTest,
} from "../../src/sidecar/autostart.js";
import type { ConfigRepository } from "../../src/config/repository.js";

/**
 * sidecar 自启链路冒烟（spec 决策 7）：真二进制 + 真 spawn——发现序找到
 * 二进制 → 拉起 → 进程存活 → 两段式关停退出。默认套件排除（*.smoke.test.ts），
 * 经 `pnpm --filter @mindcloud/engine test:sidecar` 运行；环境无二进制/cargo
 * 时全档 skip 并注明。
 *
 * 不断言 Health 探活：sidecar 的 Health RPC 内部要回查 engine /health
 * （本档无 engine 监听，reqwest 3s 超时，超 isAvailable 的 deadline 假阴性——
 * 同 real-sidecar.smoke.test.ts 头注口径）。本档钉的是「自启机制本身」：
 * 发现/拉起/存活/关停四拍，协议面健康链路由 real-sidecar.smoke 覆盖。
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MONOREPO_ROOT = path.resolve(HERE, "../../../..");

const bin = await resolveSidecarBin({ repoDir: MONOREPO_ROOT });
const tmpDir = bin ? await fs.mkdtemp(path.join(os.tmpdir(), "sidecar-autostart-smoke-")) : "";

const enabledRepo = {
  load: async () => ({ settings: { sidecarAutoStart: true } }),
} as unknown as ConfigRepository;

afterAll(async () => {
  await stopSidecar({ killAfterMs: 3000 });
  if (tmpDir) await fs.rm(tmpDir, { recursive: true, force: true });
});

describe.skipIf(!bin)("sidecar 自启链路冒烟（真二进制）", () => {
  it("发现序命中 → 拉起 → 存活 → 关停退出", async () => {
    expect(bin).toBeDefined();
    // 探活必假（本档无 sidecar 在跑）：强制走 spawn 路径
    await startSidecarIfEnabled({
      configRepository: enabledRepo,
      sidecarClient: { isAvailable: async () => false },
      repoDir: MONOREPO_ROOT,
      envBin: undefined,
    });
    // spawn 是异步的：给进程 3s 起来（cargo run 兜底首次编译远超此——那时
    // 本断言的意义是"进程被拉起且未立即退出"，编译场景靠人工 smoke 观察）
    await new Promise((r) => setTimeout(r, 3000));
    expect(__hasSpawnedChildForTest()).toBe(true); // 拉起且未立即退出（error/exit 会清引用）
    // 关停：两段式后引用清空
    await stopSidecar({ killAfterMs: 3000 });
    expect(__hasSpawnedChildForTest()).toBe(false);
    await expect(stopSidecar()).resolves.toBeUndefined();
  }, 30_000);
});
