# CloudMind-Zome 前端 UI 全面审查报告

> **项目**：CloudMind-Zome  
> **日期**：2026-06-09  
> **范围**：前端 Vue 组件、交互体验、样式一致性、API 对接  
> **状态**：只审查，不改代码，等待指挥官确认

---

## 目录

1. [SystemSettingsPanel（系统设置）](#1-systemsettingspanel系统设置)
2. [AgentEdit（Agent 编辑）](#2-agenteditagent-编辑)
3. [ChatView（对话界面）](#3-chatview对话界面)
4. [GroupChatView（群聊界面）](#4-groupchatview群聊界面)
5. [CommunicationHub（通讯中枢）](#5-communicationhub通讯中枢)
6. [ComputeCenter（算力中枢）](#6-computecenter算力中枢)
7. [其他页面速查](#7-其他页面速查)
8. [整体 UI 问题](#8-整体-ui-问题)
9. [需要改动的文件清单](#9-需要改动的文件清单)
10. [建议优先级](#10-建议优先级)

---

## 1. SystemSettingsPanel（系统设置）

**文件**：`frontend/src/components/SystemSettingsPanel.vue`（683 行）

### 1.1 Tab 结构（9 个 tab）

| Tab Key | 标签 | 功能 | 配置项 | 实际生效？ |
|---------|------|------|--------|-----------|
| `tools` | 工具 | 展示已注册工具列表 | 只读列表 | ✅ 只读 |
| `memory` | 记忆 | 上下文管理参数 | compact_threshold, keep_recent, hot_memory_limit, warm_memory_limit | ✅ 写入 config.yaml |
| `llm` | 对话模型 | Provider 配置 + Fallback 链 | fallback_chain, deepseek/mimo/kimicode/glm 各 {base_url, model, api_key} | 🔴 **不生效**（后端白名单拦截） |
| `image` | 图片生成 | ImageGen API 配置 | api_url, model, api_key | ⚠️ 写入 config.yaml，但后端优先读 Setting 表 |
| `assistant` | 辅助模型 | 辅助模型配置（记忆压缩等） | base_url, model, api_key | 🔴 **不生效**（后端白名单拦截） |
| `embedding` | Embedding | Embedding 模型配置 | base_url, model, api_key | 🔴 **不生效**（后端白名单拦截） |
| `skill` | 技能 | 占位 | 无 | ❌ 纯占位 |
| `mcp` | MCP | 占位 | 无 | ❌ 纯占位 |
| `acp` | ACP | 占位 | 无 | ❌ 纯占位 |

### 1.2 LLM Tab 详细分析

**当前 UI 结构**：

```
对话模型 Tab
├── Hint: "Fallback 链第一个即为默认 Provider"
├── Fallback 链（拖拽排序标签）
│   ├── deepseek → mimo → kimicode → glm（可拖拽）
│   └── 添加下拉框（硬编码 4 个选项）
├── Provider 配置卡片 × 4
│   ├── deepseek: [Base URL] [模型名称] [API Key]
│   ├── mimo: [Base URL] [模型名称] [API Key]
│   ├── kimicode: [Base URL] [模型名称] [API Key]
│   └── glm: [Base URL] [模型名称] [API Key]
└── Tavily API Key
```

**保存逻辑**：

```typescript
// save() 发送的 payload
payload.provider = {
  default: form.provider.fallback_chain[0] || '',
  fallback_chain: [...],
  deepseek: { base_url, model, api_key },
  mimo: { ... },
  kimicode: { ... },
  glm: { ... },
}
// → PUT /api/v1/config
```

**问题**：后端 `_MUTABLE_SECTIONS` 不包含 `"provider"`，**配置被静默丢弃**。

### 1.3 各 Tab 配置项的说明文字

| Tab | 是否有说明 | 质量评估 |
|-----|-----------|----------|
| tools | ✅ "V1.2 支持开关控制" | 太简略，无实际开关 |
| memory | ❌ 无 | 4 个数字输入框完全没有解释 |
| llm | ✅ "Fallback 链第一个即为默认 Provider" | 基本够用，但 Provider 卡片无说明 |
| image | ✅ "Agent 可使用 generate_image 工具生图" | 够用 |
| assistant | ✅ "负责后台 NLP 任务...与对话模型完全独立" | 很好 |
| embedding | ✅ "用于语义记忆搜索...与对话模型完全独立" | 很好 |
| skill | ❌ "即将在 V1.2 推出" | 纯占位 |
| mcp | ❌ "开发中，暂未开放" | 纯占位 |
| acp | ❌ "即将在 V1.2 推出" | 纯占位 |

### 1.4 重构建议（Provider 重做后）

LLM Tab 需要完全重做：
- **移除**硬编码 4 Provider 卡片
- **改为**调用 `/api/v1/compute/providers` 的动态 Provider 列表
- **新增**"管理 Provider"按钮跳转到 ComputeCenter
- **保留** Tavily API Key（或移到 ComputeCenter）
- **移除** Assistant / Embedding tab（功能已在 ComputeCenter 实现）
- **考虑**将 memory 配置也迁移到数据库（而非 config.yaml）

---

## 2. AgentEdit（Agent 编辑）

**文件**：`frontend/src/components/AgentEdit.vue`（**2605 行**——项目中最大的单文件组件）

### 2.1 Tab 结构（8 个 tab）

| Tab | 标签 | 功能 | 复杂度 |
|-----|------|------|--------|
| `profile` | 心智档案 | 名称、代号、代表色 | 低 |
| `persona` | 心智侧写 | USER.md 编辑器、人格分析、导入历史 | 中 |
| `skills` | 能力标签 | 能力标签、代称、分组标签 + 技能指令 | 中 |
| `security` | 文件权限 | allowed_paths 白名单 | 低 |
| `tools` | 工具集 | 按 toolset 分组的工具开关 | 中 |
| `compute` | 算力配置 | Provider/Model 选择、降级链、独立模型 | **高** |
| `appearance` | 外观立绘 | 立绘/VRM/Live2D 上传 | 中 |
| `mind` | 心智文件 | AGENT.md / SOUL.md / USER.md / MEMORY.md 编辑器 | 中 |

### 2.2 Compute Tab 详细分析

**UI 结构**：

```
算力配置 Tab
├── 推理模型
│   ├── [Provider 下拉框] — 来自 /agents/providers
│   ├── [Model 下拉框] — 来自当前 Provider.models
│   └── 能力图标: 👁️🧠⚡
├── 独立标注模型（checkbox）
│   └── [Provider] [Model] — 条件渲染
├── 独立嵌入模型（checkbox）
│   └── [Provider] [Model] — 条件渲染
├── 独立压缩模型（checkbox）
│   └── [Provider] [Model] — 条件渲染
└── 降级链（按优先级排序）
    ├── 1. [Provider] [Model] ↑↓×
    ├── 2. [Provider] [Model] ↑↓×
    └── + 添加降级模型
```

**数据流**：
- Provider 列表：`GET /api/v1/agents/providers` → `llmProviders`
- 保存：`PUT /api/v1/agents/{id}` → `body.llm_config`
- 降级链格式：`{ provider_id, provider, model }[]`

**问题**：
- 没有 `temperature` / `top_p` 输入（设计方案要求新增）
- 降级链的 `provider` 字段是 name 字符串，不是 ID，与后端新设计不匹配
- 独立模型（Marker/Embedder/Compressor）勾选后，如果父 Provider 被删除，子配置会指向无效的 `provider_id`

### 2.3 其他 Tab 速评

**Persona Tab**：
- 有 USER.md 内联编辑器（textarea），支持 Ctrl+S 保存
- "自动分析人格"按钮调 `POST /agents/{id}/analyze-personality`
- "导入对话历史"调 `POST /agents/{id}/import-history`
- 问题：人格分析结果显示在一个小 modal 里（400px 宽），5 个进度条很挤

**Skills Tab**：
- 左侧：能力标签 + 代称 + 分组标签（三个 tag 输入区）
- 右侧：技能指令列表（checkbox + 描述 + 删除）
- 问题：左右分栏在窄屏幕下会重叠（没有响应式断点）

**Tools Tab**：
- 按 toolset 分组（file/web/code/comms/group），可展开/折叠
- 全选/全部取消按钮
- 问题：工具名称只有英文（`read_file`, `search_web`），没有中文标签（虽然后端 `/tools/available` 返回了 label）

**Mind Tab**：
- 4 个文件切换按钮（SOUL / AGENT / USER / MEMORY）
- textarea 编辑器，支持 Ctrl+S
- 问题：与 SelfImageView.vue 的编辑器**功能完全重复**，但 UI 不同

### 2.4 体量问题

**2605 行**的 AgentEdit.vue 包含了：

| 模块 | 代码量估算 | 是否该拆 |
|------|-----------|----------|
| 模板（template） | ~900 行 | 太大了 |
| 左侧 Sidebar（Agent 列表） | ~80 行 | 可拆为 `AgentSidebar.vue` |
| 中间展示区（3D Viewer） | ~120 行 | 可拆为 `AgentStage.vue` |
| 右侧 8 个 Tab 面板 | ~700 行 | **必须拆** |
| Modal（Mind/Memory/Import/Persona） | ~400 行 | 可拆为独立组件 |
| 脚本逻辑（script） | ~900 行 | 太杂 |
| 样式（style） | ~800 行 | 与模板耦合 |

**拆分建议**：

```
AgentEdit.vue（壳子：Sidebar + Stage + Tab 切换）
├── AgentSidebar.vue（左侧列表）
├── AgentStage.vue（中间 3D 展示）
├── tabs/
│   ├── ProfileTab.vue
│   ├── PersonaTab.vue
│   ├── SkillsTab.vue
│   ├── SecurityTab.vue
│   ├── ToolsTab.vue
│   ├── ComputeTab.vue ← Provider 重做重点改这个
│   ├── AppearanceTab.vue
│   └── MindTab.vue
└── modals/
    ├── MindFileModal.vue
    ├── MemoryModal.vue
    ├── ImportHistoryModal.vue
    └── PersonalityModal.vue
```

**目标**：AgentEdit.vue 从 2605 行 → ~300 行（壳子），每个子组件 100-400 行。

---

## 3. ChatView（对话界面）

**文件**：`frontend/src/components/ChatView.vue`（625 行）

### 3.1 流式响应渲染

**Thinking（推理内容）**：

```vue
<div v-if="msg.reasoning" class="reasoning-bar" @click="toggleExpand(msg.id)">
  <span>{{ expanded[msg.id] ? '▼' : '▶' }} 已思考 {{ msg.reasoning.length }} 字</span>
</div>
<div v-if="expanded[msg.id] && msg.reasoning" class="reasoning-body">{{ msg.reasoning }}</div>
```

- ✅ 默认折叠（只显示字数）
- ✅ 点击展开/收起
- ✅ 等宽字体、深色背景、带边框
- ⚠️ S1 bug（reasoning 被覆盖）已在 `syncMessages()` 中修复：`if (msg.reasoning !== undefined) existing.reasoning = msg.reasoning`

**Tool Calls**：

```vue
<div v-if="msg.tool_calls?.length" class="tool-bar" @click="toggleExpand(`${msg.id}_tools`)">
  <span v-for="t in msg.tool_calls" class="tool-tag">▶ {{ t.name }}</span>
</div>
<div v-if="expanded[`${msg.id}_tools`]" class="tool-detail">
  <pre class="tool-input">{{ JSON.stringify(t.input, null, 2) }}</pre>
</div>
```

- ✅ 默认折叠（只显示工具名标签）
- ✅ 展开后显示 JSON 参数（带格式化）
- ⚠️ 不显示 tool result（只显示 call），用户看不到执行结果

### 3.2 Markdown 渲染

**库**：`marked` + `dompurify`

```typescript
import { marked } from 'marked'
import DOMPurify from 'dompurify'

marked.setOptions({ breaks: true, gfm: true })

function sanitizeMd(text: string): string {
  const html = marked.parse(text, { async: false }) as string
  return DOMPurify.sanitize(html)
}
```

**样式覆盖**：ChatView.vue 的 style 块里有大量 `:deep()` 覆盖：
- `p`, `ul/ol`, `li`, `pre`, `code`, `blockquote`, `a`, `table`, `hr`, `h1-h4`
- 用户消息（`.me`）和用户消息有独立的浅色主题覆盖

**问题**：
- ❌ **没有代码语法高亮**（没有 highlight.js / Prism / shiki）
- ❌ 代码块只有基础样式（深色背景 + 等宽字体），关键字没有着色
- ✅ 表格、引用、链接都有样式
- ✅ 行内代码有背景色

### 3.3 长消息机制

- ❌ **没有截断/折叠机制**：长消息会无限撑高气泡
- ✅ 消息区域 `max-width: 70%`，但高度无限制
- ✅ 代码块 `overflow-x: auto` 支持横向滚动
- ⚠️ 超长的 reasoning 内容展开后可能占满整个屏幕

### 3.4 消息交互

| 功能 | 状态 |
|------|------|
| 发送消息 | ✅ Enter 发送 |
| 引用回复 | ✅ 可引用某条消息 |
| 图片发送 | ✅ 支持图片上传 + 预览 |
| 混合消息（文字+图片） | ✅ `[image:url]\n文字` 格式 |
| 文件分享 | ✅ `[file:url]` 解析为下载链接 |
| 消息搜索 | ✅ 顶部搜索栏 |
| 图片点击放大 | ✅ overlay 预览 |
| 自动滚动 | ✅ 新消息自动滚底，用户上滑后暂停 |
| 新消息提示 | ✅ "↓ 新消息" toast |

---

## 4. GroupChatView（群聊界面）

**文件**：`frontend/src/components/GroupChatView.vue`（797 行）

### 4.1 与 ChatView 的关系

GroupChatView 和 ChatView **是独立的两个组件**，但 UI 结构几乎完全相同：

| 方面 | ChatView | GroupChatView |
|------|----------|---------------|
| 消息列表 | ✅ | ✅（完全复制） |
| 输入框 | ✅ | ✅（完全复制） |
| Markdown 渲染 | ✅ | ✅（完全复制） |
| Thinking 展示 | ✅ | ✅（完全复制） |
| Tool Calls 展示 | ✅ | ✅（完全复制） |
| 图片预览 | ✅ | ✅（完全复制） |
| 自动滚动 | ✅ | ✅（完全复制） |
| 样式 | ~380 行 | ~350 行（大量重复） |

**重复代码量估算**：两个文件约有 **300+ 行模板和 200+ 行样式完全重复**。

### 4.2 群聊特有功能

| 功能 | 实现 | 评价 |
|------|------|------|
| 成员列表面板 | ✅ 右侧 280px 面板 | 可折叠，显示头像/状态/队长标识 |
| @提及 | ✅ 输入 @ 弹出成员选择框 | 支持 `@所有人` |
| 队长标识 | ✅ `crown` badge | 金色"队长"标签 |
| 心智互聊 | ✅ `intermind-divider` + 打断按钮 | 橙色打断按钮 |
| 群设置 | ✅ 路由模式、心智互聊开关、随机回复数 | 简单但够用 |
| 邀请 Agent | ✅ 下拉列表选择 | 过滤掉已在群中的 Agent |
| 解散群聊 | ✅ 确认弹窗 | 够用 |

### 4.3 @提及实现

```typescript
function onInput() {
  const cursor = el.selectionStart
  const before = text.slice(0, cursor)
  const lastAt = before.lastIndexOf('@')
  if (lastAt >= 0) {
    const between = before.slice(lastAt + 1)
    if (!between.includes(' ') && !between.includes('\n')) {
      showMention.value = true  // 弹出选择框
    }
  }
}
```

- ✅ 实现简洁有效
- ⚠️ 不支持多次 @（第二次 @ 不会触发弹窗，如果第一个 @ 还没选完）
- ⚠️ 没有键盘上下选择（只能用鼠标点）

---

## 5. CommunicationHub（通讯中枢）

**文件**：`frontend/src/components/CommunicationHub.vue`（989 行）

### 5.1 布局

三栏布局：

```
┌─────────┬──────────────────────┬──────────┐
│ Sidebar │      Main Chat       │  Right   │
│  260px  │       (flex:1)       │  300px   │
│         │                      │          │
│ Agent   │  ChatView /          │ Agent    │
│ List    │  GroupChatView       │ Figure   │
│ (分组)  │  (inline mode)       │ / Group  │
│         │                      │ Info     │
└─────────┴──────────────────────┴──────────┘
```

### 5.2 左侧 Sidebar

- **私聊 Tab**：Agent 按第一个 tag 分组显示（如 "工作", "编程", "未分组"）
- **群聊 Tab**：群聊列表 + "创建群聊"按钮
- 每个会话项：头像、名称、预览文字、未读 badge、置顶星标、设置按钮
- 问题：私聊列表里的 "预览文字" 显示的是 `a.codename || '点击开始对话'`，**不是最后一条消息内容**

### 5.3 右侧信息面板

**私聊时**：
- Agent 形象展示（Portrait / Live2D / VRM 切换）
- Agent 名称、代号、状态
- 记忆状态统计（总消息 / 已压缩 / 压缩率）

**群聊时**：
- 群名称
- 成员列表（头像 + 名称 + 队长标识）

**问题**：
- 记忆统计只在选中 Agent 时加载一次，不会自动刷新
- 话题摘要已被移除（代码注释 `<!-- Topic record removed -->`）

---

## 6. ComputeCenter（算力中枢）

**文件**：`frontend/src/components/ComputeCenter.vue`（468 行）

### 6.1 功能

这是**真正管理 Provider 的页面**：

```
算力中枢
├── 统计卡片（今日消耗 / 可用额度 / 预估剩余）
├── Provider 卡片网格
│   └── 每个卡片：状态点、名称、类型、URL、模型标签
├── 使用趋势图（Canvas 绘制折线图）
└── 全局设置
    ├── 嵌入模型（Provider + Model 选择）
    └── 图像生成模型（Provider + Model 选择）
```

### 6.2 Provider 管理

**添加 Provider**：
- 表单：平台名称、API Key（password 类型）、Base URL
- 验证：必填校验
- 调 `POST /api/v1/compute/providers`

**编辑 Provider**：
- 表单：名称、Base URL、API Key（留空不修改）
- 模型列表：可添加/删除模型（手动输入名称）
- 操作：保存、测试连接、断开
- 调 `PUT /api/v1/compute/providers/{id}`

**问题**：
- ❌ **没有模型自动发现**：模型列表需要手动输入，不像后端 `/providers/{id}/test` 可以拉取模型列表
- ⚠️ 添加 Provider 后不会自动测试，用户需要手动点"测试连接"
- ⚠️ 没有 Provider 排序/拖拽功能

### 6.3 与 SystemSettingsPanel 的关系

| 功能 | SystemSettingsPanel | ComputeCenter |
|------|---------------------|---------------|
| Provider CRUD | ❌ 假保存 | ✅ 真保存 |
| Provider 列表展示 | ❌ 无 | ✅ 卡片网格 |
| Embedding 设置 | ❌ 假保存 | ✅ 真保存到 Setting 表 |
| ImageGen 设置 | ⚠️ 写到 config.yaml | ✅ 真保存到 Setting 表 |
| Fallback 链配置 | ✅ 写到 config.yaml | ❌ 无（在 AgentEdit 中配置） |

**结论**：用户应该在 ComputeCenter 管理 Provider，在 AgentEdit 配置 Agent 使用哪个 Provider。SystemSettingsPanel 的 LLM/Assistant/Embedding tab **应该被移除或重定向到 ComputeCenter**。

---

## 7. 其他页面速查

### 7.1 SelfImageView（心智侧写）

**文件**：`frontend/src/views/SelfImageView.vue`（~250 行）

- 左侧：Agent 列表（与 AgentEdit 的 sidebar 完全一样的样式）
- 右侧：4 个心智文件（USER/SOUL/AGENT/MEMORY）的 Tab 编辑器
- 特点：每个 Tab 有 dirty 标记（●）、保存状态指示、Ctrl+S 快捷键
- **问题**：与 AgentEdit.vue 的 Mind Tab **功能完全重复**，但 UI 更好（有 dirty 状态、字符计数）

### 7.2 HomeView（首页）

**文件**：`frontend/src/views/HomeView.vue`（~350 行）

- 大背景（壁纸支持上传/URL/渐变）
- 问候语 + 时间（随时间变化：早安/下午好/晚上好）
- 三个浮动按钮：设置、日志、壁纸
- 壁纸设置面板：拖拽定位、9 种锚点、4 种显示模式
- 系统日志面板：实时 WS 日志、类型着色（info/warn/error/success）
- **特点**：面板都支持拖拽移动（通过 mousedown 事件实现）

### 7.3 AppShell（应用外壳）

**文件**：`frontend/src/views/AppShell.vue`（~120 行）

- 右侧垂直导航（180px 宽）：行动中心、心智整备、自动委托、心智招募、通讯中枢、广播站
- 底部状态栏：头像、心智侧写、用户档案、算力余量
- **问题**：
  - "心智整备"和"心智招募"都指向 `/agents/new`（同一个页面）
  - "广播站"是 placeholder（点击无反应）
  - 导航栏固定宽度 180px，在小屏幕下会遮挡内容

---

## 8. 整体 UI 问题

### 8.1 响应式布局

**结论：没有响应式设计。**

| 页面 | 布局方式 | 移动端表现 |
|------|----------|-----------|
| HomeView | 绝对定位元素 | 按钮可能重叠 |
| AppShell | 固定右侧导航 180px | 导航栏会遮挡内容 |
| AgentEdit | 三栏固定（220px + flex + 25vw） | 完全不可用 |
| ChatView | 全屏固定 | 可能可用但体验差 |
| GroupChatView | 全屏固定 + 右侧 280px 面板 | 面板无法折叠，会挤占聊天区 |
| CommunicationHub | 三栏（260px + flex + 300px） | 完全不可用 |
| ComputeCenter | 全屏固定 | 卡片网格可能变形 |
| SystemSettingsPanel | 绝对定位 380px 宽 | 在小屏幕上会超出视口 |

**具体问题**：
- 所有主要页面都使用 `position: fixed; inset: 0`，没有 `@media` 查询
- AgentEdit 的右侧面板 `width: 25vw; min-width: 320px; max-width: 480px`，在 13 寸笔记本上只有 ~320px，很挤
- GroupChatView 的 member-panel 固定 280px，在 1280px 宽屏幕上聊天区只剩 ~50%

### 8.2 样式一致性

**好的方面**：
- ✅ 统一的颜色体系：`#0B0F17` 背景、`#00E5C9` 主色、`#D8E1EC` 文字、`#1E2731` 边框
- ✅ 统一的圆角：12px（大）、8px（中）、6px（小）、4px（标签）
- ✅ 统一的字体：system-ui, -apple-system, sans-serif
- ✅ 所有按钮/输入框的 hover/focus 状态一致（主色变亮、边框变主色）

**不一致的地方**：

| 组件 | 位置 | 不一致点 |
|------|------|----------|
| modal | AgentEdit vs ComputeCenter | AgentEdit 的 modal 是 `.modal-overlay` + `.modal-card`；ComputeCenter 的 modal 是同名的但样式略有不同（边框颜色、padding） |
| 标签/tag | AgentEdit skills vs SystemSettingsPanel fallback | 同样的 tag 样式在不同文件里重复定义了多次 |
| 侧边栏 | AgentEdit vs SelfImageView vs CommunicationHub | 三个侧边栏样式几乎一样，但各自独立定义（220px/260px 宽度不同） |
| textarea | AgentEdit mind vs SelfImageView | SelfImageView 的编辑器有 dirty 标记和字符计数，AgentEdit 没有 |

### 8.3 交互体验

**好的方面**：
- ✅ 全局 Ctrl+S 快捷键（AgentEdit mind tab、SelfImageView）
- ✅ 拖拽排序（Fallback 链）
- ✅ 面板拖拽移动（HomeView、SystemSettingsPanel）
- ✅ 未读 badge、置顶功能
- ✅ 输入框支持多行（textarea auto-resize 虽未实现但预留了）

**反人类操作**：

| 问题 | 位置 | 严重程度 |
|------|------|----------|
| SystemSettingsPanel LLM tab 保存不生效 | SystemSettingsPanel | 🔴 P0 |
| AgentEdit 2605 行，加载慢 | AgentEdit | 🟡 P1 |
| 代码块没有语法高亮 | ChatView | 🟡 P1 |
| ChatView 和 GroupChatView 重复代码 300+ 行 | 全局 | 🟡 P1 |
| 消息过长没有折叠 | ChatView | 🟢 P2 |
| 没有 loading 骨架屏 | 全局 | 🟢 P2 |
| @提及不支持键盘导航 | GroupChatView | 🟢 P2 |
| 错误提示用 `alert()` | ComputeCenter、AgentEdit | 🟢 P2 |
| 没有表单校验实时反馈 | 多个页面 | 🟢 P2 |

### 8.4 API 调用审查

**前端调用的 API 路径汇总**：

| 页面 | API 路径 | 状态 |
|------|----------|------|
| AgentEdit | `GET /agents` | ✅ |
| AgentEdit | `GET /agents/{id}` | ✅ |
| AgentEdit | `POST /agents` | ✅ |
| AgentEdit | `PUT /agents/{id}` | ✅ |
| AgentEdit | `DELETE /agents/{id}` | ✅ |
| AgentEdit | `GET /agents/{id}/mind/{file}` | ✅ |
| AgentEdit | `PUT /agents/{id}/mind/{file}` | ✅ |
| AgentEdit | `GET /agents/{id}/memory` | ✅ |
| AgentEdit | `POST /agents/{id}/analyze-personality` | ✅ |
| AgentEdit | `POST /agents/{id}/import-history` | ✅ |
| AgentEdit | `GET /agents/{id}/skills/discovered` | ✅ |
| AgentEdit | `POST /agents/{id}/skills/upload` | ✅ |
| AgentEdit | `DELETE /agents/{id}/skills/{name}` | ✅ |
| AgentEdit | `GET /agents/providers` | ✅ |
| AgentEdit | `POST /agents/{id}/portrait` | ✅ |
| AgentEdit | `POST /agents/{id}/model` | ✅ |
| AgentEdit | `POST /agents/{id}/live2d` | ✅ |
| SystemSettingsPanel | `GET /config` | ✅ |
| SystemSettingsPanel | `PUT /config` | ✅（但部分配置被后端丢弃） |
| SystemSettingsPanel | `GET /config/tools` | ✅ |
| ComputeCenter | `GET /compute/providers` | ✅ |
| ComputeCenter | `POST /compute/providers` | ✅ |
| ComputeCenter | `PUT /compute/providers/{id}` | ✅ |
| ComputeCenter | `DELETE /compute/providers/{id}` | ✅ |
| ComputeCenter | `POST /compute/providers/{id}/test` | ✅ |
| ComputeCenter | `GET /compute/usage` | ✅ |
| ComputeCenter | `GET /compute/embedding-model` | ✅ |
| ComputeCenter | `PUT /compute/embedding-model` | ✅ |
| ComputeCenter | `GET /compute/image-gen` | ✅ |
| ComputeCenter | `PUT /compute/image-gen` | ✅ |
| CommunicationHub | `GET /chats/sessions` | ✅ |
| CommunicationHub | `POST /chats/sessions/private` | ✅ |
| CommunicationHub | `GET /chats/groups/{id}` | ✅ |
| CommunicationHub | `POST /chats/groups` | ✅ |
| CommunicationHub | `PUT /chats/groups/{id}` | ✅ |
| CommunicationHub | `DELETE /chats/groups/{id}` | ✅ |
| CommunicationHub | `PUT /chats/groups/{id}/conductor` | ✅ |
| CommunicationHub | `DELETE /chats/groups/{id}/members/{id}` | ✅ |
| CommunicationHub | `POST /chats/groups/{id}/members` | ✅ |
| CommunicationHub | `POST /chats/groups/{id}/avatar` | ✅ |
| CommunicationHub | `PUT /chats/sessions/{id}/pin` | ✅ |
| ChatView | `GET /chats/sessions/{id}/messages` | ✅ |
| ChatView | `GET /chats/sessions/{id}/messages?search=` | ✅ |
| ChatView | WS `chat.send` | ✅ |
| HomeView | `POST /upload?folder=wallpapers` | ✅ |
| SelfImageView | `GET /agents/{id}/mind/{file}` | ✅ |
| SelfImageView | `PUT /agents/{id}/mind/{file}` | ✅ |

**结论**：所有 API 路径都与后端路由对上，没有调不存在的 API。

---

## 9. 需要改动的文件清单

### 9.1 必须跟着 Provider 重做一起改

| 文件 | 改动内容 | 优先级 |
|------|----------|--------|
| `frontend/src/components/SystemSettingsPanel.vue` | LLM tab 改为动态 Provider 管理（或移除重定向到 ComputeCenter）；移除 Assistant/Embedding tab | 🔴 P0 |
| `frontend/src/components/AgentEdit.vue` | Compute tab：① 新增 temperature/top_p ② Fallback 链改为 provider_id/model_id ③ 接入动态 Provider 列表 | 🔴 P0 |
| `frontend/src/stores/compute.ts` | 扩展 Model 列表缓存、Provider 详情 | 🟡 P1 |

### 9.2 强烈建议顺手优化（拆分/重构）

| 文件 | 改动内容 | 优先级 |
|------|----------|--------|
| `frontend/src/components/AgentEdit.vue` | **拆分**为 9+ 个子组件（见 2.4 节拆分建议） | 🟡 P1 |
| `frontend/src/components/ChatView.vue` + `GroupChatView.vue` | **抽取公共组件**：MessageBubble、MessageInput、ReasoningBlock、ToolCallBlock | 🟡 P1 |
| `frontend/src/components/ChatView.vue` | 引入 highlight.js / shiki 做代码语法高亮 | 🟡 P1 |

### 9.3 可以后做的改进

| 文件 | 改动内容 | 优先级 |
|------|----------|--------|
| `frontend/src/components/AgentEdit.vue` + `SelfImageView.vue` | 统一 Markdown 编辑器组件（带 dirty 状态、字符计数） | 🟢 P2 |
| `frontend/src/components/ChatView.vue` | 长消息折叠/"展开更多"按钮 | 🟢 P2 |
| `frontend/src/components/GroupChatView.vue` | @提及支持键盘上下选择 | 🟢 P2 |
| `frontend/src/components/ComputeCenter.vue` | 添加 Provider 后自动测试连接并拉取模型列表 | 🟢 P2 |
| 全局 | 引入 loading 骨架屏组件 | 🟢 P2 |
| 全局 | 统一错误提示（toast 替代 alert） | 🟢 P2 |
| 全局 | 响应式适配（至少支持 1280px 以下屏幕） | ⚪ P3 |

---

## 10. 建议优先级

### 第一阶段：Provider 重做同步（必须）

1. **SystemSettingsPanel.vue LLM tab 重做**
   - 移除硬编码 4 Provider
   - 改为动态 Provider 列表（调用 `/compute/providers`）
   - 或直接将 LLM tab 移除，在底部加"前往算力中枢管理 Provider"链接

2. **AgentEdit.vue Compute tab 改造**
   - 新增 `temperature`、`top_p` 输入（滑块或数字输入）
   - Fallback 链数据结构改为 `{provider_id, model_id}`
   - Provider/Model 选择器改为级联（与 ComputeCenter 一致）

3. **stores/compute.ts 扩展**
   - 缓存 Provider 列表和 Model 列表
   - 提供按 ID 查找 Provider/Model 的 getter

### 第二阶段：代码质量优化（强烈建议）

4. **AgentEdit.vue 拆分**
   - 拆为 9 个子组件
   - 目标：主文件 < 300 行

5. **ChatView + GroupChatView 合并/抽取**
   - 抽取公共 MessageBubble 组件
   - 减少 300+ 行重复代码

6. **代码语法高亮**
   - 引入 `highlight.js` 或 `shiki`
   - 在 marked 渲染后注入高亮

### 第三阶段：体验打磨（可以后做）

7. 统一 Markdown 编辑器（AgentEdit + SelfImageView）
8. 长消息折叠
9. @提及键盘导航
10. 响应式适配
11. 骨架屏 + Toast 错误提示

---

## 附录：前端组件规模统计

| 文件 | 行数 | 类型 |
|------|------|------|
| `AgentEdit.vue` | 2605 | 单文件组件（**过大**） |
| `CommunicationHub.vue` | 989 | 单文件组件（偏大） |
| `GroupChatView.vue` | 797 | 单文件组件 |
| `SystemSettingsPanel.vue` | 683 | 单文件组件 |
| `ChatView.vue` | 625 | 单文件组件 |
| `ComputeCenter.vue` | 468 | 单文件组件 |
| `ActionEdit.vue` | 354 | 单文件组件 |
| `HomeView.vue` | ~350 | 页面 |
| `BlueprintCanvas.vue` | 449 | 单文件组件 |
| `CommissionCenter.vue` | 176 | 单文件组件 |
| `ActionCenter.vue` | 185 | 单文件组件 |
| `ApprovalLog.vue` | 89 | 单文件组件 |
| `UserProfileModal.vue` | 283 | 单文件组件 |
| `BackButton.vue` | 53 | 原子组件 |
| **总计** | **~7955 行** | 15 个 .vue 文件 |

---

*报告完成。等待指挥官确认后进入实施阶段。*
