import { describe, expect, it, vi } from "vitest";
import { Context } from "cordis";
import { pathToFileURL } from "node:url";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * E4 示例插件防漂移（终审修复项）：docs/examples/plugins/hello/index.mjs 是用户
 * 照抄的参考实现——它必须永远能被真实加载路径挂载（E4 复审曾抓到 inject 缺
 * "tools" 的硬伤：示例在文档里躺坏而无自动化兜底）。本测试直接动态 import
 * 示例文件并挂载到真实 cordis Context 上跑通 apply。
 */

const EXAMPLE = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../../docs/examples/plugins/hello/index.mjs",
);

interface HelloModule {
  name: string;
  inject: string[];
  apply: (ctx: Context, config?: Record<string, unknown>) => void;
}

describe("docs 示例插件 hello（防漂移）", () => {
  it("四件套导出形态正确（name 与目录名一致、inject 含 tools、apply 为函数）", async () => {
    const mod = (await import(pathToFileURL(EXAMPLE).href)) as HelloModule;
    expect(mod.name).toBe("hello");
    expect(mod.inject).toEqual(["tools"]);
    expect(typeof mod.apply).toBe("function");
  });

  it("挂载到真实 cordis Context 后 apply 跑通：engine/ready 监听生效 + registerExternal 收到 JSON Schema 形态的 greet 工具", async () => {
    const mod = (await import(pathToFileURL(EXAMPLE).href)) as HelloModule;
    const registered: { name: string; parameters: unknown }[] = [];
    const root = new Context();
    // 示例 inject=["tools"]：提供最小 tools 面桩件（registerExternal 记录调用；
    // 真实引擎侧会在这里做限定名改写与 JSON Schema 转换，示例只负责给出参数）
    root.provide("tools", {
      registerExternal: (_plugin: string, tool: { name: string; parameters: unknown }) => {
        registered.push(tool);
        return true;
      },
    } as never);
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await root.plugin(mod, { greeting: "测试" });
    // engine/ready 监听应生效（serial 发射后示例的 console.log 被调）
    await root.serial("engine/ready");
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining("[hello] engine ready"));

    // registerExternal 被调用一次：greet 工具 + JSON Schema 形态 parameters（含 required who）
    expect(registered).toHaveLength(1);
    expect(registered[0].name).toBe("greet");
    const params = registered[0].parameters as { type: string; required: string[] };
    expect(params.type).toBe("object");
    expect(params.required).toEqual(["who"]);
    consoleSpy.mockRestore();
  });
});
