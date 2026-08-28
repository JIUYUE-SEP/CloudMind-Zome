import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { DynamicToolLoader } from "../../src/core/dynamic-tool-loader.js";
import { ToolBlurbStore, descHashOf } from "../../src/core/tool-blurb-store.js";
import type { LLMProvider, LLMChatParams, LLMEvent } from "../../src/provider/types.js";
import type { Tool } from "../../src/tools/types.js";

let tmpDir: string;
let store: ToolBlurbStore;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "tool-blurb-loader-"));
  store = new ToolBlurbStore(path.join(tmpDir, "tool-blurbs.json"));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

function makeTool(name: string, description: string): Tool {
  return {
    name,
    description,
    parameters: z.object({}),
    accesses: [{ resource: "network", action: "read" }],
    async execute() {
      return { success: true, output: "ok" };
    },
  };
}

class StubProvider implements LLMProvider {
  name = "stub";
  callCount = 0;
  constructor(private readonly lines: string) {}
  supportsModel() {
    return true;
  }
  async *chat(params: LLMChatParams): AsyncIterable<LLMEvent> {
    void params;
    this.callCount++;
    yield { type: "text.delta", delta: this.lines };
    yield { type: "step.end" };
  }
}

describe("DynamicToolLoader blurb 策展（spec 决策 1-5）", () => {
  it("首次出现：一次调用，LLM blurb 进 catalog，成功件落盘 source:llm", async () => {
    const loader = new DynamicToolLoader([makeTool("mcp__a__t1", "一个很长的描述。第二句。")]);
    const provider = new StubProvider("mcp__a__t1\tLLM 概括版");
    await loader.ensureBlurbs(provider, "m", store);

    expect(provider.callCount).toBe(1);
    expect(loader.catalog()[0]!.blurb).toBe("LLM 概括版");
    const disk = await store.get("mcp__a__t1");
    expect(disk!.source).toBe("llm");
    expect(disk!.descHash).toBe(descHashOf("一个很长的描述。第二句。"));
  });

  it("再重建读盘命中零调用（spy 断言）；blurbFor 未命中回落机械版", async () => {
    const provider = new StubProvider("mcp__a__t1\tLLM 概括版");
    const desc = "一个很长的描述。第二句。";
    await new DynamicToolLoader([makeTool("mcp__a__t1", desc)]).ensureBlurbs(provider, "m", store);
    expect(provider.callCount).toBe(1);

    // 新 loader（模拟 worker 重建/重启）：读盘命中，零 LLM 调用
    const loader2 = new DynamicToolLoader([makeTool("mcp__a__t1", desc)]);
    await loader2.ensureBlurbs(provider, "m", store);
    expect(provider.callCount).toBe(1);
    expect(loader2.catalog()[0]!.blurb).toBe("LLM 概括版");

    // 未策展（未 ensure）的 loader：机械截断
    const loader3 = new DynamicToolLoader([makeTool("mcp__a__t1", desc)]);
    expect(loader3.blurbFor("mcp__a__t1", desc)).toBe("一个很长的描述。");
  });

  it("描述哈希变：只重算该件，另一件读盘复用零重算", async () => {
    const provider = new StubProvider("mcp__a__t1\t概括一\nmcp__a__t2\t概括二");
    await new DynamicToolLoader([
      makeTool("mcp__a__t1", "描述一。"),
      makeTool("mcp__a__t2", "描述二。"),
    ]).ensureBlurbs(provider, "m", store);
    expect(provider.callCount).toBe(1);
    const before = await store.get("mcp__a__t2");

    // t1 描述变更 → 只有 t1 进批重算
    const provider2 = new StubProvider("mcp__a__t1\t概括一新版");
    const loader2 = new DynamicToolLoader([
      makeTool("mcp__a__t1", "描述一改版了。"),
      makeTool("mcp__a__t2", "描述二。"),
    ]);
    await loader2.ensureBlurbs(provider2, "m", store);
    expect(provider2.callCount).toBe(1);
    expect(loader2.blurbFor("mcp__a__t1", "描述一改版了。")).toBe("概括一新版");
    expect(loader2.blurbFor("mcp__a__t2", "描述二。")).toBe("概括二");
    // t2 条目未被重写（updatedAt/descHash 不变）
    expect(await store.get("mcp__a__t2")).toEqual(before);
    expect((await store.get("mcp__a__t1"))!.descHash).toBe(descHashOf("描述一改版了。"));
  });

  it("降级不落盘：解析失败 → 缺席（不写盘不写映射），catalog 回落机械版，下次重建重试", async () => {
    const loader = new DynamicToolLoader([makeTool("mcp__a__t1", "一个很长的描述。第二句。")]);
    const garbage = new StubProvider("这是一段没有制表符的垃圾输出");
    await loader.ensureBlurbs(garbage, "m", store);

    expect(garbage.callCount).toBe(1); // 解析失败不重试
    expect(await store.getAll()).toEqual({}); // 降级不落盘
    expect(loader.catalog()[0]!.blurb).toBe("一个很长的描述。"); // 机械降级

    // 下次（新 loader）自动重试：这次产出正常则成功落盘
    const good = new StubProvider("mcp__a__t1\t重试成功版");
    const loader2 = new DynamicToolLoader([makeTool("mcp__a__t1", "一个很长的描述。第二句。")]);
    await loader2.ensureBlurbs(good, "m", store);
    expect(good.callCount).toBe(1);
    expect((await store.get("mcp__a__t1"))!.blurb).toBe("重试成功版");
  });

  it("user 条目永不被自动重新生成覆盖（v3 兼容位），即使描述哈希已变", async () => {
    await store.upsert([
      [
        "mcp__a__t1",
        { blurb: "用户手写版", descHash: "stalehash", source: "user", updatedAt: "2026-08-26T00:00:00.000Z" },
      ],
    ]);
    const provider = new StubProvider("mcp__a__t1\tLLM 版不该出现");
    const loader = new DynamicToolLoader([makeTool("mcp__a__t1", "新描述。")]);
    await loader.ensureBlurbs(provider, "m", store);

    expect(provider.callCount).toBe(0);
    expect(loader.catalog()[0]!.blurb).toBe("用户手写版");
    expect((await store.get("mcp__a__t1"))!.source).toBe("user");
  });

  it("恒等：无动态工具零调用零落盘", async () => {
    const loader = new DynamicToolLoader([makeTool("read_file", "内置。")]);
    const provider = new StubProvider("x\ty");
    await loader.ensureBlurbs(provider, "m", store);
    expect(provider.callCount).toBe(0);
    await expect(fs.access(store.filePath)).rejects.toThrow();
  });
});
