import { isExtToolName } from "../context/tool-classify.js";
import type { Tool } from "../tools/types.js";

/** loaded set 上限（session 粘性，满则 LRU 逐出最久未用——spec 决策 4） */
export const DYNAMIC_TOOL_LOADED_CAP = 16;
/** 目录 blurb 长度上限（描述首句再截 ~80，spec 决策 2） */
export const CATALOG_BLURB_MAX = 80;

export interface LoadResult {
  /** 本次新取回的动态工具 */
  loaded: Tool[];
  /** 注册表里查无此名 */
  unknown: string[];
  /** 已常驻：内置工具名（无需取回）或已在 loaded 集的名（重复取回，LRU 已刷新） */
  resident: string[];
}

/** load 的纯分类视图（不落任何状态）：load_tool 组 fail-closed 文案用 */
export interface LoadClassification {
  /** 新取回（动态工具且未 loaded） */
  fresh: Tool[];
  /** 重复取回（动态工具且已 loaded，合法但无事发生——仅 LRU 刷新） */
  repeat: Tool[];
  /** 内置常驻名（非动态工具但注册表里有） */
  builtin: string[];
  /** 注册表查无此名 */
  unknown: string[];
}

export interface CatalogEntry {
  name: string;
  /** 描述首句截 ~80 字符 */
  blurb: string;
}

/** 描述首句：取到首个句读/换行为止；再截 CATALOG_BLURB_MAX */
function firstSentenceBlurb(description: string): string {
  const firstLine = description.split("\n", 1)[0] ?? "";
  const match = /^.*?[。！？.!?]/.exec(firstLine);
  const sentence = match ? match[0] : firstLine;
  return sentence.length <= CATALOG_BLURB_MAX
    ? sentence
    : `${sentence.slice(0, CATALOG_BLURB_MAX)}…`;
}

/**
 * 动态工具加载器（spec 决策 4，worker 级单实例）：持 `mcp__`/`ext__` 动态工具
 * 全量源（构造时从全量注册表滤出，注册序保持）与 session 粘性 loaded set
 * （上限 16，LRU——取回/重复取回刷新序，满则逐出最久未用）。
 * worker 退役/重建天然清空（config 变更语义无额外状态）；不持久化（重启即空，
 * 重取一跳，spec §5 非目标）。
 */
export class DynamicToolLoader {
  /** 全量动态工具源（mcp__/ext__，注册序） */
  private readonly dynamicTools = new Map<string, Tool>();
  /** 全量注册表名字集（resident/unknown 分类用） */
  private readonly allNames = new Set<string>();
  /**
   * loaded set：Map 键序 = 最近取回在前（MRU）——进 l6Ext 后 halve 保前部 =
   * 保最近取回的（与 layers.ts「按优先级降序、保前部」口径一致；主控终审
   * 修复：旧版最久未用在前会优先裁掉刚取回的，语义相反）。LRU 逐出从尾部
   * （最久未取回）。LRU 口径 = 取回序，不接执行缝刷新（成本裁定）。
   */
  private loaded = new Map<string, Tool>();
  /** 每件工具的取回序号（每次成功 load 提交单调 +1，含重复取回）：turn 对账的复活判据 */
  private readonly loadSeqs = new Map<string, number>();

  /** @param tools 全量 Tool 注册表（worker config.tools），内部按 isExtToolName 滤动态 */
  constructor(tools: Tool[]) {
    for (const tool of tools) {
      this.allNames.add(tool.name);
      if (isExtToolName(tool.name)) this.dynamicTools.set(tool.name, tool);
    }
  }

  /** 动态工具总数（0 = 无动态工具 agent，目录段不渲染的恒等判据） */
  get dynamicCount(): number {
    return this.dynamicTools.size;
  }

  /** 当前 loaded 集（MRU 序：最近取回在前） */
  loadedTools(): Tool[] {
    return [...this.loaded.values()];
  }

  /** 该工具的取回序号（未取回过为 0）：turn 对账判「轮内新取回/显式复活」用 */
  loadSeqOf(name: string): number {
    return this.loadSeqs.get(name) ?? 0;
  }

  /** 未 loaded 动态工具的目录条目（注册序） */
  catalog(): CatalogEntry[] {
    const entries: CatalogEntry[] = [];
    for (const [name, tool] of this.dynamicTools) {
      if (this.loaded.has(name)) continue;
      entries.push({ name, blurb: firstSentenceBlurb(tool.description) });
    }
    return entries;
  }

  /** 可用动态工具名录（fail-closed 错误文案用，注册序） */
  availableNames(): string[] {
    return [...this.dynamicTools.keys()];
  }

  private touch(name: string, tool: Tool): void {
    // MRU 刷新：删后重建挪到键序头部（最近取回在前）；取回序号单调 +1
    this.loaded.delete(name);
    this.loaded = new Map([[name, tool], ...this.loaded]);
    this.loadSeqs.set(name, (this.loadSeqs.get(name) ?? 0) + 1);
    while (this.loaded.size > DYNAMIC_TOOL_LOADED_CAP) {
      // 尾键 = 最久未取回，逐出
      let oldest: string | undefined;
      for (const k of this.loaded.keys()) oldest = k;
      if (oldest === undefined) break;
      this.loaded.delete(oldest);
    }
  }

  /** 纯分类（不读写 loaded set）：四分互斥 */
  classify(names: string[]): LoadClassification {
    const result: LoadClassification = { fresh: [], repeat: [], builtin: [], unknown: [] };
    for (const name of names) {
      const tool = this.dynamicTools.get(name);
      if (tool) {
        if (this.loaded.has(name)) result.repeat.push(tool);
        else result.fresh.push(tool);
      } else if (this.allNames.has(name)) {
        // 注册表里有但不是动态工具 = 内置常驻名
        result.builtin.push(name);
      } else {
        result.unknown.push(name);
      }
    }
    return result;
  }

  /**
   * 取回：先纯分类——有未知名或内置名时整体 fail-closed（spec 4.3：
   * 结构化错误，不写 loaded set）；全合法才提交（新取回入 set +
   * 重复取回刷新 LRU，超 cap 逐出最久未用）。
   */
  load(names: string[]): LoadResult {
    const c = this.classify(names);
    if (c.unknown.length > 0 || c.builtin.length > 0) {
      return { loaded: [], unknown: c.unknown, resident: [...c.builtin, ...c.repeat.map((t) => t.name)] };
    }
    for (const tool of c.fresh) this.touch(tool.name, tool);
    for (const tool of c.repeat) this.touch(tool.name, tool);
    return { loaded: c.fresh, unknown: [], resident: c.repeat.map((t) => t.name) };
  }
}
