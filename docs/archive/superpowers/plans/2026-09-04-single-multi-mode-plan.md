# 单/多模式切换（web 呈现层）实施计划

- 日期：2026-09-04
- 范围：`apps/web` 纯呈现层；engine 零改动
- 性质：小特性单，plan 即 spec

## 决策（指挥官已过目）

1. 主页顶栏「单 / 多」切换按钮；状态存 `localStorage["cloudmind.agentMode"]`（缺省 `multi` = 现状恒等），选中 agent 存 `cloudmind.singleAgentId`（不写 engine，同用户档案纯前端先例）。
2. 单模式：顶栏 agent 选择器（既有 agents 列表，头像+名字）；主页直达该 agent 私聊；藏群聊入口、广播站、会话列表中的群聊会话；**保留 agents 管理页**（模式切使用面不切管理面）。
3. 边界：仅一个 agent 不自动切（手动优先）；单模式下选中 agent 被删除 → 自动回退多模式 + 页面内提示。

## 任务（1 个实现子代理）

1. `stores/ui-mode.ts`（新）：agentMode/singleAgentId 状态 + localStorage 持久化（缺省 multi；singleAgentId 失效 agent 时回退 multi + notice）。
2. 顶栏切换按钮（`layouts/default.vue` 或 hub 顶栏——先看现有顶栏结构择一并申报）：单/多切换 + 单模式下的 agent 选择器下拉。
3. hub 页收敛：单模式时直达 singleAgentId 私聊（无则落选择器聚焦态）；导航/会话列表过滤群聊项与广播站入口。
4. 测试 ≥5 例：缺省恒等 multi / 切换持久化 / 单模式导航收敛与私聊直达 / 选择器切换 / 删除回退 multi + 提示。

**验收：** web 全量绿；typecheck/lint 绿；既有套件零回归（fresh=多模式逐字节现状）。

## 评审与销记

独立 review（恒等/持久化/回退正确性）→ 主控终审 → 全量 verify/e2e → 路线图「前端」节补一行 + 销记提交。push 随本单。

## 口径认领（主控终审，2026-09-04）

- **侧栏整体收敛为选择器**：plan 任务 3「会话列表中的群聊会话」的最严解读（单模式仅过滤群聊项、保留私聊列表）为歧义表述；实现采用「单模式侧栏整体收敛为 agent 选择器直达私聊」（tabs/双列表/创建入口全收敛）。实现语义更优（单模式本义就是"只跟一个人形打交道"，留私聊列表等于留多模式使用面），口径由主控认领，plan 原文不改留痕。
- **回退就绪门槛**：review High 修复——加载完成前的空列表 ≠ 已删除（agents.loadedOnce 仅成功落定置位），入选实现口径。
- **ClientOnly 扩域**：v-if/v-else 同域约束下，ClientOnly 包到侧栏双列表尾 + 主区单模式欢迎屏（组件自身挂 v-if 保持邻接合法）。
