import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import {
  ToolCatalogService,
  applySkillBlurbOverrides,
  blurbStatusOf,
  type ToolCatalogDeps,
} from "../../src/core/tool-catalog-service.js";
import { ToolBlurbStore, descHashOf, type ToolBlurbEntry } from "../../src/core/tool-blurb-store.js";
import type { LLMProvider, LLMChatParams, LLMEvent } from "../../src/provider/types.js";
import type { Tool } from "../../src/tools/types.js";
import type { AgentConfig } from "@mindcloud/shared";

let tmpDir: string;
let store: ToolBlurbStore;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "tool-catalog-svc-"));
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
  prompts: string[] = [];
  constructor(private readonly lines: string) {}
  supportsModel() {
    return true;
  }
  async *chat(params: LLMChatParams): AsyncIterable<LLMEvent> {
    this.callCount++;
    this.prompts.push(
      params.messages
        .flatMap((m) => m.content)
        .filter((c): c is { type: "text"; text: string } => c.type === "text")
        .map((c) => c.text)
        .join(""),
    );
    yield { type: "text.delta", delta: this.lines };
    yield { type: "step.end" };
  }
}

const AGENT = { id: "a1", name: "a1" } as AgentConfig;
const T1 = makeTool("mcp__a__t1", "工具一描述。");
const T2 = makeTool("mcp__a__t2", "工具二描述。");
const T3 = makeTool("mcp__a__t3", "工具三描述。很长很长的第二句。");
const SKILLS = [
  { name: "code-review", description: "作者行：代码审查技能。" },
  { name: "deploy", description: "作者行：部署技能。" },
];

function entry(blurb: string, descHash: string, source: "llm" | "user"): ToolBlurbEntry {
  return { blurb, descHash, source, updatedAt: "2026-08-26T00:00:00.000Z" };
}

function makeDeps(overrides: Partial<ToolCatalogDeps> = {}): ToolCatalogDeps {
  return {
    store,
    toolsForAgent: () => [T1, T2, T3, makeTool("read_file", "内置。")],
    listSkills: async () => SKILLS,
    listAgents: async () => [AGENT],
    createProvider: async () => new StubProvider(""),
    modelOf: () => "m",
    ...overrides,
  };
}

describe("blurbStatusOf 四态", () => {
  it("llm/user/missing/stale 全判定（user 含哈希变也不为 stale）", () => {
    expect(blurbStatusOf(undefined, "d")).toBe("missing");
    expect(blurbStatusOf(entry("b", descHashOf("d"), "llm"), "d")).toBe("llm");
    expect(blurbStatusOf(entry("b", "stale-hash", "llm"), "d")).toBe("stale");
    expect(blurbStatusOf(entry("b", "stale-hash", "user"), "d")).toBe("user");
  });
});

describe("applySkillBlurbOverrides（SKILL.md 原文不动）", () => {
  it("user 条目覆盖 / llm 命中覆盖 / stale llm 回作者行 / 无条目作者行", () => {
    const skills = [
      { name: "a", description: "作者A。" },
      { name: "b", description: "作者B。" },
      { name: "c", description: "作者C。" },
      { name: "d", description: "作者D。" },
    ];
    const disk = {
      "skill:a": entry("用户改A", "any", "user"),
      "skill:b": entry("LLM版B", descHashOf("作者B。"), "llm"),
      "skill:c": entry("过期C", "stale", "llm"),
    };
    const lines = applySkillBlurbOverrides(skills, disk);
    expect(lines).toEqual(["- a：用户改A", "- b：LLM版B", "- c：作者C。", "- d：作者D。"]);
    // 输入不被改写（原文一个字不动）
    expect(skills.map((s) => s.description)).toEqual(["作者A。", "作者B。", "作者C。", "作者D。"]);
  });
});

describe("ToolCatalogService.catalog 三清单", () => {
  it("dynamic 四态 + skills 覆盖行 + builtin 恒 core", async () => {
    await store.upsert([
      ["mcp__a__t1", entry("LLM版一", descHashOf("工具一描述。"), "llm")],
      ["mcp__a__t2", entry("用户版二", "stale", "user")],
      ["skill:code-review", entry("用户审", "any", "user")],
    ]);
    // t3 无条目（missing）；再造一件 stale：改 t1 描述？不行——t1 已 llm 命中。
    // 加一件 llm 但哈希不对版的条目给 t3 改名不行，直接放 stale 条目到 t3：
    await store.upsertOne("mcp__a__t3", entry("过期三", "stale-hash", "llm"));
    const svc = new ToolCatalogService(makeDeps());
    const catalog = await svc.catalog(AGENT);

    expect(catalog.dynamic.map((d) => [d.name, d.status])).toEqual([
      ["mcp__a__t1", "llm"],
      ["mcp__a__t2", "user"],
      ["mcp__a__t3", "stale"],
    ]);
    expect(catalog.dynamic[0]!.blurb).toBe("LLM版一");
    expect(catalog.dynamic[1]!.blurb).toBe("用户版二");
    expect(catalog.dynamic[2]!.blurb).toBe("过期三"); // stale 展示条目（运行时仍可用）

    expect(catalog.skills.map((s) => [s.name, s.status])).toEqual([
      ["code-review", "user"],
      ["deploy", "missing"],
    ]);
    expect(catalog.skills[0]!.overrideBlurb).toBe("用户审");
    expect(catalog.skills[0]!.authorLine).toBe("作者行：代码审查技能。");
    expect(catalog.skills[1]!.overrideBlurb).toBeUndefined();

    expect(catalog.builtin.length).toBeGreaterThan(0);
    expect(catalog.builtin.every((b) => b.status === "core")).toBe(true);
    expect(catalog.builtin.find((b) => b.name === "read_file")!.blurb.length).toBeGreaterThan(0);
  });
});

describe("ToolCatalogService.regenerate", () => {
  it("缺省只碰 missing/stale：llm 命中与 user 不进批，成功件落盘 llm", async () => {
    await store.upsert([
      ["mcp__a__t1", entry("命中一", descHashOf("工具一描述。"), "llm")],
      ["mcp__a__t2", entry("用户二", "stale", "user")],
      ["mcp__a__t3", entry("过期三", "stale-hash", "llm")],
    ]);
    const provider = new StubProvider("mcp__a__t3\t重生三\nskill:code-review\t技能审\nskill:deploy\t技能部署");
    const svc = new ToolCatalogService(makeDeps({ createProvider: async () => provider }));
    const result = await svc.regenerate("a1", AGENT);

    expect(provider.callCount).toBe(1);
    // 批量只含 missing/stale 件：t3（stale）+ 两个 skill（missing）
    expect(result.generated.sort()).toEqual(["mcp__a__t3", "skill:code-review", "skill:deploy"]);
    expect(result.failed).toEqual([]);
    expect(result.skipped).toEqual([]);
    const prompt = provider.prompts[0]!;
    expect(prompt).not.toContain("工具一描述。"); // llm 命中不进批
    expect(prompt).not.toContain("工具二描述。"); // user 不进批
    expect((await store.get("mcp__a__t3"))!.blurb).toBe("重生三");
    expect((await store.get("skill:deploy"))!.source).toBe("llm");
    // user 条目原样未动
    expect((await store.get("mcp__a__t2"))!.blurb).toBe("用户二");
  });

  it("指定 names：user 跳过、非名录进 failed、skill:<name> 可重生成", async () => {
    await store.upsertOne("mcp__a__t2", entry("用户二", "stale", "user"));
    const provider = new StubProvider("mcp__a__t1\t新一\nskill:deploy\t新部署");
    const svc = new ToolCatalogService(makeDeps({ createProvider: async () => provider }));
    const result = await svc.regenerate("a1", AGENT, ["mcp__a__t2", "mcp__a__t1", "skill:deploy", "ghost"]);

    expect(result.skipped).toEqual(["mcp__a__t2"]);
    expect(result.generated.sort()).toEqual(["mcp__a__t1", "skill:deploy"]);
    expect(result.failed).toEqual(["ghost"]);
    expect((await store.get("mcp__a__t2"))!.blurb).toBe("用户二");
  });

  it("概括缺件：进 failed 且不落盘（降级=缺席）", async () => {
    const provider = new StubProvider("mcp__a__t1\t只有一件");
    const svc = new ToolCatalogService(makeDeps({ createProvider: async () => provider }));
    const result = await svc.regenerate("a1", AGENT, ["mcp__a__t1", "mcp__a__t3"]);

    expect(result.generated).toEqual(["mcp__a__t1"]);
    expect(result.failed).toEqual(["mcp__a__t3"]);
    expect(await store.get("mcp__a__t3")).toBeUndefined();
  });
});

describe("ToolCatalogService.findDescription / putUser", () => {
  it("动态工具名与 skill:<name> 命中；乱写键名 undefined（fail-closed）", async () => {
    const svc = new ToolCatalogService(makeDeps());
    expect(await svc.findDescription("mcp__a__t1")).toBe("工具一描述。");
    expect(await svc.findDescription("skill:deploy")).toBe("作者行：部署技能。");
    expect(await svc.findDescription("read_file")).toBeUndefined(); // 内置名不可编辑
    expect(await svc.findDescription("mcp__ghost__x")).toBeUndefined();
    expect(await svc.findDescription("skill:ghost")).toBeUndefined();
  });

  it("putUser 落盘 source:user 且 descHash 取当前描述", async () => {
    const svc = new ToolCatalogService(makeDeps());
    const written = await svc.putUser("mcp__a__t1", "我的简介", "工具一描述。");
    expect(written.source).toBe("user");
    const disk = await store.get("mcp__a__t1");
    expect(disk!.blurb).toBe("我的简介");
    expect(disk!.descHash).toBe(descHashOf("工具一描述。"));
  });
});
