import { describe, it, expect, beforeAll, afterAll } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import grpc from "@grpc/grpc-js";
import protoLoader from "@grpc/proto-loader";
import { SidecarClient } from "../../src/sidecar/client.js";

// 最小集成测试：用真实 proto 起一个进程内 gRPC server，验证 Upsert/Search 的
// snake_case 字段（agent_id/doc_id/top_k）经 proto-loader 序列化后完好往返。
// 回归背景：loadSync 未设 keepCase 时字段被转 camelCase，请求键被整体丢弃。
/* eslint-disable @typescript-eslint/no-explicit-any */

const PROTO_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../../crates/zome-sidecar/proto/zome.proto",
);

describe("SidecarClient gRPC 字段往返", () => {
  let server: grpc.Server;
  let client: SidecarClient;
  const upsertRequests: any[] = [];
  const searchRequests: any[] = [];
  const deleteRequests: any[] = [];

  beforeAll(async () => {
    const def = protoLoader.loadSync(PROTO_PATH, { keepCase: true, longs: Number, defaults: true });
    const pkg = grpc.loadPackageDefinition(def) as any;
    server = new grpc.Server();
    server.addService(pkg.zome.ZomeSidecar.service, {
      Health: (_call: any, cb: any) => cb(null, { status: "ok" }),
      Upsert: (call: any, cb: any) => {
        upsertRequests.push(call.request);
        cb(null, {});
      },
      Search: (call: any, cb: any) => {
        searchRequests.push(call.request);
        cb(null, { results: [{ doc_id: "doc-1", score: 0.9 }] });
      },
      DeleteAgent: (call: any, cb: any) => {
        deleteRequests.push(call.request);
        cb(null, {});
      },
    });
    const port = await new Promise<number>((resolve, reject) => {
      server.bindAsync("127.0.0.1:0", grpc.ServerCredentials.createInsecure(), (err, p) =>
        err ? reject(err) : resolve(p),
      );
    });
    server.start();
    client = new SidecarClient(`127.0.0.1:${port}`);
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.tryShutdown(() => resolve()));
  });

  it("upsert 成功且服务端收到的 agent_id/doc_id/embedding 完整", async () => {
    const ok = await client.upsert("agent-1", "doc-1", [0.1, 0.2, 0.3]);
    expect(ok).toBe(true);
    expect(upsertRequests).toHaveLength(1);
    expect(upsertRequests[0].agent_id).toBe("agent-1");
    expect(upsertRequests[0].doc_id).toBe("doc-1");
    expect(upsertRequests[0].embedding).toHaveLength(3);
  });

  it("search 发送 agent_id/top_k 并正确解析响应 doc_id", async () => {
    const hits = await client.search("agent-1", [0.1, 0.2], 5);
    expect(searchRequests).toHaveLength(1);
    expect(searchRequests[0].agent_id).toBe("agent-1");
    expect(Number(searchRequests[0].top_k)).toBe(5);
    expect(hits).toEqual([{ id: "doc-1", score: expect.closeTo(0.9, 5) }]);
  });

  it("deleteAgent 发送 agent_id（P1-3）", async () => {
    const ok = await client.deleteAgent("agent-1");
    expect(ok).toBe(true);
    expect(deleteRequests).toHaveLength(1);
    expect(deleteRequests[0].agent_id).toBe("agent-1");
  });
});
