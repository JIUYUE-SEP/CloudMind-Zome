# 模型类型分类体系——方案检查报告

> 检查对象：docs/model-type-design.md  
> 检查日期：2026-06-10  
> 结论：设计文档总体可行，但存在 **1 个阻塞级技术问题**、**3 个高风险遗漏** 和 **5 个中等风险细节**，需在实施前修正方案。

---

## 优先级总览

| 优先级 | 问题 | 影响 |
|---|---|---|
| 🔴 P0 | SQLite 无法将现有 NOT NULL 列改为 nullable | 数据库迁移阻塞，必须给出重建表方案 |
| 🔴 P0 | `ada-002` 等常见模型未被正则覆盖，会误判为 llm | 数据污染，用户核心 Embedding 模型被归类为对话模型 |
| 🟡 P1 | `provider_resolver.py` 的 `ResolvedModel` 未处理 NULL | 运行时 TypeError，Marker/压缩器构建失败 |
| 🟡 P1 | 已有 Agent 的 Embedder 指向默认 `llm` 类型模型 | 上线后 ModelSelector 过滤导致 Embedder 空选，用户配置丢失 |
| 🟡 P1 | 文件清单遗漏 `provider_resolver.py` 和 `marker.py` | 实施时漏改，导致运行时错误 |
| 🟢 P2 | 前端 hint 对非 LLM 模型展示无意义 | 体验问题，需补充 UI 规则 |
| 🟢 P2 | `context_window`/`max_output_tokens` 从前端消失后，store 类型未更新 | TypeScript 编译错误 |
| 🟢 P2 | 发现模型导入未传 `model_type` | 导入的新模型默认 llm，需用户二次编辑 |
| 🟢 P2 | Setting 表残留旧数据未清理 | 无功能影响，但数据脏乱 |

---

## 1. 数据库影响

### 1.1 SQLite 修改 NOT NULL 列：阻塞级问题

**现状**：`llm_models` 表的 `context_window` 和 `max_output_tokens` 当前定义如下：

```python
# backend/app/models/models.py
context_window: Mapped[int] = mapped_column(Integer, nullable=False)
max_output_tokens: Mapped[int] = mapped_column(Integer, nullable=False)
```

**问题**：SQLite **不支持** `ALTER TABLE ... ALTER COLUMN ... DROP NOT NULL`。项目又没有使用 Alembic，当前的 `_migrate` 函数只有 `ADD COLUMN` 能力。

如果直接把 SQLAlchemy 模型改为 `nullable=True`，**已有数据库文件的表约束仍然是 `NOT NULL`**。此时插入非 LLM 模型（不填这两个字段）会触发：

```
IntegrityError: NOT NULL constraint failed: llm_models.context_window
```

**建议方案（三选一）**：

| 方案 | 做法 | 优点 | 缺点 |
|---|---|---|---|
| A. 重建表 | `_migrate` 中写完整迁移：创建 `llm_models_new` → 拷贝数据 → `DROP TABLE` → `ALTER TABLE ... RENAME TO` | 彻底解决问题 | 需要处理外键和索引重建，代码量较大 |
| B. 虚拟值占位 | 不改数据库约束，非 LLM 模型写入 `context_window=-1`、`max_output_tokens=-1`，API 返回时根据 `model_type` 翻译为 `null` | 无需重建表，兼容性好 | 语义脏，所有读取处都要做翻译 |
| C. 保留 NOT NULL + 默认值 0 | 不改数据库约束，非 LLM 模型写 0，前端不展示 | 最简单 | 0 可能被误解为真值，统计时干扰 |

**推荐方案 A（重建表）**：在 `_migrate` 中增加专用逻辑：

```python
def _migrate_llm_models_nullable(sync_conn):
    from sqlalchemy import inspect, text
    inspector = inspect(sync_conn)
    cols = {c['name']: c for c in inspector.get_columns('llm_models')}
    # 检查 context_window 是否仍是 NOT NULL
    if cols.get('context_window', {}).get('nullable') is False:
        # SQLite 重建表
        sync_conn.execute(text("""
            CREATE TABLE llm_models_new (
                id TEXT PRIMARY KEY,
                provider_id TEXT NOT NULL,
                user_id TEXT NOT NULL,
                display_name TEXT NOT NULL,
                is_builtin INTEGER DEFAULT 0,
                status TEXT DEFAULT 'active',
                context_window INTEGER,
                max_output_tokens INTEGER,
                supports_multimodal INTEGER DEFAULT 0,
                input_modalities TEXT,
                output_modalities TEXT,
                supports_streaming INTEGER DEFAULT 1,
                supports_tool_calling INTEGER DEFAULT 0,
                supports_reasoning INTEGER DEFAULT 0,
                pricing TEXT,
                model_type TEXT DEFAULT 'llm' NOT NULL,
                created_at TEXT,
                updated_at TEXT
            )
        """))
        sync_conn.execute(text("""
            INSERT INTO llm_models_new SELECT
                id, provider_id, user_id, display_name, is_builtin, status,
                context_window, max_output_tokens, supports_multimodal,
                input_modalities, output_modalities, supports_streaming,
                supports_tool_calling, supports_reasoning, pricing,
                COALESCE(model_type, 'llm'), created_at, updated_at
            FROM llm_models
        """))
        sync_conn.execute(text("DROP TABLE llm_models"))
        sync_conn.execute(text("ALTER TABLE llm_models_new RENAME TO llm_models"))
        sync_conn.execute(text("CREATE INDEX idx_llm_models_provider ON llm_models(provider_id)"))
        sync_conn.execute(text("CREATE INDEX idx_llm_models_user ON llm_models(user_id)"))
```

> ⚠️ 重建表时 `PRAGMA foreign_keys` 需临时关闭，否则 `DROP TABLE` 可能因外键约束失败。

### 1.2 现有代码读取 NULL 的处理情况

**`provider_resolver.py`**：
- `ResolvedModel` 是 `dataclass(frozen=True)`，字段类型为 `int`（非 Optional）。
- `resolve_model_attributes` 直接从 `model.context_window` 读取并赋值。
- 如果数据库中这两列出现 NULL，Python 会把它作为 `None` 赋给 `int` 字段，**不会立即报错**（dataclass 不做运行时类型检查），但后续 `attrs.context_window / 2000` 会抛出 `TypeError: unsupported operand type(s) for /: 'NoneType' and 'int'`。

**`marker.py`（TopicMarker）**：
```python
timeout = max(30.0, min(180.0, attrs.context_window / 2000))
```
Marker 只用于 LLM，逻辑上不会拿到 NULL，但类型层面不保险。

**`topic_memory.py`**：
```python
context_window = model_cfg.get("context_window") or model_cfg.get("max_tokens", 128000)
```
这里读的是 Agent 的 `model_config` JSON 字段，不是 LLMModel 表，**不受本次变更影响**。

**结论**：只要保证 `resolve_model_attributes` 在读取到 NULL 时回退到默认值，就不会有风险。需要把 `ResolvedModel` 改为 `Optional[int]` 或在赋值前做 `if model.context_window is not None else 32000`。

---

## 2. providers.yaml Schema

### 2.1 Pydantic 校验规则调整

当前 `ModelConfig`：
```python
context_window: int = Field(..., gt=0)
max_output_tokens: int = Field(..., gt=0)
```

改为 nullable 后：
```python
from typing import Optional

context_window: Optional[int] = Field(default=None)
max_output_tokens: Optional[int] = Field(default=None)
```

Pydantic v2 中，`Optional[int] = Field(default=None)` 在 YAML 省略该字段时会正确解析为 `None`，不会报错。

### 2.2 `_upsert_model` 的赋值安全

`provider_migration.py` 中：
```python
m.context_window = cfg.context_window
m.max_output_tokens = cfg.max_output_tokens
```

如果 `cfg.context_window` 是 `None` 而数据库列仍是 `NOT NULL`，这里会爆。需要与数据库迁移同步修改。

---

## 3. 前端 ComputeCenter 模型编辑

### 3.1 表单动态显示/隐藏

当前模型编辑表单中，`context_window` 和 `max_output_tokens` 是硬编码的必填输入框，且有 `>0` 校验：

```typescript
if (!editModelForm.value.context_window || editModelForm.value.context_window < 1) {
  modelEditError.value = '上下文窗口必须大于 0'
  return
}
```

**调整方案**：
1. 模型编辑/添加表单顶部增加 `model_type` 下拉框。
2. 当 `model_type !== 'llm'` 时，隐藏 `context_window` 和 `max_output_tokens` 输入框，也不做校验。
3. 提交时如果非 LLM，不传这两个字段（或传 `null`，由后端处理为 `None`）。

### 3.2 `store.updateModel()` / `store.addModel()` 传参

当前前端调用：
```typescript
await store.updateModel(editProvider.value.id, editingModelId.value, {
  display_name: ...,
  context_window: ...,
  max_output_tokens: ...,
})
```

后端 `ModelUpdate` 中这两个字段已经是 `Optional[int] = None`，所以不传是安全的。但前端TypeScript 中如果表单对象没有这两个字段，需要确保不会传 `undefined` 导致意外覆盖。建议显式判断：

```typescript
const body: any = { display_name: ..., model_type: ... }
if (modelType === 'llm') {
  body.context_window = ...
  body.max_output_tokens = ...
}
```

---

## 4. 前端 ModelSelector hint

### 4.1 当前实现

```vue
<p class="hint" v-if="currentModel">
  上下文窗口：{{ currentModel.context_window.toLocaleString() }} tokens，
  最大输出：{{ currentModel.max_output_tokens.toLocaleString() }} tokens
</p>
```

### 4.2 非 LLM 模型的展示策略

| 模型类型 | 建议展示内容 | 备注 |
|---|---|---|
| `llm` | 保持现有 hint | 上下文窗口 + 最大输出 + 能力图标 |
| `embedding` | 显示 "向量嵌入模型 · OpenAI 兼容 /v1/embeddings" | 当前无 dimensions 字段，暂不能显示维度 |
| `image` | 显示 "图片生成模型 · 支持 /v1/images/generations" | 可后续扩展支持尺寸参数 |
| `stt` | 显示 "语音识别模型 · 支持 /v1/audio/transcriptions" | |

**实现建议**：将 hint 改为条件渲染：

```vue
<p class="hint" v-if="currentModel">
  <template v-if="currentModel.model_type === 'llm'">
    上下文窗口：{{ currentModel.context_window?.toLocaleString() ?? '-' }} tokens，
    最大输出：{{ currentModel.max_output_tokens?.toLocaleString() ?? '-' }} tokens
    <!-- 能力图标 -->
  </template>
  <template v-else-if="currentModel.model_type === 'embedding'">
    向量嵌入模型 · 用于语义搜索
  </template>
  <template v-else-if="currentModel.model_type === 'image'">
    图片生成模型 · 用于 AI 生图
  </template>
  <template v-else-if="currentModel.model_type === 'stt'">
    语音识别模型 · 用于音频转文字
  </template>
</p>
```

同时 `compute.ts` 中 `ModelInfo` 接口需要把 `context_window` 和 `max_output_tokens` 改为可选：

```typescript
export interface ModelInfo {
  // ...
  context_window?: number | null
  max_output_tokens?: number | null
  model_type: 'llm' | 'embedding' | 'image' | 'stt'
}
```

---

## 5. 测试连接时的类型推断

### 5.1 正则规则遗漏

当前设计文档中的规则：
```python
DISCOVERY_RULES = [
    (r"embed", "embedding"),
    (r"dall-e|flux|sdxl|image", "image"),
    (r"whisper|stt|speech", "stt"),
]
```

**遗漏的常见模型名**：

| 模型名 | 实际类型 | 是否被现有规则覆盖 |
|---|---|---|
| `text-embedding-ada-002` | embedding | ✅ 含 `embedding` |
| `ada-002` / `ada` | embedding | ❌ **未覆盖！** |
| `bge-m3` / `bge-large` | embedding | ✅ 含 `bge`（如果加入） |
| `e5-large-v2` | embedding | ✅ 含 `e5`（如果加入） |
| `gte-base` / `gte-large` | embedding | ❌ 未覆盖 |
| `m3e-base` | embedding | ❌ 未覆盖 |
| `cogview-3` / `cogview-3-plus` | image | ❌ 未覆盖 |
| `kling` | image/video | ❌ 未覆盖 |
| `wanx-v1` | image | ✅ 含 `wanx` |
| `sensevoice-small` / `sensevoice` | stt | ✅ 含 `sense` |
| `nova-2` / `nova` | stt | ❌ 未覆盖 |

**`ada-002` 是特别危险的遗漏**：这是 OpenAI 历史上最广泛使用的 Embedding 模型，大量用户可能配置了它。如果默认归为 `llm`，会导致语义搜索不可用。

### 5.2 建议的完整规则表

```python
DISCOVERY_RULES = [
    # Embedding（优先级高，因为很多模型名不含 "embed"）
    (r"\b(ada-002|ada\b|text-embedding|embedding|embed|bge-|e5-|gte-|m3e-|m-e5|multilingual-e5|nv-embed)", "embedding"),
    # Image
    (r"\b(dall-e|flux|sdxl|stable-diffusion|midjourney|wanx|cogview|kling|imagen|playground|recraft|ideogram)", "image"),
    # STT
    (r"\b(whisper|sensevoice|sense|nova-|stt-|asr-|speech-to-text|speech)", "stt"),
]
```

> 注意：正则中使用 `\b` 单词边界，避免 `midjourney` 中的 `ey` 被误匹配（虽然当前规则没有这个问题）。

### 5.3 默认归为 llm 是否合理？

对于不含任何关键词的模型（如 `gpt-4o`、`claude-3-5-sonnet`、`qwen-max`），默认归为 `llm` 是合理的，因为对话模型命名最自由，而 Embedding/生图/STT 模型通常有明确标识。

但 `ada-002` 是个例外，需要单独加入规则。

---

## 6. 向后兼容

### 6.1 llm_models 表数据

**确认**：当前数据库 `llm_models` 表中确实只有对话模型。因为：
- 之前 Embedding 和 ImageGen 配置存在 **Setting 表**（key=`embedding_model`）或 **engine/config.yaml**（`image_gen` 字段）。
- 它们从未进入 `llm_models` 表。
- `providers.yaml` 的 `ModelConfig` 之前也没有 `model_type` 字段。

所以 "现有数据默认 llm" 是安全的。

### 6.2 Agent 配置的潜在断裂

**风险场景**：
1. 用户之前在某 Provider（如 OpenAI）上点击了「测试连接并发现模型」，导入了 `ada-002`、`dall-e-3` 等模型。
2. 这些模型在 `llm_models` 中默认标记为 `llm`（因为当前没有类型推断）。
3. 用户在 AgentEdit 中把 Embedder 配置为 `ada-002`（通过 Provider + Model 选择）。
4. 本方案上线后：
   - `ada-002` 仍然是 `llm`（如果用户没有重新测试连接并修正类型）。
   - AgentEdit 中 Embedder 的 `<ModelSelector model-type="embedding">` 会过滤掉 `ada-002`。
   - 用户打开已有 Agent，Embedder 下拉框显示为空或选不上，产生困惑。

**建议的缓解措施**：
1. **启动迁移脚本**：在 `main.py` 的 `_migrate` 中，对已存在的 `llm_models` 执行一次 `infer_model_type`，自动修正模型类型。
   ```python
   # 在 _migrate 中
   if 'model_type' in model_cols:
       # 已有 model_type 列，可能是本次迁移刚加的（默认 llm）
       # 对已存在的模型运行推断并更新
       sync_conn.execute(text(
           "UPDATE llm_models SET model_type = CASE ... END"
       ))
   ```
2. 或者在 ComputeCenter 的 Provider 编辑页面增加一个「重新推断所有模型类型」的批量按钮。

### 6.3 Setting 表残留数据

Setting 表中可能仍有如下旧数据：
- `key='embedding_model'`, `value={"provider_id": "...", "model": "..."}`
- `key='image_gen'`, `value={...}`

这些数据：
- 当前 API 已标记为 DEPRECATED，不再读取。
- 不会与 `llm_models` 新体系冲突。
- 但长期不清理会造成数据脏乱。

**建议**：在 `_migrate` 或启动脚本中清理：
```python
await db.execute(text(
    "DELETE FROM settings WHERE key IN ('embedding_model', 'image_gen', 'assistant_model')"
))
```

---

## 7. 改动文件清单完整性

### 7.1 已列出的文件（确认存在 ✅）

| 文件 | 状态 |
|---|---|
| `backend/app/models/models.py` | ✅ 存在 |
| `backend/app/core/provider_schema.py` | ✅ 存在 |
| `backend/app/api/models.py` | ✅ 存在 |
| `backend/app/api/compute.py` | ✅ 存在 |
| `backend/app/services/provider_migration.py` | ✅ 存在 |
| `backend/app/main.py` | ✅ 存在 |
| `frontend/src/stores/compute.ts` | ✅ 存在 |
| `frontend/src/components/ModelSelector.vue` | ✅ 存在 |
| `frontend/src/components/ComputeCenter.vue` | ✅ 存在 |
| `frontend/src/components/ComputeTab.vue` | ✅ 存在 |
| `frontend/src/components/AgentEdit.vue` | ✅ 存在（设计文档第 4 节提了，第 6 节清单也列了） |

### 7.2 遗漏的文件

| 遗漏文件 | 需要改动的原因 | 优先级 |
|---|---|---|
| `backend/app/services/provider_resolver.py` | `ResolvedModel` 的 `context_window`/`max_output_tokens` 需改为 `Optional[int]`；`resolve_model_attributes` 需处理 NULL 回退默认值 | P1 |
| `backend/engine/memory/topic_compression/marker.py` | `TopicMarker.from_agent` 中 `attrs.context_window / 2000` 在 `context_window` 为 None 时会 TypeError。虽然 Marker 只用于 LLM，但防御性编程需要保护 | P1 |
| `frontend/src/components/ComputeCenter.vue`（补充） | `importDiscovered()` 中调用 `store.addModel` 时不传 `model_type`，导入的模型全部默认 `llm`。需要把 discoverModal 中的 `model_type` 传进去 | P2 |
| `backend/app/api/agents.py` | `_model_to_dict` 的兄弟函数（agents.py 中也有模型属性返回逻辑）。需要检查是否返回 `model_type` | P2 |

### 7.3 `agents.py` 中的模型读取检查

```python
# backend/app/api/agents.py（之前 grep 结果）
"context_window": m.context_window,
"max_output_tokens": m.max_output_tokens,
```

需要确认 `agents.py` 中返回模型列表时是否也需要带上 `model_type`，否则前端 AgentEdit 的 `llmProviders`（如果它从 agents API 获取）会缺少类型信息。但从代码看，`AgentEdit.vue` 使用的是 `computeStore.fetchProviders()`，不是 agents API，所以影响有限。

---

## 8. 综合建议

### 8.1 设计文档需要补充的内容

1. **数据库迁移章节**：补充 `llm_models` 表重建逻辑（处理 `context_window`/`max_output_tokens` 从 NOT NULL 改为 nullable）。
2. **`provider_resolver.py` 修改**：在文件清单中补充，并说明 `ResolvedModel` 和 `resolve_model_attributes` 的 NULL 处理策略。
3. **`marker.py` 防御性修改**：说明即使 Marker 只用于 LLM，也需增加 `context_window or 64000` 的保护。
4. **启动批量推断**：补充对已存在模型的 `infer_model_type` 批量更新逻辑，避免已有 Agent 的 Embedder 配置断裂。
5. **`ada-002` 规则**：在 `DISCOVERY_RULES` 中加入 `\bada\b` 和 `\bada-002\b`。
6. **Setting 表清理**：补充废弃 Setting key 的清理逻辑。
7. **前端 store 类型**：`compute.ts` 中 `ModelInfo` 接口的 `context_window`/`max_output_tokens` 改为 `number | null`。

### 8.2 推荐实施顺序（修正版）

1. **后端 Schema + 迁移**：
   - `provider_schema.py`（`model_type` + nullable `context_window`/`max_output_tokens`）
   - `models.py`（SQLAlchemy 模型同步）
   - `main.py`（`_migrate` 重建 `llm_models` 表 + 批量推断已有模型类型 + 清理 Setting 旧数据）
2. **后端核心服务**：
   - `provider_migration.py`（YAML 同步 `model_type` + nullable 处理）
   - `provider_resolver.py`（`ResolvedModel` 改为 Optional + NULL 回退）
   - `api/models.py`（API Schema + `_model_to_dict`）
   - `api/compute.py`（返回 `model_type` + `test_provider` 推断）
3. **前端基础**：
   - `stores/compute.ts`（类型定义 + `groupByModelType`）
   - `api/client.ts`（如需要）
4. **前端组件**：
   - `ModelSelector.vue`（`modelType` prop + hint 条件渲染）
   - `ComputeCenter.vue`（分区域布局 + 模型表单动态显示 + 发现模型 Modal 类型选择）
   - `ComputeTab.vue`（传入 `model-type`）
   - `AgentEdit.vue`（`createNew` 按类型取默认值）
5. **Engine 防御性修改**：
   - `marker.py`（`context_window or 64000`）

---

## 附录：快速检查清单（实施前核对）

- [ ] `main.py` `_migrate` 中有 `llm_models` 表重建逻辑，而非仅 `ADD COLUMN`
- [ ] `provider_resolver.py` `ResolvedModel` 的 `context_window`/`max_output_tokens` 是 `Optional[int]`
- [ ] `infer_model_type` 正则规则包含 `\bada\b` 和 `\bada-002\b`
- [ ] 启动脚本对已存在模型批量运行 `infer_model_type` 并更新数据库
- [ ] `ModelInfo` 接口中 `context_window`/`max_output_tokens` 是 `number | null`
- [ ] `ComputeCenter.vue` 发现模型导入时提交 `model_type`
- [ ] `ModelSelector.vue` hint 对非 LLM 模型有条件渲染
- [ ] `ComputeCenter.vue` 模型编辑表单在非 LLM 时隐藏 `context_window`/`max_output_tokens`
- [ ] Setting 表中 `embedding_model`/`image_gen`/`assistant_model` 已被清理
