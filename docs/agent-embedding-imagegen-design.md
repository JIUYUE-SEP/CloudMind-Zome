# Agent 级 Embedding 与生图模型独立配置 — 设计方案

> 状态：设计完成，待指挥官确认后实施  
> 版本：v1.0  
> 日期：2026-06-10

---

## 1. 背景与目标

### 1.1 现状

当前 Embedding 模型和生图模型采用**全局单例**模式：

- **存储**：Setting 表 `key="embedding_model"` / `key="image_gen"`
- **初始化**：`main.py` 启动时一次性构建 `Embedder` 实例，注入 `set_image_gen_config()`
- **共享**：所有 Agent 共用同一套 Embedding 和生图配置

### 1.2 问题

1. **无法差异化**：不同 Agent 需要不同向量维度（OpenAI 1536 vs BGE 1024）或不同生图平台时，全局配置无法满足。
2. **维度冲突**：全局 `AgentMemoryStore`（zvec）是单 collection，维度固定。切换 Embedding 模型会导致维度不匹配报错。
3. **配置链路断裂**：全局配置保存后需重启后端才能生效，用户体验差。
4. **SystemSettingsPanel 幽灵配置**：上一批次已清理 Image Tab 和废弃字段，但全局配置机制本身仍在，治标不治本。

### 1.3 目标

- 将 Embedding 模型和生图模型改为**每个 Agent（心智）强制独立配置**。
- 移除全局 Setting 表配置和 ComputeCenter 全局卡片。
- `AgentMemoryStore` 改为 **per-agent collection**，支持不同维度。
- 运行期 Agent 启动时动态构建，无需重启后端。

---

## 2. Agent 级配置字段

### 2.1 数据库模型（`backend/app/models/agents.py`）

| 字段 | 状态 | 类型 | 说明 |
|------|------|------|------|
| `embedder_provider_id` | **已存在** | `String(64)`, FK → `compute_providers.id`, nullable | 语义搜索向量模型的 Provider |
| `embedder_model_id` | **已存在** | `String(64)`, nullable | 向量模型的 model ID |
| `imagegen_provider_id` | **新增** | `String(64)`, FK → `compute_providers.id`, nullable | 生图模型的 Provider |
| `imagegen_model_id` | **新增** | `String(64)`, nullable | 生图模型的 model ID |

**设计决策**：
- 数据库层面保持 `nullable=True`，避免阻塞旧数据。
- 前端 UI 层面强制校验必填，新建 Agent 时自动填充默认值（主模型的 Provider + 第一个 Model）。
- 旧 Agent 如字段为空，Embedder 降级为 `None`（语义搜索禁用），生图工具返回配置缺失错误。

### 2.2 数据库迁移

在 `backend/app/main.py` 的 lightweight migration 中新增两列：

```python
agent_new_cols = [
    ("imagegen_provider_id", "TEXT"),
    ("imagegen_model_id", "TEXT"),
]
for col_name, col_def in agent_new_cols:
    if col_name not in agent_cols:
        sync_conn.execute(text(f"ALTER TABLE agents ADD COLUMN {col_name} {col_def}"))
```

SQLite 原生支持 `ALTER TABLE ADD COLUMN`，无需重量级迁移脚本。

---

## 3. 全局配置移除

### 3.1 Setting 表

| 项 | 处理 |
|----|------|
| `key="embedding_model"` | **保留数据但不再读取**。后续可一次性清理，本批次不动。 |
| `key="image_gen"` | **同上**。 |

### 3.2 `main.py` 启动逻辑

**当前**：
```python
# lifespan startup
embedder = Embedder(base_url="", api_key="", model="")
# ... 查 Setting 表 → 查 ComputeProvider → 构建 Embedder
_app_state["embedder"] = embedder
# ... 查 Setting 表 → 调用 set_image_gen_config()
```

**改为**：
```python
# 不再从 Setting 表读取 Embedding / ImageGen
# embedder 改为 Agent 级动态构建，不在启动期初始化
# _app_state["embedder"] 可移除或保留空实例兼容旧代码
memory_store = AgentMemoryStore()   # 仍需全局单例，但内部 per-agent
_app_state["memory_store"] = memory_store
```

### 3.3 ComputeCenter.vue

- **移除** `cc-global-settings` 区域的「🧬 嵌入模型」和「🎨 图像生成模型」两张卡片。
- **移除** 相关响应式数据：`embeddingSetting`、`imageGenSetting`、`savingEmbedding`、`savingImageGen`、`embeddingModels`、`imageGenModels` 及 `loadGlobalSettings()` / `saveEmbedding()` / `saveImageGen()`。
- ComputeCenter 回归纯粹的「Provider / 模型管理 + Token 统计」职责。

### 3.4 `/compute/embedding-model` & `/compute/image-gen` API

- 短期保留（兼容旧前端缓存），但返回空值：
  ```json
  { "code": 0, "data": { "provider_id": null, "model": null } }
  ```
- 下一批次彻底删除 `compute.py` 中的这两个 endpoint。

---

## 4. Agent 启动时的初始化（`AgentWorker.start()`）

### 4.1 Embedder — Agent 级动态构建

在 `AgentWorker.start()` 中，从 `agent_row` 的 embedder 字段实时构建：

```python
from engine.context.embedder import Embedder
from app.services.provider_resolver import resolve_provider_credentials

embedder = None
if self.agent_row.embedder_provider_id and self.agent_row.embedder_model_id:
    async with AsyncSessionLocal() as db:
        creds = await resolve_provider_credentials(
            db,
            self.agent_row.embedder_provider_id,
            self.agent_row.embedder_model_id,
        )
    if creds and creds.base_url and creds.api_key:
        embedder = Embedder(
            base_url=creds.base_url,
            api_key=creds.api_key,
            model=self.agent_row.embedder_model_id,
        )
        logger.info("Agent %s embedder ready (%s)", self.agent_id, self.agent_row.embedder_model_id)
    else:
        logger.warning("Agent %s embedder credentials incomplete", self.agent_id)
else:
    logger.info("Agent %s has no embedder configured; semantic search disabled", self.agent_id)
```

将 `embedder` 直接传入 `ReActAgent(...)`：
```python
self._react_agent = ReActAgent(
    # ...
    embedder=embedder,          # 替代 _state.get("embedder")
    memory_store=_state.get("memory_store"),
    # ...
)
```

### 4.2 ImageGen — Agent 级注入

`generate_image` 工具当前依赖全局 `_image_gen_cfg`（通过 `set_image_gen_config()` 注入）。需改为按 Agent ID 隔离。

#### 新增模块：`backend/engine/tools/web/image_gen_context.py`

```python
"""Agent-scoped image generation configuration."""

from __future__ import annotations

_agent_image_gen_cfg: dict[str, dict] = {}


def set_image_gen_config_for_agent(agent_id: str, cfg: dict) -> None:
    """Inject image_gen config for a specific agent (called by AgentWorker)."""
    _agent_image_gen_cfg[agent_id] = dict(cfg)


def get_image_gen_config_for_agent(agent_id: str | None) -> dict | None:
    """Return the agent-scoped image_gen config, or None if not set."""
    if not agent_id:
        return None
    return _agent_image_gen_cfg.get(agent_id)


def remove_image_gen_config_for_agent(agent_id: str) -> None:
    """Clean up when AgentWorker stops."""
    _agent_image_gen_cfg.pop(agent_id, None)
```

#### `AgentWorker.start()` 中注入

```python
if self.agent_row.imagegen_provider_id and self.agent_row.imagegen_model_id:
    async with AsyncSessionLocal() as db:
        creds = await resolve_provider_credentials(
            db,
            self.agent_row.imagegen_provider_id,
            self.agent_row.imagegen_model_id,
        )
    if creds and creds.base_url and creds.api_key:
        from engine.tools.web.image_gen_context import set_image_gen_config_for_agent
        set_image_gen_config_for_agent(self.agent_id, {
            "base_url": creds.base_url,
            "model": self.agent_row.imagegen_model_id,
            "api_key": creds.api_key,
        })
        logger.info("Agent %s image-gen ready (%s)", self.agent_id, self.agent_row.imagegen_model_id)
```

#### `AgentWorker.stop()` 中清理

```python
def stop(self) -> None:
    self._running = False
    if self._current_job:
        self._current_job.stop_event.set()
    # Clean up agent-scoped image gen config
    from engine.tools.web.image_gen_context import remove_image_gen_config_for_agent
    remove_image_gen_config_for_agent(self.agent_id)
```

#### `generate_image.py` 中读取（零侵入）

工具注册和执行链路完全不变，仅在函数内部改读取顺序：

```python
from ...tools.comms.context import get_current_agent_id
from .image_gen_context import get_image_gen_config_for_agent

def _get_image_config() -> dict:
    """Return agent-scoped config first, then legacy global fallback."""
    agent_id = get_current_agent_id()
    cfg = get_image_gen_config_for_agent(agent_id)
    if cfg:
        return cfg
    return _image_gen_cfg          # 兼容旧全局配置（实际已废弃）
```

**优点**：无需修改 tool schema、无需修改 `tool_registry.execute()` 签名、对 ReActAgent 完全透明。

---

## 5. AgentMemoryStore 改为 Per-Agent Collection

### 5.1 问题

不同 Embedding 模型维度不同（例如 OpenAI `text-embedding-3-small` 为 1536，BGE-M3 为 1024）。当前 `AgentMemoryStore` 是全局单 collection，维度在首次 `add()` 时固定，后续切换模型会导致维度不匹配报错。

### 5.2 方案

将 `AgentMemoryStore` 内部改为按 `agent_id` 分 collection。每个 Agent 拥有独立的 `agent_memory_{agent_id}` 和 `agent_topics_{agent_id}` collection。

```python
class AgentMemoryStore:
    def __init__(self):
        _ZVEC_DIR.mkdir(parents=True, exist_ok=True)
        self._colls: dict[str, zvec.Collection] = {}        # agent_id -> memory coll
        self._topic_colls: dict[str, zvec.Collection] = {}  # agent_id -> topics coll
        self._dims: dict[str, int] = {}                     # agent_id -> dim

    def _ensure_collection(self, agent_id: str, dim: int | None = None) -> zvec.Collection:
        if agent_id in self._colls:
            return self._colls[agent_id]
        path = _ZVEC_DIR / f"agent_memory_{agent_id}"
        # open or create...
        self._colls[agent_id] = coll
        self._dims[agent_id] = dim
        return coll

    def _ensure_topics_collection(self, agent_id: str, dim: int | None = None) -> zvec.Collection:
        # 同上，path = _ZVEC_DIR / f"agent_topics_{agent_id}"
        # ...
```

所有 `add()` / `search()` / `delete_by_filter()` / `add_topic()` / `search_topics()` 等方法通过 `agent_id` 定位 collection。

### 5.3 旧数据迁移

当前全局 collection 路径：
- `_ZVEC_DIR / "agent_memory"`
- `_ZVEC_DIR / "agent_topics"`

**决策**：直接弃用旧 collection。启动新架构后，旧记忆不可见，Agent 需通过新对话重建向量记忆。

理由：
1. 开发/测试阶段，语义记忆可重新生成。
2. 旧 collection 维度固定，无法安全迁移到多维度架构。
3. 如需保留，可通过 agent_id 白名单手动重命名，但 ROI 低。

---

## 6. 前端 UI 改造

### 6.1 ComputeTab.vue（Agent 编辑页算力配置 Tab）

**当前**：
- Embedder：checkbox「使用独立嵌入模型」→ 可选 ModelSelector
- ImageGen：无配置
- Compressor：checkbox「使用独立压缩模型」→ 可选 ModelSelector

**改为**：
- **推理模型（主模型）**：保持 ModelSelector（必填）。
- **Embedder（语义搜索）**：**移除 checkbox，改为必填 ModelSelector**，紧跟在主模型下方。
- **ImageGen（AI 生图）**：**新增必填 ModelSelector**，紧跟在 Embedder 下方。
- **Compressor**：本批次暂不动（保持 checkbox 可选），后续批次统一处理。

**字段 hint**：
```
Embedder:  "语义记忆搜索使用的向量模型。不同 Agent 可独立配置，支持 OpenAI /v1/embeddings 兼容格式。"
ImageGen:  "AI 生图工具调用的模型，支持 OpenAI DALL-E 格式或 DashScope 格式。"
```

**Props 变更**：
```typescript
// 移除
useIndependentEmbedder: boolean
// useIndependentCompressor: boolean   // 保留，暂不改动

// 保留/新增（均为必填）
embedderProviderId: string | null
embedderModelId: string | null
imagegenProviderId: string | null
imagegenModelId: string | null
```

### 6.2 AgentEdit.vue

- `form` 对象新增字段：`imagegen_provider_id`、`imagegen_model_id`。
- `createNew()` 时：
  - `embedder_provider_id` / `embedder_model_id` 默认填充为第一个 Provider 的第一个 Model。
  - `imagegen_provider_id` / `imagegen_model_id` 同样默认填充。
  - 移除 `useIndependentEmbedder`、`useIndependentCompressor` 的初始值。
- `selectAgent()` 时：
  - 读取后端返回的 `imagegen_provider_id` / `imagegen_model_id`。
  - 如果旧 Agent 无此字段（null），自动 fallback 到主模型的 Provider + Model（或弹提示要求配置）。
- `save()` 时：
  - 始终发送 `embedder_provider_id`、`embedder_model_id`、`imagegen_provider_id`、`imagegen_model_id`。
  - 不再受 checkbox 条件限制。
  - `llm_config` 中的 `embedder` 字段仍保留写入（兼容旧版 AgentWorker 读取逻辑，直到后端完全弃用 `model_config`）。

### 6.3 ComputeCenter.vue

- 移除 `cc-global-settings` 区域的「🧬 嵌入模型」和「🎨 图像生成模型」两张全局配置卡片。
- 移除所有相关 data / computed / methods（见第 3.3 节）。
- ComputeCenter 回归 Provider 管理 + Token 统计的单一职责。

---

## 7. 向后兼容方案

### 7.1 现有 Agent（字段为空）

| 字段状态 | 行为 |
|---------|------|
| `embedder_provider_id` 为空 | `AgentWorker` 启动时 `embedder=None`。`ReActAgent` 语义记忆搜索自动降级为禁用。Agent 仍可正常对话，只是无长期语义检索。 |
| `imagegen_provider_id` 为空 | `generate_image` 工具调用时，Agent 级配置缺失 → fallback 到全局 `_get_image_config()`（当前全局可能已空）→ 返回 `"Error: image generation not configured"`。 |

**平滑过渡**：AgentEdit 打开旧 Agent 时，若 ImageGen 字段为空，自动将主模型 Provider + Model 填入（与新建 Agent 默认值一致）。用户保存一次后即完成迁移。

### 7.2 Setting 表全局配置

- 不再读取，但保留数据，不做自动迁移（无法推断归属 Agent）。
- 用户只需在 AgentEdit 中重新配置一次。

### 7.3 `config.yaml` 中的 `image_gen`

- 上一批次已在 `config.py` 中拒绝写入 `image_gen`。
- 本批次后端不再读取。
- 后续批次从 `AppConfig` pydantic 模型中移除该字段。

### 7.4 zvec 旧 collection

- 旧全局 collection 直接弃用，不自动迁移。
- 首次新架构运行后，旧记忆不再可见，需重新对话重建。

---

## 8. 改动文件清单

| # | 文件 | 改动内容 | 优先级 |
|---|------|---------|--------|
| 1 | `backend/app/models/agents.py` | 新增 `imagegen_provider_id`、`imagegen_model_id` 字段 | P0 |
| 2 | `backend/app/main.py` | 移除全局 Embedder/ImageGen 初始化；lightweight migration 加列 | P0 |
| 3 | `backend/app/api/agents.py` | `AgentCreate` / `AgentUpdate` / `get_agent` / `create_agent` / `update_agent` 新增字段 | P0 |
| 4 | `backend/app/services/agent_worker.py` | Agent 级 Embedder 构建；ImageGen 配置注入与清理 | P0 |
| 5 | `backend/engine/context/vector_store.py` | 改为 per-agent collection（`_colls` / `_topic_colls` dict） | P0 |
| 6 | `backend/engine/tools/web/image_gen_context.py` | **新建**：Agent 级 image gen 配置上下文 | P0 |
| 7 | `backend/engine/tools/web/generate_image.py` | 优先读取 Agent 级配置（通过 `get_current_agent_id()`） | P0 |
| 8 | `frontend/src/components/ComputeTab.vue` | Embedder 必填（去 checkbox）；新增 ImageGen ModelSelector | P0 |
| 9 | `frontend/src/components/AgentEdit.vue` | form / save / createNew / selectAgent 新增 ImageGen 字段 | P0 |
| 10 | `frontend/src/components/ComputeCenter.vue` | 移除全局 Embedding / ImageGen 配置卡片 | P1 |
| 11 | `backend/app/api/compute.py` | `/embedding-model`、`/image-gen` 返回空值（废弃过渡） | P1 |
| 12 | `backend/engine/config/models.py` | 移除 `AppConfig.image_gen` 字段 | P2 |

---

## 9. 验证清单

### 9.1 功能验证

- [ ] 新建 Agent 时，Embedder 和 ImageGen 自动填充默认值（主模型 Provider 的第一个 Model）。
- [ ] AgentEdit 保存后，后端 `AgentWorker.start()` 能正确构建 Agent 级 Embedder。
- [ ] 不同 Agent 配置不同维度 Embedding 模型时，zvec 不报错（per-agent collection 隔离）。
- [ ] Agent A 调用 `generate_image` 走 Agent A 的 Provider；Agent B 走 Agent B 的 Provider。
- [ ] ComputeCenter 不再显示全局 Embedding / ImageGen 卡片。
- [ ] 旧 Agent `embedder_provider_id` 为空时仍可对话，只是语义检索禁用。

### 9.2 回归验证

- [ ] 主模型（推理模型）配置不受影响。
- [ ] Marker 模型独立配置不受影响。
- [ ] Fallback Chain 不受影响。
- [ ] Tavily 搜索配置不受影响。
- [ ] SystemSettingsPanel 的 Image Tab 已在上批次移除，无残留。

---

## 10. 风险与回退

| 风险 | 影响 | 缓解措施 |
|------|------|---------|
| zvec per-agent collection 导致磁盘占用增长 | 中 | 每个 Agent 独立 collection 会多占索引空间；桌面场景 Agent 数量通常 < 20，可接受。 |
| 旧 Agent 语义记忆丢失 | 中 | 旧全局 collection 弃用，记忆需重建。开发阶段可接受；生产环境需提前备份 zvec 目录。 |
| AgentWorker 启动时多次查 DB | 低 | `resolve_provider_credentials` 每次启动查一次 DB，开销极小。 |
| `get_current_agent_id()` 未设置导致 ImageGen fallback 错误 | 低 | 工具执行前 `_execute_tool` 已调用 `set_current_agent_id()`，保证上下文正确。 |

**回退方案**：若实施后发现严重问题，可快速回退到全局 Embedder + 全局 ImageGen：
1. `AgentWorker.start()` 改回从 `_app_state["embedder"]` 读取。
2. `generate_image.py` 改回只读 `_image_gen_cfg`。
3. 前端 ComputeCenter 恢复全局卡片。

---

## 11. 时序建议

建议按以下顺序实施：

1. **后端数据库 + API**：新增字段 → migration → Agent API 支持新字段。
2. **后端引擎**：`image_gen_context.py` → `generate_image.py` → `AgentMemoryStore` per-agent → `AgentWorker` 动态构建。
3. **前端**：`ComputeTab.vue` → `AgentEdit.vue` → `ComputeCenter.vue` 移除全局卡片。
4. **验证**：新建 Agent → 不同 Agent 不同配置 → 生图工具隔离性验证。
5. **清理**：废弃 `/compute/embedding-model` 和 `/compute/image-gen` API；清理 `AppConfig.image_gen`。
