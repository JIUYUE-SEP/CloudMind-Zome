import { describe, it, expect, vi } from "vitest";
import { resolveContextWindow } from "../../src/compute/context-window.js";
import { DEFAULT_CONTEXT_WINDOW } from "../../src/context/pipeline.js";
import { logger } from "../../src/logger.js";
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

  it("G4：查不到 contextWindow 时 warn 留痕（含 providerId/modelId；同 key 只一次）", async () => {
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
    try {
      // 型号未配置 contextWindow
      await resolveContextWindow(fakeRepo([provider("g4p1", [model("g4m1")])]), {
        providerId: "g4p1",
        modelId: "g4m1",
      });
      // provider 缺失
      await resolveContextWindow(fakeRepo([provider("g4p1", [model("g4m1", 128_000)])]), {
        providerId: "g4pX",
        modelId: "g4m1",
      });
      // 型号缺失
      await resolveContextWindow(fakeRepo([provider("g4p1", [model("g4m1", 128_000)])]), {
        providerId: "g4p1",
        modelId: "g4mX",
      });
      // 参数缺失（未接线/agent 未配置 provider）
      await resolveContextWindow(fakeRepo([provider("g4p1", [model("g4m1", 128_000)])]), {
        providerId: "g4p1",
        modelId: undefined,
      });

      expect(warn).toHaveBeenCalledTimes(4);
      // 首条：型号未配置 contextWindow，warn 带 providerId/modelId
      expect(warn.mock.calls[0]![0]).toMatchObject({ providerId: "g4p1", modelId: "g4m1" });
      for (const call of warn.mock.calls) {
        expect(String(call[1])).toContain("provider=");
        expect(String(call[1])).toContain("model=");
      }

      // 同 key 重复查只 warn 一次（防逐回合刷屏）
      await resolveContextWindow(fakeRepo([provider("g4p1", [model("g4m1")])]), {
        providerId: "g4p1",
        modelId: "g4m1",
      });
      expect(warn).toHaveBeenCalledTimes(4);
    } finally {
      warn.mockRestore();
    }
  });
});
