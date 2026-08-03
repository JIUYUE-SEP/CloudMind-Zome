import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { getDataDir } from "../config/paths.js";
import { logger } from "../logger.js";

/**
 * Puppet 型号库（单 3）：命名的预设包 = 角色定位 persona 片段 + 推荐工具白名单。
 * 派傀儡时选型号：persona 片段拼入傀儡基础设定；suggestedTools 只做窄化
 * （傀儡最终工具 = 调用方可用工具 ∩ 型号推荐），绝不扩权。
 * 自定义：DATA_DIR/puppet-models/*.json（每型号一文件），同名覆盖内置并 warn。
 */

export interface PuppetModelDefinition {
  name: string;
  description: string;
  /** 角色定位提示（中文，2-4 句），拼入傀儡基础设定 */
  personaSnippet: string;
  /** 推荐工具白名单；有值时对傀儡工具集做交集窄化，交集为空拒绝派遣 */
  suggestedTools?: string[];
}

export interface PuppetModelEntry extends PuppetModelDefinition {
  source: "builtin" | "custom";
}

export interface PuppetModelService {
  /** 内置 + 自定义合并列表（同名自定义覆盖内置），每项带来源标记 */
  list(): Promise<PuppetModelEntry[]>;
  /** 按名取型号（含同名自定义覆盖后的结果）；不存在返回 undefined */
  get(name: string): Promise<PuppetModelDefinition | undefined>;
}

/** 内置四型号（代码常量，不可删）：规划师 / 码农 / 调研员 / 审查员 */
const BUILTIN_PUPPET_MODELS: PuppetModelDefinition[] = [
  {
    name: "规划师",
    description: "拆解任务、制定步骤、识别依赖与风险",
    personaSnippet:
      "你是规划师型傀儡，擅长把模糊目标拆解成可执行步骤。" +
      "开工前先识别依赖、前置条件与风险点，再按依赖顺序制定计划。" +
      "你注重可验证的里程碑，并主动标注边界情况与回退方案。",
    suggestedTools: ["read_file", "list_files", "skill"],
  },
  {
    name: "码农",
    description: "写代码、读代码、修 bug，注重可运行与测试",
    personaSnippet:
      "你是码农型傀儡，擅长写代码、读代码与修 bug。" +
      "你优先保证实现可运行、关键路径有测试覆盖，改动后主动验证。" +
      "遇到不确定的 API 或行为先查证再动手，不臆造接口与数据。",
    suggestedTools: ["read_file", "list_files", "write_file", "edit_file", "bash", "run_command"],
  },
  {
    name: "调研员",
    description: "资料收集、对比分析、信息溯源",
    personaSnippet:
      "你是调研员型傀儡，擅长资料收集、对比分析与信息溯源。" +
      "你优先采用可靠来源并标注出处，明确区分事实与推断。" +
      "结论中说明证据强弱与不确定性，不编造数据。",
    suggestedTools: ["read_file", "list_files", "web_search", "skill"],
  },
  {
    name: "审查员",
    description: "找问题挑毛病、安全与边界审视、反向思考",
    personaSnippet:
      "你是审查员型傀儡，擅长找问题、挑毛病，从安全与边界角度审视方案。" +
      "你主动反向思考攻击面、异常输入与失败路径，并给出可复现的问题描述与修复建议。",
    suggestedTools: ["read_file", "list_files", "bash", "run_command", "skill"],
  },
];

/** 自定义型号文件 schema（字段校验失败 = 坏文件，跳过并 warn） */
const modelFileSchema = z.object({
  name: z.string().min(1, "name 必填"),
  description: z.string().min(1, "description 必填"),
  personaSnippet: z.string().min(1, "personaSnippet 必填"),
  suggestedTools: z.array(z.string().min(1)).optional(),
});

async function loadCustomModels(): Promise<PuppetModelDefinition[]> {
  const dir = path.join(getDataDir(), "puppet-models");
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch (err) {
    // 缺失目录按空（首次运行常态，不 warn）；其余读取错误 warn 后按空，不让 REST/派发炸掉
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    logger.warn({ err }, `[puppet-models] 自定义型号目录读取失败（按空处理）：${dir}`);
    return [];
  }

  const models: PuppetModelDefinition[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.toLowerCase().endsWith(".json")) continue;
    const filePath = path.join(dir, entry.name);
    try {
      const raw = await fs.readFile(filePath, "utf-8");
      const parsed = modelFileSchema.safeParse(JSON.parse(raw));
      if (!parsed.success) {
        logger.warn(
          { err: parsed.error },
          `[puppet-models] 自定义型号文件 ${entry.name} 校验失败，已跳过`,
        );
        continue;
      }
      models.push(parsed.data);
    } catch (err) {
      logger.warn({ err }, `[puppet-models] 自定义型号文件 ${entry.name} 加载失败，已跳过`);
    }
  }
  return models;
}

export function createPuppetModelService(): PuppetModelService {
  async function list(): Promise<PuppetModelEntry[]> {
    const customs = await loadCustomModels();
    const byName = new Map<string, PuppetModelEntry>();
    for (const model of BUILTIN_PUPPET_MODELS) {
      byName.set(model.name, { ...model, source: "builtin" });
    }
    for (const custom of customs) {
      if (byName.has(custom.name)) {
        logger.warn(`[puppet-models] 自定义型号「${custom.name}」覆盖内置型号`);
      }
      byName.set(custom.name, { ...custom, source: "custom" });
    }
    return Array.from(byName.values());
  }

  return {
    list,
    get: async (name) => (await list()).find((m) => m.name === name),
  };
}
