import { describe, it, expect } from "vitest";
import { resolveContextWindow } from "../../src/compute/context-window.js";
import { DEFAULT_CONTEXT_WINDOW } from "../../src/context/pipeline.js";
import type { ConfigRepository, GlobalConfig } from "../../src/config/repository.js";
import type { ProviderConfig } from "@mindcloud/shared";

function fakeRepo(providers: ProviderConfig[]): Pick<ConfigRepository, "load"> {
  const config: GlobalConfig = {
    providers,
    settings: {
      memory: { compactThreshold: 0.8, keepRecent: 3, hotMemoryLimit: 10, warmMemoryLimit: 20 },
    },
  };
  return { load: async () => config };
}

function provider(id: string, models: ProviderConfig["models"]): ProviderConfig {
  return {
    id,
    displayName: id,
    providerType: "openai",
    baseUrl: "http://localhost",
    models,
  };
}

function model(id: string, contextWindow?: number): ProviderConfig["models"][number] {
  return { id, displayName: id, modelType: "llm", contextWindow };
}

describe("resolveContextWindow（改动三 W 查找链）", () => {
  it("有型号表 contextWindow：按 providerId + modelId 查到并返回", async () => {
    const repo = fakeRepo([
      provider("p1", [model("m1", 128_000), model("m2")]),
      provider("p2", [model("m1", 200_000)]),
    ]);
    expect(await resolveContextWindow(repo, { providerId: "p1", modelId: "m1" })).toBe(128_000);
    // 同名 model 落在不同 provider：查链按 provider 先定位
    expect(await resolveContextWindow(repo, { providerId: "p2", modelId: "m1" })).toBe(200_000);
  });

  it("型号未配 contextWindow：返回 undefined（调用方落 80_000 缺省）", async () => {
    const repo = fakeRepo([provider("p1", [model("m1")])]);
    expect(await resolveContextWindow(repo, { providerId: "p1", modelId: "m1" })).toBeUndefined();
    expect(
      (await resolveContextWindow(repo, { providerId: "p1", modelId: "m1" })) ??
        DEFAULT_CONTEXT_WINDOW,
    ).toBe(80_000);
  });

  it("provider/model 查不到或无表：返回 undefined，回退缺省 80_000", async () => {
    const empty = fakeRepo([]);
    expect(await resolveContextWindow(empty, { providerId: "p1", modelId: "m1" })).toBeUndefined();
    expect(await resolveContextWindow(fakeRepo([provider("p1", [])]), { providerId: "p1", modelId: "m1" })).toBeUndefined();
    expect(
      (await resolveContextWindow(empty, { providerId: "p1", modelId: "m1" })) ??
        DEFAULT_CONTEXT_WINDOW,
    ).toBe(80_000);
  });

  it("repo/providerId/modelId 任一缺失：直接 undefined 不查表", async () => {
    const repo = fakeRepo([provider("p1", [model("m1", 128_000)])]);
    expect(await resolveContextWindow(undefined, { providerId: "p1", modelId: "m1" })).toBeUndefined();
    expect(await resolveContextWindow(repo, { providerId: undefined, modelId: "m1" })).toBeUndefined();
    expect(await resolveContextWindow(repo, { providerId: "p1", modelId: undefined })).toBeUndefined();
  });

  it("配置读取失败：返回 undefined 不抛错（水位按缺省兜底）", async () => {
    const repo = { load: async () => { throw new Error("config corrupt"); } };
    expect(await resolveContextWindow(repo, { providerId: "p1", modelId: "m1" })).toBeUndefined();
  });
});
