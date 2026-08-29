import { defineStore } from "pinia";
import { ref } from "vue";
import { useEngineClient, type ToolCatalog } from "@/composables/useEngineClient";

/**
 * blurb 管理面（v3，/settings/tools 子页面）：tool-catalog 拉取 + 编辑/重生成写操作。
 * 错误与结果提示全部页面内（writeError/notice），不走全局通知（spec 决策 4）。
 */
export const useToolCatalogStore = defineStore("toolCatalog", () => {
  const client = useEngineClient();

  const agentId = ref("");
  const catalog = ref<ToolCatalog | null>(null);
  const loading = ref(false);
  const error = ref("");
  /** 写操作错误（编辑/重生成共用）：engine 的 400/404 error 正文 */
  const writeError = ref("");
  /** 结果提示（编辑保存 / 重生成三段摘要），页面内展示 */
  const notice = ref("");

  async function load(id?: string): Promise<void> {
    if (id !== undefined) agentId.value = id;
    if (!agentId.value) return;
    loading.value = true;
    error.value = "";
    try {
      catalog.value = await client.getToolCatalog(agentId.value);
    } catch (err) {
      error.value = err instanceof Error ? err.message : String(err);
    } finally {
      loading.value = false;
    }
  }

  /**
   * 编辑保存（PUT 后刷新——徽标转 user 由重新拉取保证，不在前端手改）。
   * 提示统一带「下次会话生效」（dynamic/skill 生效时机相同，见 save 内注）；
   * 本页面不做 retire 机制。
   */
  async function save(name: string, blurb: string): Promise<boolean> {
    writeError.value = "";
    notice.value = "";
    try {
      await client.putToolBlurb(name, blurb);
      await load();
      // 提示统一（reviewer 举证：dynamic 件的 loader blurbFor 只读内存映射，
      // 与 skill 的 L1 目录行同样要 worker 退役重建才更新——不按 skill: 分流误导）
      notice.value = "已保存——L1 目录行下次会话生效";
      return true;
    } catch (err) {
      writeError.value = err instanceof Error ? err.message : String(err);
      return false;
    }
  }

  /** 重生成：names 缺省 = 全部 missing/stale（空 body）；返回三段摘要进 notice */
  async function regenerate(names?: string[]): Promise<boolean> {
    writeError.value = "";
    notice.value = "";
    try {
      const result = await client.regenerateToolBlurbs(agentId.value, names);
      await load();
      const parts = [`已生成 ${result.generated.length} 件`];
      if (result.skipped.length > 0) parts.push(`跳过用户编辑 ${result.skipped.length} 件`);
      if (result.failed.length > 0) parts.push(`失败 ${result.failed.length} 件：${result.failed.join("、")}`);
      notice.value = parts.join("；");
      return result.failed.length === 0;
    } catch (err) {
      writeError.value = err instanceof Error ? err.message : String(err);
      return false;
    }
  }

  return { agentId, catalog, loading, error, writeError, notice, load, save, regenerate };
});
