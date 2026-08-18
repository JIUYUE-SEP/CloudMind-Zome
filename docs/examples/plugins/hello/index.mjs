// CloudMind-Zome 示例外部插件（器官）——hello
//
// 外部插件 = 纯 JS ESM 模块，与内部插件同构四件套：name / inject / Config / apply。
// 居住地：DATA_DIR/plugins/hello/index.mjs，并在器官清单登记：
//   - 全局：DATA_DIR/plugins.json  { "plugins": { "hello": { "enabled": true, "config": { "greeting": "你好" } } } }
//   - per-agent：DATA_DIR/agents/<id>/plugins.yml  plugins: { hello: { enabled: true, config: {...} } }
//     （per-agent 挂载时 config 会额外注入 agentId 字段）
//
// 信任模型：用户自装代码、进程内全权限（类 Obsidian 社区插件）。改动需重启 engine 生效（无热重载）。

/** 插件名：必须与目录名一致（不符则不挂载） */
export const name = "hello";

/** inject：激活前必须就位的内部服务。声明了不存在的服务会停在 PENDING 永不激活（启动日志会 warn 列出）。
 *  注意：访问 ctx.<service> 前必须把它写进 inject——cordis 代理对未声明的服务在属性访问时即抛错 */
export const inject = ["tools"];

/**
 * apply：激活入口。只做可逆注册（ctx.on / ctx.effect 等），fiber 卸载时 cordis 自动回收。
 * @param {object} ctx - cordis Context（可读取全部内部服务面与事件）
 * @param {object} config - 清单里的 config（per-agent 挂载时含 agentId）
 */
export function apply(ctx, config) {
  const greeting = config?.greeting ?? "hello";

  // 1) 监听生命周期事件：engine/ready 在启动对账完成前、listen 前发射一次（serial 模式——
  //    监听会被逐个 await，耗时计入启动路径，保持轻量；返回值非 null 会截断后续监听，勿返回）
  ctx.on("engine/ready", () => {
    console.log(`[hello] engine ready, agent=${config?.agentId ?? "(global)"}`);
  });

  // 2) 感知注入中间件（waterfall 模式）：可改写/追加注入文本；不调 next() 即否决后续链
  //    （含内建放行）——白名单纪律：外部插件只许改写/追加，不许吞。
  ctx.on("perception/inject", async (payload, next) => {
    void payload;
    return next();
  });

  // 3) 注册外部工具（E3）：限定名 ext__hello__greet；requiresApproval 缺省从严（=true，
  //    每次调用需人工审批）；显式 false 声明只读免审批。agent 的 tools 白名单写上
  //    ext__hello__greet 全名才启用。
  //    parameters 接受 JSON Schema（外部插件拿不到 zod，引擎收编时自动转换；
  //    边界形态如 oneOf/$ref 降级为不校验，由 execute 自守）。
  ctx.tools?.registerExternal("hello", {
    name: "greet",
    description: "示例工具：按插件配置向指定对象打招呼",
    parameters: {
      type: "object",
      properties: { who: { type: "string", description: "打招呼的对象" } },
      required: ["who"],
    },
    accesses: [], // 资源访问声明（调度器并发分组用；本示例不访问文件/网络/进程）
    requiresApproval: false, // 只读示例，显式声明免审批
    async execute(ctx, args) {
      return { success: true, output: `${greeting}, ${args.who}!（来自 hello 插件）` };
    },
  });
}
