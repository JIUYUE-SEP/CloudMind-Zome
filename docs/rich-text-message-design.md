# CloudMind-Zome 图文混排富文本消息设计方案

> 状态：设计稿（未实施）  
> 目标：将当前 "图片堆在开头/结尾" 的分离式消息，升级为支持图文穿插的所见即所得富文本编辑器。

---

## 1. 前端富文本编辑器选型

### 1.1 候选方案对比

| 维度 | **TipTap** (推荐) | Quill | 自定义 contenteditable |
|------|-------------------|-------|------------------------|
| **Vue 3 生态** | 官方 `@tiptap/vue-3`，Composition API 友好 | Vue 集成偏弱，需封装层 | 完全自己控制 |
| **TypeScript** | 原生 TS，类型完整 | 社区类型定义滞后 | 自行定义 |
| **任意位置插入图片** | ✅ 支持 `Image` 扩展节点，粘贴/拖拽/按钮均可 | ✅ 支持 Blot，但定制复杂 | 需手写 Range/Selection 逻辑 |
| **移动端支持** | ✅ ProseMirror 移动端兼容性好，软键盘处理成熟 | ⚠️ 需额外处理键盘收起 | ❌ 边界极多（光标跳动、软键盘遮挡） |
| **包体积 (gzip)** | ~60 KB（core + image + placeholder） | ~45 KB | 0 KB，但代码量 > 几 KB |
| **所见即所得** | ✅ 完整 WYSIWYG，可扩展 Slash 命令、提及 | 成熟但扩展风格与 Vue 不一致 | 基础排版需大量 CSS 补丁 |
| **社区/维护** | 活跃，官方文档完善 | 维护放缓，v2 迟迟未发 | 无社区 |

### 1.2 选型结论：TipTap

**理由**：
1. **Vue 3 第一公民**：`@tiptap/vue-3` 直接提供 `EditorContent` 组件，与现有 Composition API 写法无缝衔接。
2. **Image 节点原生支持**：通过 `@tiptap/extension-image` 即可在任意段落位置插入图片节点；配合 `handleDrop` / `handlePaste` 可实现拖拽/粘贴插入。
3. **输出可控**：TipTap 的文档树可序列化为 JSON（`editor.getJSON()`），与后端 "content blocks" 概念天然同构，无需复杂的 HTML 清洗。
4. **可渐进增强**：初期只开 `StarterKit + Image + Placeholder`，后续如需提及（`@Agent`）、斜杠命令、Markdown 快捷键，均可通过扩展插件叠加，不破坏既有架构。
5. **移动端**：ProseMirror 的选区管理在移动端 WebView 中经过大量产品验证，软键盘弹起时光标不会丢失，且可通过 `scrollIntoView()` 自动滚动到输入光标。

### 1.3 前端依赖新增

```bash
cd frontend
npm install @tiptap/vue-3 @tiptap/core @tiptap/starter-kit \
  @tiptap/extension-image @tiptap/extension-placeholder
```

### 1.4 编辑器输出格式

TipTap 的 JSON 输出（`editor.getJSON()`）示例：

```json
{
  "type": "doc",
  "content": [
    {"type": "paragraph", "content": [{"type": "text", "text": "这个报错帮我看看"}]},
    {"type": "image", "attrs": {"src": "/uploads/xxx.png", "width": 800, "height": 600}},
    {"type": "paragraph", "content": [{"type": "text", "text": "我觉得问题出在这里"}]}
  ]
}
```

前端在发送前将上述 TipTap JSON **扁平化为 content blocks 数组**（见第 2 节），减少传输体积并降低后端解析复杂度。

---

## 2. 数据模型变更

### 2.1 当前格式回顾

前端发送：
```ts
ws.sendChat(sessionId, `[image:/uploads/xxx.png]\n文字内容`, { content_type: 'mixed' })
```

数据库存储：`content: TEXT = "[image:/uploads/xxx.png]\n文字内容"`，`content_type: "mixed"`。

### 2.2 目标格式：Content Blocks（方案 A 胜出）

**推荐方案 A：纯 JSON 数组存储**，但采用 **"双列并存"** 的实现策略以兼顾搜索与兼容。

#### 2.2.1 新列设计

在 `chat_messages` 表中新增一列 `content_blocks: JSON`，同时保留现有 `content: TEXT` 作为 **纯文本降级（fallback）** 与 **全文搜索** 用途。

```python
# backend/app/models/chat.py
class ChatMessage(Base):
    # ... 现有字段保留 ...
    content: Mapped[str] = mapped_column(Text, nullable=False)          # 降级文本 / 旧消息
    content_type: Mapped[str] = mapped_column(String(32), default="text") # text | image | mixed | rich
    content_blocks: Mapped[Optional[list]] = mapped_column(JSON, default=None)  # NEW
```

#### 2.2.2 Content Block Schema

```json
[
  {"type": "text", "text": "这个报错帮我看看"},
  {"type": "image", "url": "/uploads/xxx.png", "width": 800, "height": 600},
  {"type": "text", "text": "我觉得问题出在这里"},
  {"type": "file", "url": "/uploads/abc.zip", "name": "abc.zip", "size": 10240}
]
```

| 字段 | 说明 |
|------|------|
| `type` | `text` / `image` / `file` / `thinking`（后端内部使用） |
| `text` | 文本内容，保留换行与 Markdown 原样 |
| `url` | 图片/文件地址 |
| `width` / `height` | 图片原始尺寸（前端上传后由后端返图时带回，用于渲染占位防止跳动） |
| `name` / `size` | 文件名与大小（file 类型） |

#### 2.2.3 为什么不是方案 B（类 Markdown 标记）？

- **检索困难**：需要正则或 XML 解析才能提取纯文本做搜索高亮。
- **转义风险**：用户输入的 `<>` 与标记语法冲突，需要额外的 escape/unescape。
- **前端成本**：TipTap 天然输出 JSON，若再转一层标记语法，增加序列化/反序列化开销且无收益。
- **LLM 接口**：OpenAI / Anthropic 的 `content` array 本身就是 JSON，方案 A 可直接映射，方案 B 还需二次解析。

### 2.3 向后兼容策略

| 场景 | 处理 |
|------|------|
| **旧消息（无 content_blocks）** | `content_type` 为 `text` / `image` / `mixed`，渲染器走旧的 `parseContent()` 解析 `[image:url]`。 |
| **新消息** | `content_type = "rich"`，优先使用 `content_blocks`；`content` 字段同时存储降级后的纯文本（不含 `[image:url]` 标记，仅保留文字），用于会话列表预览和数据库搜索。 |
| **前端发送** | 若编辑器为空或纯文本无图，可继续发送 `content_type: "text"` 以节省带宽；一旦包含图片节点，发送 `content_type: "rich"` + `content_blocks: [...]`。 |
| **Agent 回复** | Agent 当前仍输出 `[image:url]` 字符串，后端 `_parse_mixed_content()` 解析为 `ContentBlock` 后，按新格式入库（`content_type='rich'`）。 |

---

## 3. 消息渲染

### 3.1 渲染逻辑调整

`ChatView.vue` 与 `GroupChatView.vue` 当前通过 `parseContent(msg.content)` 将 `[image:url]` 解析为 segments。需新增统一的 `MessageContent` 渲染组件：

```vue
<!-- 伪代码 -->
<MessageContent
  :blocks="msg.content_type === 'rich' ? msg.content_blocks : parseContent(msg.content)"
  :content-type="msg.content_type"
/>
```

### 3.2 图片渲染规则

- **自适应宽度**：图片在气泡内最大宽度 `200px`（保持现有样式 `max-width: 200px; max-height: 200px;`）。
- **点击放大**：保留现有的 `previewUrl` 机制，点击图片弹出全屏 overlay（`max-width: 90vw; max-height: 90vh;`）。
- **占位防跳动**：若 `content_blocks` 中带有 `width/height`，前端按宽高比渲染占位容器，加载完成后替换为真实图片，避免列表跳动。
- **圆角与边距**：沿用现有 `.inline-img` 样式（`border-radius: 8px; display: block; margin: 4px 0;`）。

### 3.3 Markdown 渲染

文本块继续走 `marked.parse()` + `DOMPurify.sanitize()`，与现有逻辑一致。若一个 `text` block 内部包含 Markdown，它将被完整渲染。多个 `text` block 之间的图片不会打断 Markdown 块级结构（因为图片本身已是独立 block）。

---

## 4. 后端 MessageBuilder 适配

### 4.1 当前能力

`MessageBuilder` 已经原生支持 `Sequence[ContentBlock]`：
- `_with_sender_prefix()`：遍历 blocks，在第一个 `TextBlock` 前追加 sender 前缀。
- `_inject_time_tag()`：遍历 blocks，在第一个 `TextBlock` 中注入时间标记，**不会**作为独立 block 插入在图片前。

这两个方法已满足 "图文穿插时前缀/时间标记注入到第一个文本块" 的需求，**无需改动**。

### 4.2 需要新增的链路

当前前端消息通过 `ws.sendChat()` 发送字符串，后端 `ws_handlers.py` 直接入库。引入 `content_blocks` 后：

1. **WS Protocol 扩展**：`chat.send` 的 payload 允许携带 `content_blocks: list[dict] | None`。
2. **入库逻辑**（`_handle_chat_send`）：
   - 若收到 `content_blocks`，将其写入 `ChatMessage.content_blocks`。
   - 同时将 `content_blocks` 中的纯文本拼接为 `content`（用于搜索和会话列表预览）。
3. **Agent 输入构建**（`react.py`）：
   - 若用户消息 `content_type == 'rich'` 且 `content_blocks` 存在，直接将其映射为后端 `ContentBlock` 列表（`TextBlock`, `ImageBlock`）。
   - 若消息为旧格式，继续走 `_parse_mixed_content()` 解析 `[image:url]`。
4. **Agent 输出入库**：Agent 生成 `[image:url]` 时，后端 `_parse_mixed_content()` 解析后，将结果同时写入 `content_blocks`（JSON）和降级 `content`（纯文本 + 标记），并将 `content_type` 设为 `"rich"`。

### 4.3 ContentBlocks → LLM API 映射

后端的 `ContentBlock` 体系（`TextBlock`, `ImageBlock`）与 LLM 多模态 API（OpenAI/Claude）已经对齐：

```python
# backend/engine/agent/react.py 中已存在
blocks = [TextBlock(text="..."), ImageBlock(source={"url": "..."})]
```

`MessageBuilder.build()` 输出的 `Message` 列表可直接送入 `ProviderTransport`，无需额外转换。

---

## 5. 时间标记注入（_inject_time_tag）

### 5.1 现状

`_inject_time_tag(msg, time_tag)` 已正确实现：

```python
if isinstance(msg.content, str):
    return Message(role=..., content=tagged + msg.content, ...)
# list[ContentBlock] 分支
for b in msg.content:
    if not injected and isinstance(b, TextBlock):
        new_blocks.append(TextBlock(text=tagged + b.text))
        injected = True
    else:
        new_blocks.append(b)
```

### 5.2 图文穿插场景验证

假设用户发送了：
```
[图片] + "文字说明"
```

对应 blocks：
```python
[ImageBlock(...), TextBlock(text="文字说明")]
```

`_inject_time_tag` 会跳过 `ImageBlock`，在第一个 `TextBlock` 注入时间标记：
```
[ImageBlock(...), TextBlock(text="[06-10 08:12 Wed | +3h22m]\n\n文字说明")]
```

**结论**：现有逻辑完全满足需求，无需修改。

---

## 6. 向后兼容

### 6.1 前端渲染兼容

新建 `useMessageBlocks(msg)` composable，统一处理新旧格式：

```ts
function useMessageBlocks(msg: Message) {
  if (msg.content_type === 'rich' && msg.content_blocks?.length) {
    return msg.content_blocks
  }
  // 旧格式 fallback
  return parseContent(msg.content)
}
```

`ChatView.vue` 与 `GroupChatView.vue` 统一替换为 `useMessageBlocks`，确保旧消息正常显示。

### 6.2 数据库迁移策略

**不需要立即全量迁移**。采用 "读时兼容、写时新格式"：

1. **Schema Migration**：新增 `content_blocks JSON` 列，允许 `NULL`。
2. **旧数据**：保持原样，`content_type` 为 `text/image/mixed`，`content_blocks` 为 `NULL`。
3. **新数据**：`content_type = 'rich'`，`content_blocks` 有值，`content` 存储降级文本。
4. **可选后期迁移**：编写一次性脚本，将历史 `[image:url]` 消息反序列化为 `content_blocks`，仅当需要统一搜索/导出时执行。

### 6.3 降级文本生成规则

当 `content_blocks` 入库时，同步生成 `content` 纯文本：

```python
def flatten_blocks_to_text(blocks: list[dict]) -> str:
    parts = []
    for b in blocks:
        if b["type"] == "text":
            parts.append(b["text"])
        elif b["type"] == "image":
            parts.append(f"[图片]")  # 或保留 [image:url] 标记
        elif b["type"] == "file":
            parts.append(f"[文件: {b.get('name', '附件')}]")
    return "\n".join(parts)
```

这样：
- 会话列表的 `last_message` 预览可直接读 `content`。
- 数据库搜索继续对 `content` 列做 `ILIKE`，无需改动索引。

---

## 7. 涉及改动的文件清单

### 7.1 数据库 / Model

| 文件 | 改动 |
|------|------|
| `backend/app/models/chat.py` | `ChatMessage` 新增 `content_blocks: Mapped[Optional[list]] = mapped_column(JSON, default=None)` |

### 7.2 后端 API / WS

| 文件 | 改动 |
|------|------|
| `backend/app/api/ws_handlers.py` | `_handle_chat_send` 解析 `content_blocks`；入库时生成降级文本；广播消息带 `content_blocks` |
| `backend/app/api/chat.py` | `SendMessageReq` 新增 `content_blocks`；`get_messages` 返回 `content_blocks` |
| `backend/engine/agent/react.py` | 用户消息构建时优先使用 `content_blocks`，否则走 `_parse_mixed_content` |
| `backend/engine/session/store.py` | Agent 回复入库时，将解析后的 blocks 写入 `content_blocks`，`content_type='rich'` |

### 7.3 前端 Store / API

| 文件 | 改动 |
|------|------|
| `frontend/src/stores/chat.ts` | `Message` 接口新增 `content_blocks?: BlockItem[]` |
| `frontend/src/composables/useWebSocket.ts` | `sendChat` 支持传入 `content_blocks` |
| `frontend/src/api/client.ts` | 如有 HTTP 发送消息接口，同步扩展字段 |

### 7.4 前端组件

| 文件 | 改动 |
|------|------|
| `frontend/src/components/ChatView.vue` | 输入区 `<textarea>` 替换为 `<RichTextInput>`；渲染区改用 `MessageContent` 组件 |
| `frontend/src/components/GroupChatView.vue` | 同上 |
| `frontend/src/components/RichTextInput.vue` | **新增**：TipTap 编辑器封装，支持粘贴/拖拽/按钮插入图片 |
| `frontend/src/components/MessageContent.vue` | **新增**：统一渲染 blocks（文本 Markdown + 图片 + 文件） |
| `frontend/src/composables/useMessageBlocks.ts` | **新增**：新旧格式兼容转换 |

---

## 8. 实施批次建议

建议分 3 个批次落地，降低风险：

### 批次 1：基础设施（无 UI 变化）

- [ ] 数据库 Migration：新增 `content_blocks` JSON 列。
- [ ] 后端 `ChatMessage` 模型与 Pydantic Schema 扩展。
- [ ] WS / REST API 支持接收并透传 `content_blocks`。
- [ ] 后端入库时生成降级 `content` 文本。
- [ ] Agent 回复入库时，将 `[image:url]` 解析为 `content_blocks`（`content_type='rich'`）。

**验收标准**：通过后端的 Admin / 测试脚本，可写入并读取 `content_blocks`，旧客户端无感知。

### 批次 2：前端渲染与编辑器

- [ ] 安装 TipTap 依赖。
- [ ] 开发 `RichTextInput.vue`（基础加粗/斜体非必须，重点支持图文穿插）。
- [ ] 开发 `MessageContent.vue` 与 `useMessageBlocks`，替换 `ChatView` / `GroupChatView` 的渲染逻辑。
- [ ] 前端发送逻辑：编辑器有图片时发送 `content_type='rich'` + `content_blocks`。
- [ ] 保持旧消息通过 `parseContent` 正常渲染。

**验收标准**：用户可在输入框任意位置插入图片，发送后消息气泡内图文顺序正确，旧消息不受影响。

### 批次 3：体验优化与灰度收尾

- [ ] 图片占位防跳动（利用 `width/height`）。
- [ ] 移动端软键盘适配（TipTap 自动滚动）。
- [ ] 拖拽排序图片（TipTap 的 `DragHandle` 扩展）。
- [ ] 性能：大会话（>500 条消息）的渲染虚拟滚动评估。
- [ ] 可选：历史消息批量迁移脚本。

---

## 9. 风险评估

| 风险 | 影响 | 缓解措施 |
|------|------|----------|
| **TipTap 包体积增加 ~60KB** | 中 | 仅引入必要扩展（StarterKit + Image + Placeholder），Vite tree-shaking 后实际增量约 40KB；在 Tauri 桌面端可忽略。 |
| **content_blocks JSON 存储膨胀** | 低 | 单条消息 blocks 数量通常 < 20，JSON 体积 < 几 KB；数据库 `content` 纯文本列保留，不破坏既有查询性能。 |
| **旧客户端不识别 `content_blocks`** | 中 | 批次 1 确保后端仍返回 `content` 降级文本；旧客户端读不到 `content_blocks` 会自动 fallback 到 `content`。 |
| **图片粘贴/拖拽跨浏览器差异** | 低 | TipTap 已封装 `handleDrop` / `handlePaste`，仅需补充上传逻辑（复用现有 `/upload` API）。 |
| **Agent 输出格式仍含 `[image:url]`** | 低 | 维持现有 `_parse_mixed_content` 作为解析层，Agent 无需改动；入库时统一转换为新格式。 |
| **时间标记注入到非首个文本块** | 低 | 已验证 `_inject_time_tag` 逻辑正确；若用户消息以图片开头，时间标记会注入到图片后的第一个文本块，语义正确。 |
| **移动端 WebView 光标丢失** | 中 | TipTap/ProseMirror 已处理大部分 case；如仍有问题，可降级为纯文本 + 图片缩略图栏的简化模式。 |

---

## 附录：数据结构速查

### A. 前端 BlockItem 类型（TypeScript）

```ts
type BlockItem =
  | { type: 'text'; text: string }
  | { type: 'image'; url: string; width?: number; height?: number }
  | { type: 'file'; url: string; name: string; size?: number }
```

### B. 后端 content_blocks JSON 示例

```json
[
  {"type": "text", "text": "先看这张图"},
  {"type": "image", "url": "/uploads/chat/abc.png", "width": 800, "height": 600},
  {"type": "text", "text": "再看这张"},
  {"type": "image", "url": "/uploads/chat/def.jpg", "width": 400, "height": 300},
  {"type": "text", "text": "问题在第二行。"}
]
```

### C. 降级 content 文本示例

```
先看这张图
[图片]
再看这张
[图片]
问题在第二行。
```
