import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawn, execSync, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import grpc from "@grpc/grpc-js";
import protoLoader from "@grpc/proto-loader";
import { SidecarClient } from "../../src/sidecar/client.js";

/**
 * TS↔Rust 真实链路冒烟（P5-3，质量 review M2）：
 * 起真实 zome-sidecar 二进制（非 mock），经真实 TS 客户端跑通
 * Health / Upsert / Search / DeleteAgent——钉住"TS 客户端与 Rust server
 * 的协议（keepCase 字段名、距离语义）与行为（隔离、逐出）一致"这件事。
 * 这条链路是 P0-5（HNSW）、P1-3（DeleteAgent）、P1-1（版本）的共同基础。
 *
 * 运行成本与入口：需要 sidecar 二进制（cargo build，首次数分钟、增量秒级），
 * 因此不进默认套件（vitest.config.ts 已排除 *.smoke.test.ts），统一经
 * `pnpm --filter @mindcloud/engine test:sidecar` 运行（先 cargo build 再跑本文件）。
 * sidecar 数据目录指向临时目录，不碰真实用户数据。
 *
 * Health 为什么走裸 gRPC 而不走 SidecarClient.isAvailable：Health 的 Rust 实现
 * 内部要查 engine 的 HTTP /health（reqwest 3s 超时），stub engine 不监听 8848
 * 且本机对该端口的 TCP 连接是悬置超时（≈3s）而非即时拒绝，Health 整体必然
 * 超过 isAvailable 的 1s deadline（DEADLINE_EXCEEDED → 按不可用降级）。
 * 裸 gRPC 给 10s deadline 验证的是"Health RPC 端到端通"这件事本身。
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MONOREPO_ROOT = path.resolve(HERE, "../../../..");
const EXE = process.platform === "win32" ? "zome-sidecar.exe" : "zome-sidecar";
const SIDECAR_ADDR = "127.0.0.1:50051"; // server.rs 固定绑定（无 env 覆盖）
const PROTO_PATH = path.join(MONOREPO_ROOT, "crates", "zome-sidecar", "proto", "zome.proto");

function findSidecarBinary(): string | undefined {
  const candidates = [
    path.join(MONOREPO_ROOT, "crates", "zome-sidecar", "target", "debug", EXE),
    path.join(MONOREPO_ROOT, "crates", "zome-sidecar", "target", "release", EXE),
  ];
  return candidates.find((p) => fs.existsSync(p));
}

/** 裸 gRPC Health（与 F:/tmp/cmz-bench/grpc-probe.mjs 同款加载方式，keepCase 对齐 TS 客户端） */
function rawHealth(): Promise<{ status: string }> {
  const def = protoLoader.loadSync(PROTO_PATH, { longs: Number, defaults: true, keepCase: true });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- 动态包定义
  const pkg = grpc.loadPackageDefinition(def) as any;
  const client = new pkg.zome.ZomeSidecar(SIDECAR_ADDR, grpc.credentials.createInsecure());
  return new Promise((resolve, reject) => {
    client.Health({}, { deadline: Date.now() + 10_000 }, (err: unknown, res: { status: string }) => {
      client.close();
      if (err) reject(err);
      else resolve(res);
    });
  });
}

/** Windows 上 child.kill() 只杀父进程（stub engine 会成孤儿），用 taskkill 杀整棵树 */
function killTree(child: ChildProcess): void {
  if (child.pid === undefined) return;
  if (process.platform === "win32") {
    try {
      execSync(`taskkill /PID ${child.pid} /T /F`, { stdio: "ignore" });
    } catch {
      // 已退出
    }
  } else {
    try {
      child.kill("SIGTERM"); // sidecar 收到信号会级联关闭 engine 子进程
    } catch {
      // 已退出
    }
  }
}

describe("TS↔Rust sidecar 真实链路冒烟（P5-3）", () => {
  let child: ChildProcess | undefined;
  let tmpDir = "";
  let logTail = "";
  let ready = false;
  let skipReason = "";
  const client = new SidecarClient(SIDECAR_ADDR);

  beforeAll(async () => {
    const binary = findSidecarBinary();
    if (!binary) {
      skipReason = "未找到 sidecar 二进制——先经 pnpm --filter @mindcloud/engine test:sidecar 运行（会自动 cargo build）";
      return;
    }
    tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "zome-sidecar-smoke-"));
    // sidecar 的 supervisor 会强制 spawn 一个 node engine（main.rs 无条件调用）：
    // 指向 stub，避免拉起真实 engine 占 8848（F:/tmp/cmz-bench 的同款做法）
    const stubEntry = path.join(tmpDir, "stub-engine.mjs");
    await fsp.writeFile(stubEntry, "setInterval(() => {}, 1000);\n");

    child = spawn(binary, [], {
      env: {
        ...process.env,
        CLOUDMIND_DATA_DIR: tmpDir,
        ZOME_ENGINE_ENTRY: stubEntry,
        ZOME_NODE_PATH: process.execPath,
        RUST_LOG: "info",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    // tracing fmt 写 stdout，stderr 一并收入诊断尾缀
    const appendLog = (chunk: Buffer) => {
      logTail = (logTail + chunk.toString()).slice(-4000);
    };
    child.stderr?.on("data", appendLog);
    child.stdout?.on("data", appendLog);

    // 就绪探测：真实 gRPC Health 往返（stub engine 下 Health 内部等 8848 超时 ≈3s，
    // 未就绪时连接失败则快速返回；冷启动给足余量）
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      if (child.exitCode !== null) break;
      try {
        await rawHealth();
        ready = true;
        break;
      } catch {
        await new Promise((r) => setTimeout(r, 500));
      }
    }
    if (!ready) {
      // 端口被真实 sidecar 占用是环境问题（本机正在跑桌面端/dev sidecar），跳过而非误报；
      // 其余启动失败（二进制损坏、数据目录异常）是真失败信号，不遮蔽
      if (child.exitCode !== null && /addr|address|50051/i.test(logTail)) {
        skipReason = `sidecar 启动失败（疑似 50051 端口被占）：${logTail.trim().slice(-200)}`;
      } else {
        killTree(child);
        throw new Error(`sidecar 30s 内未就绪（exitCode=${child.exitCode}）：\n${logTail.trim()}`);
      }
    }
  }, 60_000);

  afterAll(async () => {
    if (child && child.exitCode === null) {
      killTree(child);
      await new Promise<void>((resolve) => {
        child!.once("exit", () => resolve());
        setTimeout(resolve, 5_000);
      });
    }
    if (tmpDir) await fsp.rm(tmpDir, { recursive: true, force: true });
  });

  function guard(ctx: { skip: (msg?: string) => never }): void {
    if (!ready) ctx.skip(skipReason || "sidecar 未就绪");
  }

  it("Health：真实 sidecar 的 Health RPC 端到端通（stub engine 下为 degraded）", async (ctx) => {
    guard(ctx);
    const res = await rawHealth();
    expect(["ok", "degraded"]).toContain(res.status);
  });

  it("Upsert/Search 往返：写入可按距离检索，字段映射（keepCase doc_id）正确", async (ctx) => {
    guard(ctx);
    const agent = `smoke${Date.now()}`;
    const v1 = [1, 0, 0, 0, 0, 0, 0, 0];
    const v2 = [0, 1, 0, 0, 0, 0, 0, 0];
    expect(await client.upsert(agent, "d1", v1)).toBe(true);
    expect(await client.upsert(agent, "d2", v2)).toBe(true);
    // 重复 upsert 同 doc_id 不产生重复文档（upsert 语义）
    expect(await client.upsert(agent, "d1", v1)).toBe(true);

    const hits = await client.search(agent, v1, 10);
    // sidecar 返回距离（1-cosine，越小越近）：完全同向 ≈ 0，正交 = 1
    expect(hits.map((h) => h.id)).toEqual(["d1", "d2"]);
    expect(hits[0]!.score).toBeLessThan(0.01);
    expect(hits[1]!.score).toBeGreaterThan(hits[0]!.score);
  });

  it("Search 隔离：未知 agent 返回空（不串库、不报错）", async (ctx) => {
    guard(ctx);
    const hits = await client.search(`nosuch${Date.now()}`, [1, 0, 0, 0], 5);
    expect(hits).toEqual([]);
  });

  it("DeleteAgent：逐出后检索为空（P1-3 级联清理语义）", async (ctx) => {
    guard(ctx);
    const agent = `smokedel${Date.now()}`;
    expect(await client.upsert(agent, "d1", [1, 0, 0, 0])).toBe(true);
    expect((await client.search(agent, [1, 0, 0, 0], 5)).length).toBe(1);

    expect(await client.deleteAgent(agent)).toBe(true);
    // 内存缓存已逐出：同 agent 再检索按未知 agent 处理返回空
    expect(await client.search(agent, [1, 0, 0, 0], 5)).toEqual([]);
  });
});
