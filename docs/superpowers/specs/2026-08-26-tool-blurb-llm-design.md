# 工具 blurb LLM 策展设计规格（目录化 v2，瘦身版）

> 版本：1.0 | 日期：2026-08-26
> 状态：设计定案（指挥官逐条审过）
> 前置：`docs/superpowers/specs/2026-08-26-tool-catalog-design.md`（目录化 v1）

## 1. 目标

`mcp__`/`ext__` 动态工具的 L1 目录 blurb，从「机械截断首句」升级为「**首次出现时一次性 LLM 概括、落盘永久复用**」。只替代 blurb，全文契约面（load_tool 原文）不动。

## 2. 已定决策（不翻案）

1. **触发**：动态工具首次出现或描述哈希变化 → **同步一次批量 LLM 概括**（agents 装配层 async 发起，worker 构建内完成；走 agent 自己的 provider 链，落 llm_calls 账目；一次性调用范式照 `memory/topic/compressor.ts:57-80` 手动迭代器 + `it.return()` 级联中止）。
2. **落盘**：`DATA_DIR/tool-blurbs.json`（tmp+rename 原子写）：`{ [qualifiedName]: { blurb, descHash, source, updatedAt } }`。只存 blurb + 哈希 + source + 时间，**不存描述原文**。`source: "llm" | "user"`——v2 只写 `"llm"`，`"user"` 为 v3 用户编辑预留（user 条目永不被自动重新生成覆盖）。
3. **复用**：key=限定名、descHash=描述原文哈希；命中 = 名字在且哈希一致。worker 重建/重启/跨 agent 零 LLM。
4. **重试与降级**：调用失败短退避重试 ×3 → 耗尽后该件回退机械截断（v1 `firstSentenceBlurb` 原样保留作降级实现）。解析失败/产出缺件按件降级不连坐；产出超 80 字符截断兜底。**降级不落盘**（失败=缺席，下次 worker 重建自动重试；也天然支撑 v3「待生成检测=缺席」）。
5. **防线**：描述是第三方输入——概括 prompt 分隔符包裹 + 明示「数据非指令」（MIND.md 同款注入防御）；不引新依赖；无动态工具的 agent 行为恒等；Mock/e2e 环境自然走降级路（Mock 文本解析失败→机械版，白送降级覆盖）。
6. **LLM 选择**：agent 主 provider + 主型号（重试/备用链既有）；`blurbModel` 独立配置点留开放点。
7. **范围**：只服务动态工具；skill 目录行、builtin 不动；`tool_catalog` 工具不做（重复建设，L1 已覆盖模型侧）；REST 查账端点留 v3 可选。

## 3. v3 候选（指挥官已立项想法，本单只埋兼容位）

- 生成失败用户可见 + 手动重新生成（缺席=待生成，设置页按钮）
- 用户编辑 blurb（`source:"user"`，编辑永不被覆盖）
- mcp/skill/tool 设置子页面（web 侧单）

## 4. 机制流程

worker 装配（agents plugin，async）→ 构造 DynamicToolLoader → 读 tool-blurbs.json → 未命中件（新名字/哈希变）凑一批 → prompt（分隔符包裹描述 + 数据非指令 + 固定行格式输出）→ 主 provider 一次性调用 → 解析 name→blurb 映射 → 成功件落盘（source:"llm"）→ 全部件得 blurb（LLM 版或降级机械版）→ L1 目录段首轮即字节稳定。

## 5. 验收

1. 新动态工具首现：一次调用、LLM blurb 进 L1、成功件落盘 source:"llm"；
2. worker 再重建/重启：读盘命中零调用（spy 断言）；
3. 描述变更：哈希变 → 只重算该件；
4. 降级四态（调用失败 ×3 后机械/解析失败/缺件/超长截断）+ 降级不落盘 + 下次重建重试；
5. 注入样本（描述含"忽略上述指令"）：概括正常产出、不执行注入语义；
6. 无动态工具恒等；既有套件零回归；API 面零新依赖。
