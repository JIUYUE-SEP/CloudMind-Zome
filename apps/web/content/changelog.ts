/**
 * 更新日志数据源（广播站页面）。
 * 手工维护的结构化条目，最新在前；页面按数组序原样渲染。
 */
export interface ChangelogEntry {
  /** 版本号或阶段名（未发布档用「未发布」） */
  version: string;
  /** 发布日期（ISO 短格式）；未发布档用「进行中」 */
  date: string;
  /** 本档主题一句话 */
  title: string;
  /** 逐条变更摘要 */
  items: string[];
}

export const changelogEntries: ChangelogEntry[] = [
  {
    version: "未发布",
    date: "进行中",
    title: "前端完善轮 + 产品形态收敛",
    items: [
      "前端完善轮 F2：导航收口（行动中心/自动委托/广播站落地），新增更新日志页；引擎客户端管线扩展——消息 before 翻页游标、插件与系统信息端点、会话更新/删除接口恢复",
      "引擎新增 GET /plugins 与 GET /system/info 只读端点；群聊消息支持 before 游标分页，并可跨归档层翻页",
      "移除桌面端（Tauri 壳），产品形态收敛为纯 WebUI 本地运行",
      "全项目终审修复群（G1–G3）：参数校验、审批审计落盘、归档保序、用量归因等",
    ],
  },
  {
    version: "2.0.0",
    date: "2026-08-17",
    title: "JS 重写基线：插件化迁移收官 + 全量审计修复",
    items: [
      "Cordis 插件化迁移收官：21 个内部插件 + 薄组合根；外部插件体系（全局 plugins.json 与 per-agent plugins.yml 清单）",
      "全项目并行审计与修复波次（A1–C2）：ReAct 回合、内置工具与 MCP、REST/WS 语义、记忆读写、蓝图与调度、换班移交等",
      "换班移交续跑（水位撞顶自动换班不死）、协议族迁移（apiMode 三族）、引擎 token 零配置与生命周期管理、WS 断线自动重连",
    ],
  },
];
