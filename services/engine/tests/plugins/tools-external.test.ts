import { describe, it, expect, beforeEach, afterEach, vi, type Mock } from "vitest";
import { Context } from "cordis";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import type { AgentConfig } from "@mindcloud/shared";
import { restoreDataDir } from "../helpers/env.js";
import { logger } from "../../src/logger.js";
import * as toolsPlugin from "../../src/plugins/tools/index.js";
import * as externalPlugin from "../../src/plugins/external/index.js";
import type { AgentsFace } from "../../src/plugins/agents/index.js";
import {
  isExternalToolName,
  qualifyExternalToolName,
} from "../../src/tools/external/naming.js";
import type { Tool } from "../../src/tools/types.js";

// 迁移第二阶段 E3：外部工具注册（tools 面 registerExternal/getExternal/forAgent 纳入）。
// 单测部分直挂 toolsPlugin（CLOUDMIND_DATA_DIR 指向空临时目录 → MCP 空集）；
// 全链路部分照 tests/plugins/external.test.ts 的 fixture 形态：E1 骨架加载的
// fixture 插件（inject ["tools"]）在 apply 里 registerExternal，再断言白名单启用。
// fixture 侧效果经 globalThis.__ext 通道断言（同 external.test.ts 的通道模式）。

/** fixture 侧效果记录通道（beforeEach 重置） */
const g = globalThis as { __ext?: Record<string, { ok1?: boolean; ok2?: boolean }> };

/** 最小工具构造（zod 真 schema；execute 不触发，仅占位） */
function makeTool(name: string, extra?: Partial<Tool>): Tool {
  return {
    name,
    description: `external ${name}`,
    parameters: z.object({}),
    accesses: [],
    async execute() {
      return { success: true, output: "ran" };
    },
    ...extra,
  };
}

describe("tools/external/naming（E3 命名规范化）", () => {
  it("短名直通 ext__<plugin>__<tool>；白名单外字符折叠、连续下划线折叠", () => {
    expect(qualifyExternalToolName("demo", "greet")).toBe("ext__demo__greet");
    // 与 mcp__ 同套 sanitize：段内非法字符→下划线（段尾下划线与分隔符相邻属预期）
    expect(qualifyExternalToolName("My Plugin!", "do thing")).toBe("ext__My_Plugin___do_thing");
  });

  it("超过 64 字符：截断 + FNV-1a 哈希后缀，总长恰为 64（确定性）", () => {
    const a = qualifyExternalToolName("p".repeat(40), "t".repeat(40));
    expect(a.length).toBe(64);
    expect(a.startsWith("ext__")).toBe(true);
    expect(/_[0-9a-f]{8}$/.test(a)).toBe(true);
    // 同输入同输出，不同输入不同后缀
    expect(qualifyExternalToolName("p".repeat(40), "t".repeat(40))).toBe(a);
    expect(qualifyExternalToolName("p".repeat(40), "x".repeat(40))).not.toBe(a);
  });

  it("isExternalToolName：ext__ 前缀命中，mcp__/内置名不命中", () => {
    expect(isExternalToolName("ext__demo__greet")).toBe(true);
    expect(isExternalToolName("mcp__demo__ping")).toBe(false);
    expect(isExternalToolName("read_file")).toBe(false);
  });
});

describe("plugins/tools registerExternal（E3 外部工具注册）", () => {
  let tempDir: string;
  let originalDataDir: string | undefined;
  let ctx: Context;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "tools-external-test-"));
    originalDataDir = process.env.CLOUDMIND_DATA_DIR;
    process.env.CLOUDMIND_DATA_DIR = tempDir;
    g.__ext = {};
    // 拦截 pino 输出；冲突跳过/白名单归一的 warn 经 warnText() 断言
    vi.spyOn(logger, "warn").mockImplementation(() => {});
    vi.spyOn(logger, "info").mockImplementation(() => {});
    ctx = new Context();
    await ctx.plugin(toolsPlugin);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    restoreDataDir(originalDataDir);
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  /** 全部 warn 调用参数拼一处（断言 includes / 为空） */
  function warnText(): string {
    return (logger.warn as unknown as Mock).mock.calls.map((args) => args.map(String).join(" ")).join("\n");
  }

  it("注册成功：限定名改写、getExternal 收录、返回 true", () => {
    expect(ctx.tools.registerExternal("demo", makeTool("greet"))).toBe(true);
    const registered = ctx.tools.getExternal();
    expect(registered.map((t) => t.name)).toEqual(["ext__demo__greet"]);
    // 其余字段原样保留
    expect(registered[0].description).toBe("external greet");
    expect(registered[0].accesses).toEqual([]);
    // getExternal 返回快照副本：改返回值不影响注册表
    registered.pop();
    expect(ctx.tools.getExternal().length).toBe(1);
  });

  it("冲突跳过：sanitize 后撞车 / 重复注册同名 → warn + 返回 false，不收编", () => {
    expect(ctx.tools.registerExternal("demo", makeTool("a b"))).toBe(true); // ext__demo__a_b
    expect(ctx.tools.registerExternal("demo", makeTool("a_b"))).toBe(false); // sanitize 后同名
    expect(ctx.tools.registerExternal("demo", makeTool("a b"))).toBe(false); // 重复注册
    expect(ctx.tools.getExternal().map((t) => t.name)).toEqual(["ext__demo__a_b"]);
    expect(warnText()).toContain("ext__demo__a_b");
    // 不同插件名空间隔离：另一插件注册同工具名不冲突
    expect(ctx.tools.registerExternal("other", makeTool("a_b"))).toBe(true);
  });

  it("requiresApproval 缺省从严：undefined 按 true 登记；显式 false/true 尊重插件自声明", () => {
    ctx.tools.registerExternal("demo", makeTool("d1")); // 缺省
    ctx.tools.registerExternal("demo", makeTool("d2", { requiresApproval: false })); // 声明只读
    ctx.tools.registerExternal("demo", makeTool("d3", { requiresApproval: true }));
    const byName = new Map(ctx.tools.getExternal().map((t) => [t.name, t.requiresApproval]));
    expect(byName.get("ext__demo__d1")).toBe(true); // 从严缺省
    expect(byName.get("ext__demo__d2")).toBe(false);
    expect(byName.get("ext__demo__d3")).toBe(true);
  });

  it("parameters 兼容：已是 zod schema 原样保留（同一引用）", () => {
    const zodParams = z.object({ q: z.string() });
    ctx.tools.registerExternal("demo", { ...makeTool("search"), parameters: zodParams });
    expect(ctx.tools.getExternal()[0].parameters).toBe(zodParams);
  });

  it("parameters 兼容：JSON Schema 对象注册时转 zod，safeParse 校验生效（合法通过/非法拒绝）", () => {
    // 外部插件是纯 JS（拿不到 zod）给 JSON Schema——object + 标量字段 + required
    const jsonSchema = {
      type: "object",
      properties: {
        path: { type: "string", description: "目标路径" },
        limit: { type: "integer" },
        verbose: { type: "boolean" },
      },
      required: ["path"],
    };
    expect(ctx.tools.registerExternal("demo", { ...makeTool("read_thing"), parameters: jsonSchema })).toBe(true);
    const registered = ctx.tools.getExternal()[0];
    // 合法通过：required 齐备 / 可选字段带类型正确
    expect(registered.parameters.safeParse({ path: "a.md" }).success).toBe(true);
    expect(registered.parameters.safeParse({ path: "a.md", limit: 3, verbose: true }).success).toBe(true);
    // 非法拒绝：缺 required / 标量类型错误
    expect(registered.parameters.safeParse({}).success).toBe(false);
    expect(registered.parameters.safeParse({ path: 42 }).success).toBe(false);
    expect(registered.parameters.safeParse({ path: "a.md", limit: "x" }).success).toBe(false);
  });

  it("parameters 兼容：边界形态（oneOf）按 MCP 既有口径降级 z.unknown()，不阻塞链路", () => {
    const boundary = { oneOf: [{ type: "string" }, { type: "number" }] };
    expect(ctx.tools.registerExternal("demo", { ...makeTool("flex"), parameters: boundary })).toBe(true);
    const registered = ctx.tools.getExternal()[0];
    // 降级为无约束：任意参数 safeParse 通过，参数校验转由插件 execute 自守
    expect(registered.parameters.safeParse({ anything: true }).success).toBe(true);
    expect(registered.parameters.safeParse(42).success).toBe(true);
  });

  it("parameters 兼容（F3）：省略/置 null 不抛 TypeError，降级 z.unknown() 注册成功", () => {
    // 纯 JS 插件省略 parameters 是合法形态——null-safe 探测走转换分支，
    // mcpInputSchemaToZod(undefined) 本就降级 z.unknown()（无约束）
    const noParams = makeTool("noparams");
    delete (noParams as { parameters?: unknown }).parameters; // 真正省略键（非显式 undefined）
    expect(ctx.tools.registerExternal("demo", noParams)).toBe(true);
    expect(
      ctx.tools.registerExternal("demo", { ...makeTool("nullparams"), parameters: null }),
    ).toBe(true);
    const byName = new Map(ctx.tools.getExternal().map((t) => [t.name, t]));
    // 两个工具都收编，schema 无约束（任意参数 safeParse 通过）
    expect(byName.get("ext__demo__noparams")!.parameters.safeParse({ x: 1 }).success).toBe(true);
    expect(byName.get("ext__demo__nullparams")!.parameters.safeParse(42).success).toBe(true);
  });

  it("forAgent：外部工具纳入白名单过滤——白名单含限定名才启用，与内置同管线", () => {
    ctx.tools.registerExternal("demo", makeTool("greet"));
    // 白名单含限定名：与内置工具一起装配（内置在前、外部居中、MCP 殿后）
    const picked = ctx.tools.forAgent({
      id: "a1",
      tools: ["ext__demo__greet", "dispatch_subagent"],
    } as AgentConfig);
    expect(picked.map((t) => t.name)).toEqual(["dispatch_subagent", "ext__demo__greet"]);
    // 白名单不含限定名：外部工具不启用（MCP 的「不参与白名单过滤」特例不适用于外部工具）
    const notPicked = ctx.tools.forAgent({ id: "a2", tools: ["dispatch_subagent"] } as AgentConfig);
    expect(notPicked.map((t) => t.name)).toEqual(["dispatch_subagent"]);
    // 未配置 tools 字段 → 空工具集（resolveConfiguredTools 归一语义不变）
    expect(ctx.tools.forAgent({ id: "a3" } as AgentConfig)).toEqual([]);
  });
});

describe("plugins/external × tools 全链路（E3：fixture 插件 apply 内注册工具）", () => {
  let tempDir: string;
  let originalDataDir: string | undefined;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "tools-external-e2e-"));
    originalDataDir = process.env.CLOUDMIND_DATA_DIR;
    process.env.CLOUDMIND_DATA_DIR = tempDir;
    g.__ext = {};
    vi.spyOn(logger, "warn").mockImplementation(() => {});
    vi.spyOn(logger, "info").mockImplementation(() => {});
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    restoreDataDir(originalDataDir);
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("E1 骨架加载的 fixture 插件 registerExternal → agent 白名单启用 → 出现在 forAgent 结果", async () => {
    // fixture 插件：inject ["tools"]，apply 里注册两个工具（一个审批缺省、一个声明只读）。
    // parameters 给真实 JSON Schema——fixture 位于临时 DATA_DIR 下，无 node_modules
    // 解析链，无法 bare-import zod，这正是外部作者的唯一可行形态（parameters 兼容
    // 转换的冒烟路径）；注册后断言语义校验行为（safeParse）
    const fixture = `
export const name = "hello";
export const inject = ["tools"];
export function apply(ctx) {
  const ok1 = ctx.tools.registerExternal("hello", {
    name: "greet",
    description: "fixture greet",
    parameters: {
      type: "object",
      properties: { who: { type: "string" } },
      required: ["who"],
    },
    accesses: [],
    async execute() { return { success: true, output: "hi" }; },
  });
  const ok2 = ctx.tools.registerExternal("hello", {
    name: "peek",
    description: "fixture peek（声明只读）",
    parameters: { type: "object", properties: { limit: { type: "integer" } } },
    accesses: [{ resource: "file", action: "read" }],
    requiresApproval: false,
    async execute() { return { success: true, output: "seen" }; },
  });
  globalThis.__ext["hello"] = { ok1, ok2 };
}
`;
    const pluginDir = path.join(tempDir, "plugins", "hello");
    await fs.mkdir(pluginDir, { recursive: true });
    await fs.writeFile(path.join(pluginDir, "index.mjs"), fixture);
    await fs.writeFile(path.join(tempDir, "plugins.json"), JSON.stringify({ plugins: { hello: {} } }));

    const ctx = new Context();
    // external 骨架 inject 依赖（同 external.test.ts 的最小 stub：list() 空枚举 = 无 per-agent 加载）
    ctx.provide("agents", { agentRepository: { list: async () => [] } } as unknown as AgentsFace);
    // 装配时序照 bootstrap：tools 先挂载（面上架），external 最后挂载
    await ctx.plugin(toolsPlugin);
    await ctx.plugin(externalPlugin);

    // 骨架加载落定 + fixture 的 apply 真实执行注册（两次均成功）
    expect(ctx.external.loaded).toEqual(["hello"]);
    expect(g.__ext?.hello).toEqual({ ok1: true, ok2: true });

    // 注册结果：限定名 + 审批从严缺省/自声明
    const external = ctx.tools.getExternal();
    expect(external.map((t) => t.name)).toEqual(["ext__hello__greet", "ext__hello__peek"]);
    expect(external[0].requiresApproval).toBe(true); // 缺省从严
    expect(external[1].requiresApproval).toBe(false); // 插件自声明只读

    // 冒烟：JSON Schema parameters 已转 zod——safeParse 校验生效（合法通过/非法拒绝）
    expect(external[0].parameters.safeParse({ who: "心智" }).success).toBe(true);
    expect(external[0].parameters.safeParse({}).success).toBe(false); // 缺 required
    expect(external[0].parameters.safeParse({ who: 42 }).success).toBe(false); // 类型错
    expect(external[1].parameters.safeParse({ limit: 3 }).success).toBe(true);
    expect(external[1].parameters.safeParse({ limit: "x" }).success).toBe(false);

    // 白名单启用：含限定名的 agent 装配出外部工具，不含则不启用
    const picked = ctx.tools.forAgent({ id: "a1", tools: ["ext__hello__greet"] } as AgentConfig);
    expect(picked.map((t) => t.name)).toEqual(["ext__hello__greet"]);
    // 白名单启用的工具同样带着转换后的 schema（preflight 不再崩）
    expect(picked[0].parameters.safeParse({ who: "zome" }).success).toBe(true);
    expect(picked[0].parameters.safeParse({ who: 1 }).success).toBe(false);
    const none = ctx.tools.forAgent({ id: "a2", tools: [] } as unknown as AgentConfig);
    expect(none).toEqual([]);
  });

  it("F3：fixture 插件注册省略 parameters 的工具——注册成功且插件不被带走（不记 apply-failed）", async () => {
    // 回归：旧实现对 undefined parameters 裸取 .safeParse 抛 TypeError，整个插件
    // 被记 apply-failed 带走；修复后省略 parameters 降级 z.unknown() 正常收编
    const fixture = `
export const name = "bare";
export const inject = ["tools"];
export function apply(ctx) {
  const ok = ctx.tools.registerExternal("bare", {
    name: "ping",
    description: "fixture ping（省略 parameters）",
    accesses: [],
    async execute() { return { success: true, output: "pong" }; },
  });
  globalThis.__ext["bare"] = { ok };
}
`;
    const pluginDir = path.join(tempDir, "plugins", "bare");
    await fs.mkdir(pluginDir, { recursive: true });
    await fs.writeFile(path.join(pluginDir, "index.mjs"), fixture);
    await fs.writeFile(path.join(tempDir, "plugins.json"), JSON.stringify({ plugins: { bare: {} } }));

    const ctx = new Context();
    ctx.provide("agents", { agentRepository: { list: async () => [] } } as unknown as AgentsFace);
    await ctx.plugin(toolsPlugin);
    await ctx.plugin(externalPlugin);

    // 插件正常激活（不被 TypeError 带走），注册成功
    expect(ctx.external.loaded).toEqual(["bare"]);
    expect(ctx.external.skipped).toEqual([]);
    expect(g.__ext?.bare).toEqual({ ok: true });

    // 省略 parameters 的工具收编为无约束 schema
    const external = ctx.tools.getExternal();
    expect(external.map((t) => t.name)).toEqual(["ext__bare__ping"]);
    expect(external[0].parameters.safeParse({ anything: true }).success).toBe(true);
  });
});
