# CloudMind-Zome 模型类型分类体系设计方案

> 状态：设计文档（未实施）  
> 目标：将混在一起的模型按用途分类（对话 / Embedding / 图片生成 / 语音识别），使算力中枢分区域展示、心智整备下拉框按类型过滤。

---

## 1. 数据模型变更

### 1.1 类型枚举

```python
ModelType = Literal["llm", "embedding", "image", "stt"]
```

| 值 | 含义 | 典型 API Endpoint |
|---|---|---|
| `llm` | 对话/推理模型（默认） | `/v1/chat/completions` |
| `embedding` | 向量嵌入模型 | `/v1/embeddings` |
| `image` | 图片生成模型 | `/v1/images/generations` |
| `stt` | 语音识别模型（Whisper 等） | `/v1/audio/transcriptions` |

### 1.2 数据库迁移

**目标表**：`llm_models`  
**操作**：
1. `context_window` 和 `max_output_tokens` 从 `NOT NULL` 改为 `nullable=True`。
2. 新增列 `model_type`（`TEXT`，默认 `"llm"`，非空）。

项目未使用 Alembic，迁移放在 `backend/app/main.py` 的 `_migrate` 函数中。

SQLite **不支持** `ALTER TABLE ... ALTER COLUMN ... DROP NOT NULL`，必须**重建表**：

```python
def _migrate(sync_conn):
    from sqlalchemy import inspect, text
    inspector = inspect(sync_conn)
    model_cols = {c['name'] for c in inspector.get_columns('llm_models')}

    # ---- 1. llm_models 表重建（context_window / max_output_tokens 改为 nullable） ----
    ctx_col = next((c for c in inspector.get_columns('llm_models') if c['name'] == 'context_window'), None)
    if ctx_col and ctx_col.get('nullable') is False:
        # 临时关闭外键，避免 DROP TABLE 失败
        sync_conn.execute(text("PRAGMA foreign_keys = OFF"))
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
        sync_conn.execute(text("PRAGMA foreign_keys = ON"))
        logger.info("Migration: rebuilt llm_models (context_window/max_output_tokens now nullable, model_type added)")

    # ---- 2. 启动时批量推断已有模型类型 ----
    if 'model_type' in model_cols:
        result = sync_conn.execute(text(
            "SELECT id FROM llm_models WHERE model_type = 'llm'"
        )).fetchall()
        for (model_id,) in result:
            inferred = infer_model_type(model_id)
            if inferred != 'llm':
                sync_conn.execute(
                    text("UPDATE llm_models SET model_type = :mt WHERE id = :id"),
                    {"mt": inferred, "id": model_id}
                )
        logger.info("Migration: batch inferred model types for existing models")

    # ---- 3. 清理废弃 Setting ----
    sync_conn.execute(text(
        "DELETE FROM settings WHERE key IN ('embedding_model', 'image_gen', 'assistant_model')"
    ))
```

**向后兼容**：现有数据全部默认为 `llm`；表重建后旧数据完整保留；启动时自动对已存在模型运行 `infer_model_type` 修正类型。

### 1.3 providers.yaml Schema 变更

修改 `backend/app/core/provider_schema.py`：

```python
from typing import Optional

class ModelConfig(BaseModel):
    id: str
    display_name: str
    is_builtin: bool = Field(default=False)
    status: Literal["active", "inactive"] = Field(default="active")

    context_window: Optional[int] = Field(default=None)      # ← 改为可选
    max_output_tokens: Optional[int] = Field(default=None)   # ← 改为可选
    supports_multimodal: bool = Field(default=False)
    input_modalities: list[str] = Field(default_factory=lambda: ["text"])
    output_modalities: list[str] = Field(default_factory=lambda: ["text"])
    supports_streaming: bool = Field(default=True)
    supports_tool_calling: bool = Field(default=False)
    supports_reasoning: bool = Field(default=False)

    model_type: Literal["llm", "embedding", "image", "stt"] = Field(default="llm")
    pricing: Optional[PricingInfo] = Field(default=None)
```

YAML 中未声明 `model_type` 的模型在加载时自动回退为 `llm`。非 LLM 模型可省略 `context_window` 和 `max_output_tokens`。

### 1.4 SQLAlchemy 模型变更

修改 `backend/app/models/models.py`：

```python
class LLMModel(Base):
    __tablename__ = "llm_models"
    # ... 现有字段 ...
    context_window: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)
    max_output_tokens: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)
    model_type: Mapped[str] = mapped_column(String(16), default="llm", nullable=False)
```

### 1.5 API 变更

修改 `backend/app/api/models.py`：

```python
class ModelCreate(BaseModel):
    # ... 现有字段 ...
    model_type: Literal["llm", "embedding", "image", "stt"] = "llm"

class ModelUpdate(BaseModel):
    # ... 现有字段 ...
    model_type: Optional[Literal["llm", "embedding", "image", "stt"]] = None
```

`_model_to_dict` 返回字典中增加 `model_type`。

**列表查询支持过滤**：

```python
@router.get("", response_model=Resp)
async def list_models(
    provider_id: Optional[str] = None,
    model_type: Optional[str] = None,   # ← 新增
    user: User = Depends(require_user),
    db: AsyncSession = Depends(get_db),
):
    stmt = select(LLMModel).where(LLMModel.user_id == user.id)
    if provider_id:
        stmt = stmt.where(LLMModel.provider_id == provider_id)
    if model_type:
        stmt = stmt.where(LLMModel.model_type == model_type)
    # ...
```

### 1.6 Provider YAML 同步更新

修改 `backend/app/services/provider_migration.py`：

- `provider_to_yaml_dict`：序列化时加入 `model_type`；`context_window`/`max_output_tokens` 为 `None` 时序列化为 `null` 或直接省略。
- `_upsert_model`：读取/写入 `model_type` 字段；若 YAML 中缺失则默认 `llm`。`context_window`/`max_output_tokens` 读取时若 YAML 中为 `null` 则写入 `None`。
- 启动时 `_migrate` 中批量推断已有模型类型（见 1.2）。

---

## 2. 算力中枢 UI 重组（ComputeCenter）

### 2.1 当前问题
- 所有 Provider 混在一个网格里，每个卡片展示全部模型，无法一眼区分 Embedding 和图片生成模型。
- 同一个 Provider（如 SiliconFlow）可能同时提供 LLM 和 Embedding，但目前只能在一个卡片里展示。

### 2.2 新布局方案

按 **model_type** 分四大区域纵向排列：

```
┌─────────────────────────────────────┐
│  ← 算力中枢              + 添加平台  │
├─────────────────────────────────────┤
│  [今日消耗] [可用额度] [预估剩余]    │
├─────────────────────────────────────┤
│  🧠 对话模型                         │
│  ┌─────────────┐ ┌─────────────┐   │
│  │ Provider A  │ │ Provider B  │   │
│  │ [m1] [m2]   │ │ [m3]        │   │
│  └─────────────┘ └─────────────┘   │
├─────────────────────────────────────┤
│  🧬 Embedding 模型                   │
│  ┌─────────────┐                   │
│  │ Provider A  │ ← 同一个 Provider  │
│  │ [embed-1]   │   出现在不同区域   │
│  └─────────────┘                   │
├─────────────────────────────────────┤
│  🎨 图片生成模型                     │
│  ┌─────────────┐                   │
│  │ Provider C  │                   │
│  │ [dall-e-3]  │                   │
│  └─────────────┘                   │
├─────────────────────────────────────┤
│  🎙️ 语音识别模型                     │
│  ┌─────────────┐                   │
│  │ Provider D  │                   │
│  │ [whisper-1] │                   │
│  └─────────────┘                   │
│              或空状态提示            │
└─────────────────────────────────────┘
```

### 2.3 数据结构转换

前端在 `computeStore` 中增加一个 getter，将 `Provider[]` 转换为按类型分组的数据：

```typescript
interface ProviderGroup {
  type: 'llm' | 'embedding' | 'image' | 'stt'
  label: string
  icon: string
  providers: Provider[]  // 仅包含该类型模型的 Provider，models 已过滤
}

function groupByModelType(providers: Provider[]): ProviderGroup[] {
  const types = [
    { type: 'llm', label: '对话模型', icon: '🧠' },
    { type: 'embedding', label: 'Embedding 模型', icon: '🧬' },
    { type: 'image', label: '图片生成模型', icon: '🎨' },
    { type: 'stt', label: '语音识别模型', icon: '🎙️' },
  ]
  return types.map(t => {
    const filtered = providers
      .map(p => ({
        ...p,
        models: (p.models || []).filter(m => m.model_type === t.type)
      }))
      .filter(p => p.models.length > 0)
    return { ...t, providers: filtered }
  })
}
```

### 2.4 空状态处理

| 场景 | 展示方式 |
|---|---|
| 该区域有 Provider | 正常展示 Provider 卡片 |
| 该区域无 Provider，但其他区域有 | 显示折叠提示「暂无 X 模型，点击添加」或保持区域标题但展示空占位 |
| 没有任何 Provider | 保持现有的全局空状态 |

建议：空区域保留标题，下方显示一行小字 `暂无模型，可在任意 Provider 中添加`。

### 2.5 Provider 卡片管理

- **编辑/删除 Provider**：不受影响，点击卡片仍弹出编辑 Modal。
- **编辑/删除 Model**：在编辑 Modal 的模型列表中，增加一列「类型」展示 `model_type`；编辑模型时允许修改类型（下拉框）。
- **添加模型**：手动添加模型时，表单增加 `model_type` 下拉框（默认 `llm`）。

### 2.6 添加 Provider 流程

添加 Provider 时不需要选择类型（Provider 本身仍是统一的）。类型在添加/发现模型时确定。

---

## 3. ModelSelector 组件适配

### 3.1 API 变更

```vue
<ModelSelector
  v-model:provider-id="form.provider_id"
  v-model:model-id="form.model_id"
  :model-type="'llm'"        <!-- 新增 -->
/>
```

Props 签名：

```typescript
const props = withDefaults(defineProps<{
  providerId: string | null
  modelId: string | null
  modelType?: 'llm' | 'embedding' | 'image' | 'stt' | null   // ← 新增
  allowEmpty?: boolean
  emptyLabel?: string
}>(), {
  allowEmpty: false,
  emptyLabel: '未配置',
  modelType: null,   // null 表示不过滤（向后兼容）
})
```

### 3.2 过滤逻辑与 hint 展示

**过滤方案（前端过滤）**  
理由：模型数据量极小（通常 < 100），前端过滤足够，且无需改动后端列表 API。`ModelSelector` 直接从 `computeStore.providers` 过滤：

```typescript
const providers = computed(() => {
  if (!props.modelType) return store.providers
  return store.providers
    .map(p => ({
      ...p,
      models: (p.models || []).filter(m => m.model_type === props.modelType)
    }))
    .filter(p => p.models.length > 0)
})

const currentModels = computed(() => {
  if (!props.providerId) return []
  const prov = providers.value.find(p => p.id === props.providerId)
  return prov?.models || []
})
```

**非 LLM 模型的 hint 展示**：

```vue
<p class="hint" v-if="currentModel">
  <template v-if="currentModel.model_type === 'llm'">
    上下文窗口：{{ currentModel.context_window?.toLocaleString() ?? '-' }} tokens，
    最大输出：{{ currentModel.max_output_tokens?.toLocaleString() ?? '-' }} tokens
    <span v-if="currentModel.supports_reasoning" title="支持深度思考">🧠</span>
    <span v-if="currentModel.supports_tool_calling" title="支持工具调用">🔧</span>
    <span v-if="currentModel.supports_multimodal" title="支持图文输入">👁️</span>
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

**Provider 切换时的自动选择**：当 `providerId` 变化时，若当前 `modelId` 不在过滤后的列表中，自动选择第一个可用模型。

### 3.3 向后兼容

- 不传 `modelType` 时，行为与现在完全一致（显示所有模型）。
- 传了 `modelType` 但无可用模型时，Provider 下拉框显示为空，提示用户先去算力中枢添加对应类型模型。

---

## 4. AgentEdit / ComputeTab 适配

修改 `frontend/src/components/ComputeTab.vue`，为每个 `ModelSelector` 传入正确的 `model-type`：

| 用途 | 组件位置 | model-type 值 | 说明 |
|---|---|---|---|
| 主推理模型 | 第一个 ModelSelector | `llm` | 对话/推理 |
| Marker | useIndependentMarker 下 | `llm` | 标注用的对话模型 |
| Embedder | 嵌入模型区域 | `embedding` | 语义搜索 |
| Compressor | useIndependentCompressor 下 | `llm` | 压缩用的对话模型 |
| ImageGen | 图像生成区域 | `image` | 生图 |
| Fallback Chain | Fallback Modal 中 | `llm` | 降级链只考虑对话模型 |

示例修改：

```vue
<!-- 推理模型 -->
<ModelSelector
  :provider-id="providerId"
  :model-id="modelId"
  model-type="llm"
  @update:provider-id="$emit('update:providerId', $event)"
  @update:model-id="$emit('update:modelId', $event)"
/>

<!-- Embedder -->
<ModelSelector
  :provider-id="embedderProviderId"
  :model-id="embedderModelId"
  model-type="embedding"
  @update:provider-id="$emit('update:embedderProviderId', $event)"
  @update:model-id="$emit('update:embedderModelId', $event)"
/>
```

### 4.1 新建 Agent 的默认值

当前 `createNew` 中 `firstProv` / `firstModel` 取的是所有模型的第一个。适配后：

```typescript
const firstLlmProv = computeStore.providers.find(p =>
  p.models?.some(m => m.model_type === 'llm')
)
const firstLlmModel = firstLlmProv?.models?.find(m => m.model_type === 'llm')

const firstEmbedProv = computeStore.providers.find(p =>
  p.models?.some(m => m.model_type === 'embedding')
)
const firstEmbedModel = firstEmbedProv?.models?.find(m => m.model_type === 'embedding')
```

分别给主模型和 Embedder 赋合理的初始值，避免打开新建页面时 Embedder 默认选了一个对话模型。

---

## 5. 测试连接时的类型推断

### 5.1 当前行为

`POST /compute/providers/{id}/test` 调用 `/v1/models` 返回模型列表，但只返回 `model_ids` 字符串数组，没有类型信息。

### 5.2 推断方案（混合策略）

**Step 1：从 Provider base_url / 元数据推断（弱信号）**
- 若 Provider `provider_type` 为已知平台（如 `openai`、`siliconflow`），可查询其模型名称白名单表，匹配已知模型名称。
- 例如模型 ID 包含 `embedding`、`embed`、`text-embedding` → `embedding`。
- 例如模型 ID 包含 `dall-e`、`image`、`flux`、`sdxl` → `image`。
- 例如模型 ID 包含 `whisper`、`speech` → `stt`。

**Step 2：从 API Endpoint 能力推断（强信号）**
- 测试连接时，不仅调用 `/v1/models`，还尝试调用 `/v1/embeddings`（用一个 dummy input）来判断该模型是否支持 Embedding。
- 但注意：`/v1/models` 返回的是该 Provider 支持的所有模型，不是单个模型。无法对每个模型单独测试 endpoint。

**Step 3：用户确认（兜底）**

推荐实现：

```python
# backend/app/api/compute.py test_provider 返回增加 type_hints
# 注意：规则需覆盖常见命名，尤其是 ada-002 这种不含 "embed" 的 Embedding 模型
DISCOVERY_RULES = [
    (r"\b(ada-002|ada\b|text-embedding|embedding|embed|bge-|e5-|gte-|m3e-|m-e5|multilingual-e5|nv-embed)", "embedding"),
    (r"\b(dall-e|flux|sdxl|stable-diffusion|midjourney|wanx|cogview|kling|imagen|playground|recraft|ideogram)", "image"),
    (r"\b(whisper|sensevoice|sense|nova-|stt-|asr-|speech-to-text|speech)", "stt"),
]

def infer_model_type(model_id: str) -> str:
    lower = model_id.lower()
    for pattern, t in DISCOVERY_RULES:
        if re.search(pattern, lower):
            return t
    return "llm"  # 默认
```

**启动时批量推断已有模型**：在 `main.py` 的 `_migrate` 中，对已存在的 `llm_models` 批量运行 `infer_model_type()` 并更新数据库（见 1.2），避免已配置 `ada-002` 等模型的 Agent 在上线后 Embedder 配置断裂。

在「发现新模型」Modal 中，前端为每个模型增加 `model_type` 下拉框，默认按 `infer_model_type` 填充，允许用户手动修正：

```vue
<!-- Discover Modal 中每个模型项 -->
<div class="discover-fields">
  <div>
    <label>上下文窗口</label>
    <input v-model.number="m.context_window" type="number" />
  </div>
  <div>
    <label>最大输出</label>
    <input v-model.number="m.max_output_tokens" type="number" />
  </div>
  <div>
    <label>模型类型</label>
    <select v-model="m.model_type">
      <option value="llm">对话模型</option>
      <option value="embedding">Embedding</option>
      <option value="image">图片生成</option>
      <option value="stt">语音识别</option>
    </select>
  </div>
</div>
```

导入时一并提交 `model_type`。

### 5.3 评估

| 方案 | 优点 | 缺点 |
|---|---|---|
| 纯自动推断 | 用户无感知 | 模型命名不规范时容易错 |
| 自动推断 + 用户确认 | 准确率最高，一次配置长期使用 | 多一步操作 |
| 纯手动 | 最准确 | 体验差 |

**结论**：采用「自动推断 + 用户确认」方案。自动推断规则作为默认值，用户在发现模型 Modal 中可批量修改后导入。

---

## 6. 改动文件清单

### 后端

| 文件 | 改动内容 |
|---|---|
| `backend/app/models/models.py` | `LLMModel` 新增 `model_type` 字段；`context_window`/`max_output_tokens` 改为 `nullable=True` |
| `backend/app/core/provider_schema.py` | `ModelConfig` 新增 `model_type` 字段；`context_window`/`max_output_tokens` 改为 `Optional[int]` |
| `backend/app/api/models.py` | `ModelCreate`/`ModelUpdate` 新增 `model_type` 字段，`context_window`/`max_output_tokens` 改为 `Optional[int]`；`list_models` 支持 `model_type` 过滤；`_model_to_dict` 返回新增字段 |
| `backend/app/api/compute.py` | `list_providers` 返回模型时带上 `model_type`；`test_provider` 返回模型增加 `type_hint`；`infer_model_type` 规则函数 |
| `backend/app/services/provider_migration.py` | `_upsert_model`、`provider_to_yaml_dict` 处理 `model_type` 和 nullable 字段 |
| `backend/app/services/provider_resolver.py` | `ResolvedModel` 的 `context_window`/`max_output_tokens` 改为 `Optional[int]`；`resolve_model_attributes()` 读取 NULL 时回退默认值（`32000`/`4096`） |
| `backend/engine/memory/topic_compression/marker.py` | `TopicMarker.from_agent` 中 `attrs.context_window / 2000` 加防护：`(attrs.context_window or 64000) / 2000` |
| `backend/app/main.py` | `_migrate` 函数重建 `llm_models` 表（nullable + model_type）；批量推断已有模型类型；清理废弃 Setting |

### 前端

| 文件 | 改动内容 |
|---|---|
| `frontend/src/stores/compute.ts` | `ModelInfo` 接口新增 `model_type`；`context_window`/`max_output_tokens` 改为 `number \| null`；增加 `groupByModelType` 辅助函数 |
| `frontend/src/components/ModelSelector.vue` | 新增 `modelType` prop；Provider/Model 列表按类型过滤；hint 根据 `model_type` 条件渲染；无可用模型时展示提示 |
| `frontend/src/components/ComputeCenter.vue` | 网格布局改为按类型分区域；Provider 卡片展示按类型过滤后的模型；添加/编辑模型时增加类型选择且非 LLM 隐藏 context/max 字段；发现模型 Modal 增加类型下拉框；`importDiscovered()` 导入时提交 `model_type` |
| `frontend/src/components/ComputeTab.vue` | 各 `ModelSelector` 传入对应 `model-type`；Fallback Modal 的 ModelSelector 传 `model-type="llm"` |
| `frontend/src/components/AgentEdit.vue` | `createNew` 中主模型和 Embedder 分别取对应类型的第一个可用模型 |

---

## 7. 向后兼容策略

1. **数据库**：新增列带 `DEFAULT 'llm'`，现有数据自动归类为对话模型，不影响任何已有功能。
2. **YAML**：Pydantic 模型使用 `default="llm"`，旧 YAML 无此字段也能正常加载。
3. **API**：`model_type` 参数均为可选，不传时不过滤 / 使用默认值。
4. **前端**：`ModelSelector.modelType` 默认为 `null`，不传时行为完全不变；算力中枢全局无模型类型时展示与现在一致。
5. **Agent 配置**：已保存的 Agent 其 `provider_id` + `model_id` 指向的模型在数据库中已自动设为 `llm`，**但启动时的批量推断脚本会自动修正已有模型的类型**（如 `ada-002` → `embedding`），避免 AgentEdit 中 ModelSelector 过滤后找不到对应类型模型。
6. **降级链**：现有 Fallback Chain 中的模型全部默认为 `llm`，与当前语义一致（降级链仅用于对话模型切换）。
7. **Setting 表清理**：启动迁移脚本会删除 Setting 表中废弃的 `embedding_model`/`image_gen`/`assistant_model` 记录，避免数据脏乱。

---

## 8. 实施顺序建议

1. **后端 Schema + 迁移**：
   - `provider_schema.py`（`model_type` + nullable `context_window`/`max_output_tokens`）
   - `models.py`（SQLAlchemy 模型同步）
   - `main.py`（`_migrate` 重建 `llm_models` 表 + 批量推断已有模型类型 + 清理废弃 Setting）
2. **后端核心服务**：
   - `provider_migration.py`（YAML 同步 `model_type` + nullable 处理）
   - `provider_resolver.py`（`ResolvedModel` 改为 `Optional[int]` + NULL 回退默认值）
   - `api/models.py`（API Schema + `_model_to_dict`）
   - `api/compute.py`（返回 `model_type` + `test_provider` 推断）
3. **前端基础**：
   - `stores/compute.ts`（类型定义：`model_type` + `context_window`/`max_output_tokens` 改为 `number \| null`；`groupByModelType`）
4. **前端组件**：
   - `ModelSelector.vue`（新增 `modelType` prop + hint 条件渲染）
   - `ComputeCenter.vue`（分区域布局 + 模型表单动态显示 + 发现模型 Modal 类型选择 + 导入传 `model_type`）
   - `ComputeTab.vue`（传入 `model-type`）
   - `AgentEdit.vue`（`createNew` 按类型取默认值）
5. **Engine 防御性修改**：
   - `marker.py`（`context_window or 64000` 保护）
