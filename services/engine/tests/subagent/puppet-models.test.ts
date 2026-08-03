import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createPuppetModelService } from "../../src/subagent/puppet-models.js";
import { logger } from "../../src/logger.js";
import { restoreDataDir } from "../helpers/env.js";

let tmpDir: string;
let originalDataDir: string | undefined;

beforeEach(async () => {
  tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "puppet-models-test-"));
  originalDataDir = process.env.CLOUDMIND_DATA_DIR;
  process.env.CLOUDMIND_DATA_DIR = tmpDir;
});

afterEach(async () => {
  restoreDataDir(originalDataDir);
  await fsp.rm(tmpDir, { recursive: true, force: true });
});

async function writeCustom(name: string, body: unknown): Promise<void> {
  const dir = path.join(tmpDir, "puppet-models");
  await fsp.mkdir(dir, { recursive: true });
  await fsp.writeFile(path.join(dir, name), JSON.stringify(body), "utf-8");
}

describe("Puppet 型号库", () => {
  it("内置四型号：规划师/码农/调研员/审查员，persona 中文片段 + 推荐工具白名单", async () => {
    const service = createPuppetModelService();
    const models = await service.list();

    expect(models).toHaveLength(4);
    expect(models.map((m) => m.name)).toEqual(["规划师", "码农", "调研员", "审查员"]);
    for (const model of models) {
      expect(model.source).toBe("builtin");
      expect(model.description.length).toBeGreaterThan(0);
      expect(model.personaSnippet.length).toBeGreaterThan(0);
      // 2-4 句的中文角色定位（句号/感叹号计句）
      const sentenceCount = (model.personaSnippet.match(/[。！]/g) ?? []).length;
      expect(sentenceCount).toBeGreaterThanOrEqual(2);
      expect(sentenceCount).toBeLessThanOrEqual(4);
      expect(model.suggestedTools!.length).toBeGreaterThan(0);
    }
  });

  it("缺失自定义目录按空：仅返回内置四型号", async () => {
    const service = createPuppetModelService();
    const models = await service.list();
    expect(models.map((m) => m.source)).toEqual(["builtin", "builtin", "builtin", "builtin"]);
  });

  it("自定义目录加载：DATA_DIR/puppet-models/*.json 每型号一文件，带 source=custom", async () => {
    await writeCustom("data-analyzer.json", {
      name: "数据分析师",
      description: "数据分析与可视化",
      personaSnippet: "你是数据分析师型傀儡。你擅长清洗数据与寻找模式。结论基于证据。",
      suggestedTools: ["read_file", "bash"],
    });

    const service = createPuppetModelService();
    const models = await service.list();
    expect(models).toHaveLength(5);
    const custom = models.find((m) => m.name === "数据分析师")!;
    expect(custom).toMatchObject({
      source: "custom",
      description: "数据分析与可视化",
      suggestedTools: ["read_file", "bash"],
    });
  });

  it("坏文件跳过 warn：JSON 解析失败与 schema 校验失败都不进列表", async () => {
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
    await writeCustom("bad-json.json", "not-json{");
    await writeCustom("bad-schema.json", {
      name: "",
      description: "缺 name",
      personaSnippet: "x",
    });
    await writeCustom("good.json", {
      name: "好型号",
      description: "d",
      personaSnippet: "你是好型号。你认真干活。",
    });
    // 非 .json 文件忽略
    await fsp.writeFile(path.join(tmpDir, "puppet-models", "readme.txt"), "x", "utf-8");

    const service = createPuppetModelService();
    const models = await service.list();
    expect(models.map((m) => m.name)).not.toContain("坏文件");
    expect(models.map((m) => m.name)).not.toContain("");
    expect(models.find((m) => m.name === "好型号")).toBeDefined();
    expect(warn).toHaveBeenCalledTimes(2);
    warn.mockRestore();
  });

  it("额外字段（字段拼写错误）strictObject 拒绝：按坏文件跳过 warn", async () => {
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
    await writeCustom("typo.json", {
      name: "拼错字段型号",
      description: "d",
      personaSnippet: "你是拼错字段的型号。",
      suggestedTool: ["read_file"], // 拼错：suggestedTools 会静默丢失，strictObject 必须拒绝
    });

    const models = await createPuppetModelService().list();
    expect(models.map((m) => m.name)).not.toContain("拼错字段型号");
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it("personaSnippet 超上限（2000 字符）按坏文件跳过 warn", async () => {
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
    await writeCustom("long.json", {
      name: "超长型号",
      description: "d",
      personaSnippet: "x".repeat(2001),
    });

    const models = await createPuppetModelService().list();
    expect(models.map((m) => m.name)).not.toContain("超长型号");
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it("同名自定义覆盖内置并 warn（用户主权）", async () => {
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
    await writeCustom("override.json", {
      name: "规划师",
      description: "自定义规划师",
      personaSnippet: "你是自定义规划师型傀儡。你按用户的偏好规划。你记录风险。",
      suggestedTools: ["read_file"],
    });

    const service = createPuppetModelService();
    const models = await service.list();
    expect(models).toHaveLength(4);
    const planner = models.find((m) => m.name === "规划师")!;
    expect(planner.source).toBe("custom");
    expect(planner.description).toBe("自定义规划师");
    expect(planner.personaSnippet).toContain("自定义规划师");
    expect(planner.suggestedTools).toEqual(["read_file"]);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('自定义型号「规划师」覆盖内置型号'),
    );
    warn.mockRestore();
  });

  it("get：按名取型号（覆盖后取自定义），不存在返回 undefined", async () => {
    await writeCustom("override.json", {
      name: "码农",
      description: "自定义码农",
      personaSnippet: "你是自定义码农。你写可测试的代码。",
    });
    const service = createPuppetModelService();
    await expect(service.get("码农")).resolves.toMatchObject({ description: "自定义码农" });
    await expect(service.get("审查员")).resolves.toMatchObject({ source: "builtin" });
    await expect(service.get("幽灵型号")).resolves.toBeUndefined();
  });
});
