# CloudMind-Zome 配置体系全面审查报告

> **项目**：CloudMind-Zome  
> **日期**：2026-06-09  
> **范围**：配置存储体系、加密体系、代码重复、配置冲突  
> **状态**：只审查，不改代码，等待指挥官确认

---

## 目录

1. [配置存储地图](#1-配置存储地图)
2. [config.yaml 完整清单](#2-configyaml-完整清单)
3. [加密体系现状](#3-加密体系现状)
4. [代码重复清单](#4-代码重复清单)
5. [配置冲突/不一致问题](#5-配置冲突不一致问题)
6. [整合建议](#6-整合建议)

---

## 1. 配置存储地图

### 1.1 全局视图：配置项 → 存储位置 → 读取方 → 写入方

| 配置项 | 存储位置 | 读取方 | 写入方 | 状态 |
|--------|----------|--------|--------|------|
| **Provider 网络配置** (base_url, api_key) | `ComputeProvider` 表 | AgentWorker, EngineBridge, Embedding init, ImageGen init | `POST/PUT /api/v1/compute/providers` | ✅ 新体系，已迁移 |
| **Provider 模型列表** | `ComputeProvider.config.models` (JSON) | AgentEdit.vue | `POST /api/v1/compute/providers/{id}/test` 自动发现 | ⚠️ 临时方案，待拆出独立 Model 表 |
| **Agent LLM 配置** (provider_id, model) | `Agent.model_config` (JSON) | AgentWorker, EngineBridge, Marker, Extractor | `AgentEdit.vue` → `PUT /api/v1/agents/{id}` | ⚠️ JSON 自由字段，无约束 |
| **Agent 人格** | `Agent.model_config.personality` (JSON) | ReActAgent (group chat) | `AgentEdit.vue` 自动分析后写入 | ⚠️ 混在 model_config 中 |
| **Agent Marker 配置** | `Agent.model_config.marker` (JSON) | TopicMarker, PersonalityExtractor | `AgentEdit.vue` | ⚠️ 混在 model_config 中 |
| **Agent Embedder 配置** | `Agent.model_config.embedder` (JSON) | （预留，未直接调用） | `AgentEdit.vue` | ⚠️ 混在 model_config 中 |
| **Agent Compressor 配置** | `Agent.model_config.compressor` (JSON) | （预留，未直接调用） | `AgentEdit.vue` | ⚠️ 混在 model_config 中 |
| **Agent Fallback 链** | `Agent.model_config.fallback_chain` (JSON) | ReActAgent, AgentWorker | `AgentEdit.vue` | ⚠️ 混在 model_config 中 |
| **全局 Tavily API Key** | `config.yaml` → `tavily.api_key` | `search_web` tool | `SystemSettingsPanel.vue` → `PUT /config` | ⚠️ 旧体系 |
| **全局 Tavily API Key** | 环境变量 `TAVILY_API_KEY` | `search_web` tool | 用户手动设置 | ✅ 备用 |
| **全局 ImageGen 配置** | `config.yaml` → `image_gen` | `generate_image` tool | `SystemSettingsPanel.vue` → `PUT /config` | ⚠️ 旧体系，与 Setting 表重复 |
| **全局 ImageGen 配置** | `Setting` 表 (`key="image_gen"`) | `app/main.py` 启动时注入 | `AgentEdit.vue` / `SystemSettingsPanel.vue` | ⚠️ 新体系，但与 config.yaml 重复 |
| **全局 Embedding 配置** | `Setting` 表 (`key="embedding_model"`) | `app/main.py` 启动时构建 Embedder | `Compute API` → `PUT /embedding-model` | ✅ 新体系 |
| **全局 Assistant 模型** | `config.yaml` → `assistant_model` | （未看到直接调用） | `SystemSettingsPanel.vue` | ❓ 疑似死配置 |
| **记忆系统配置** (compact_threshold, keep_recent 等) | `config.yaml` → `context.*` | ContextPipeline, SmartStop | `SystemSettingsPanel.vue` → `PUT /config` | ⚠️ 旧体系 |
| **Agent 核心配置** (max_turns, smart_stop, memory_system) | `config.yaml` → `agent.*` | ReActAgent, SmartStop | `config.yaml` 手动编辑 | ⚠️ 旧体系 |
| **工具配置** (toolsets, max_result_chars, timeout) | `config.yaml` → `tools.*` | ToolRegistry, ReActAgent | `SystemSettingsPanel.vue` → `PUT /config` | ⚠️ 旧体系 |
| **SystemSettingsPanel 的 Provider 配置** | `config.yaml` → `provider.*` | **无人读取** | `SystemSettingsPanel.vue` → `PUT /config` | 🔴 **严重 Bug：写了但后端不接收** |
| **SystemSettingsPanel 的 Embedding 配置** | `config.yaml` → `embedding_model.*` | **无人读取** | `SystemSettingsPanel.vue` → `PUT /config` | 🔴 **严重 Bug：写了但后端不接收** |
| **SystemSettingsPanel 的 Assistant 配置** | `config.yaml` → `assistant_model.*` | **无人读取** | `SystemSettingsPanel.vue` → `PUT /config` | 🔴 **严重 Bug：写了但后端不接收** |

### 1.2 数据库配置存储详单

#### ComputeProvider 表（`backend/app/models/compute.py`）

```python
id: str (PK, uuid)
user_id: str (FK → users.id)
provider_type: str       # e.g. "deepseek", "openai"
display_name: str        # e.g. "DeepSeek 官方"
api_key_encrypted: str   # ⚠️ 实际上是 base64 编码
config: JSON             # {base_url, models: [...]}
quota_total: int
quota_used: int
quota_remaining: int
expires_at: datetime
status: str              # active / inactive
last_sync_at: datetime
created_at: datetime
updated_at: datetime
```

#### Setting 表（`backend/app/models/settings.py`）

```python
id: str (PK, uuid)
user_id: str (FK → users.id)
key: str                 # "embedding_model", "image_gen"
value: JSON              # {provider_id, model}
created_at: datetime
updated_at: datetime
```

当前 Setting 表中的 key：
- `"embedding_model"` → 全局 Embedding 模型配置
- `"image_gen"` → 全局图片生成模型配置

#### Agent 表的 JSON 字段（`backend/app/models/agents.py`）

```python
model_config: JSON       # LLM 配置万能桶
allowed_paths: JSON      # 文件访问白名单
toolsets: JSON           # 启用的工具集
enabled_skills: JSON     # 启用的技能
capabilities: JSON       # 能力标签
aliases: JSON            # 代称/昵称
tags: JSON               # 分组标签
```

`model_config` 当前包含的所有 key（通过代码扫描）：

| Key | 类型 | 说明 | 消费方 |
|-----|------|------|--------|
| `provider` | str | Provider name (如 "deepseek") | AgentWorker, EngineBridge, ReActAgent, Marker, Extractor |
| `provider_id` | str | Provider UUID | AgentWorker, EngineBridge, AgentEdit.vue |
| `model` | str | Model name (如 "deepseek-v4-pro") | AgentWorker, EngineBridge, ReActAgent, Marker, Extractor |
| `api_key` | str | API Key（明文或从 Provider 解密） | Marker, Extractor（运行时注入） |
| `base_url` | str | Base URL（运行时注入） | Marker, Extractor |
| `marker` | dict | `{provider_id, provider, model, api_key, base_url}` | TopicMarker, PersonalityExtractor |
| `embedder` | dict | `{provider_id, provider, model}` | （预留） |
| `compressor` | dict | `{provider_id, provider, model}` | （预留） |
| `fallback_chain` | list[dict] | `[{provider_id, provider, model}]` | AgentWorker, ReActAgent |
| `personality` | dict | `{extraversion, talkativeness, ...}` | ReActAgent (group chat) |
| `context_window` | int | 上下文窗口大小 | topic_memory.py |
| `max_tokens` | int | 最大输出 token | topic_memory.py (fallback) |
| `memory_file_path` | str | 自定义记忆文件路径 | ReActAgent |

### 1.3 config.yaml 读取链路

```
backend/engine/config.yaml
  ├─→ engine/config/loader.py::load_config()  ──→ AppConfig pydantic 对象
  │     ├─→ app/main.py ( lifespan ) ──→ app.state.config = cfg
  │     │     └─→ _app_state["config"] = cfg
  │     │           ├─→ app/services/agent_worker.py ──→ ReActAgent(config=app_config)
  │     │           ├─→ app/api/ws_protocol.py ──→ _engine_state()
  │     │           ├─→ app/services/conductor_service.py ──→ _engine_state()
  │     │           └─→ app/services/workflow_engine.py ──→ _engine_state()
  │     ├─→ app/services/engine_bridge.py ──→ load_config(_cfg_path) （独立加载）
  │     ├─→ engine/tools/web/search.py ──→ load_config(cfg_path) （独立加载）
  │     └─→ tests/test_e2e.py
  └─→ app/api/config.py ──→ _load_raw() / _save_raw() （REST API 直接读写 YAML）
```

---

## 2. config.yaml 完整清单

### 2.1 当前 config.yaml 内容（`backend/engine/config.yaml`）

```yaml
_version: 1
tavily:
  api_key: YOUR_TAVILY_API_KEY_HERE
agent:
  max_turns: 50
  identity: agent.identity.yaml
  smart_stop:
    max_turns: 50
    max_tokens: 200000
    timeout_seconds: 600
    no_progress_rounds: 3
    loop_detect_rounds: 2
  tracing:
    enabled: false
    endpoint: http://localhost:4318/v1/traces
context:
  compact_threshold: 0.8
  keep_recent: 3
  hot_memory_limit: 10
  warm_memory_limit: 20
tools:
  toolsets:
  - web
  - file
  - code
  max_result_chars: 12000
  safe_to_parallel_default: true
  default_timeout: 60
```

### 2.2 配置项迁移状态表

| 配置项 | config.yaml 路径 | 数据库对应 | 迁移状态 | 说明 |
|--------|------------------|------------|----------|------|
| Tavily API Key | `tavily.api_key` | ❌ 无 | 🔴 未迁移 | 仅存在于 yaml，可被环境变量覆盖 |
| Agent max_turns | `agent.max_turns` | ❌ 无 | 🔴 未迁移 | 仅存在于 yaml |
| Agent smart_stop | `agent.smart_stop.*` | ❌ 无 | 🔴 未迁移 | 仅存在于 yaml |
| Agent tracing | `agent.tracing.*` | ❌ 无 | 🔴 未迁移 | 仅存在于 yaml |
| Agent memory_system | `agent.memory_system` | ❌ 无 | 🔴 未迁移 | 代码中引用但 yaml 中没有！（AppConfig 默认值） |
| Context compact_threshold | `context.compact_threshold` | ❌ 无 | 🔴 未迁移 | 仅存在于 yaml |
| Context keep_recent | `context.keep_recent` | ❌ 无 | 🔴 未迁移 | 仅存在于 yaml |
| Context hot_memory_limit | `context.hot_memory_limit` | ❌ 无 | 🔴 未迁移 | 仅存在于 yaml |
| Context warm_memory_limit | `context.warm_memory_limit` | ❌ 无 | 🔴 未迁移 | 仅存在于 yaml |
| Context max_context_tokens | `context.max_context_tokens` | ❌ 无 | 🔴 未迁移 | AppConfig 默认值 128000 |
| Tools toolsets | `tools.toolsets` | ❌ 无（Agent.toolsets 是 Agent 级覆盖） | 🟡 部分覆盖 | 全局默认 + Agent 级覆盖 |
| Tools max_result_chars | `tools.max_result_chars` | ❌ 无 | 🔴 未迁移 | 仅存在于 yaml |
| ImageGen 配置 | `image_gen.*` | `Setting` 表 (`key="image_gen"`) | 🟡 双轨并存 | yaml 和数据库同时存在，**数据库优先**（main.py 启动时读 Setting 表注入） |
| Embedding 配置 | `embedding_model.*` | `Setting` 表 (`key="embedding_model"`) | ✅ 已迁移 | SystemSettingsPanel 写入 yaml 但后端不读，实际使用 Setting 表 |
| Provider 配置 | `provider.*` | `ComputeProvider` 表 | ✅ 已迁移 | **前端保存 provider 到 yaml 会被后端静默忽略** |
| Assistant 模型 | `assistant_model.*` | ❌ 无 | ❓ 疑似死配置 | 前端可编辑，后端无消费方 |

### 2.3 🔴 严重发现：前端保存的 Provider 配置被静默丢弃

**根因**：

```python
# backend/app/api/config.py
_MUTABLE_SECTIONS = {
    "context",
    "tools",
    "tavily",
    "image_gen",
    # ❌ "provider" 不在白名单中！
    # ❌ "assistant_model" 不在白名单中！
    # ❌ "embedding_model" 不在白名单中！
}

@router.put("")
async def update_config(body: UpdateConfigReq, user=Depends(require_user)):
    payload = body.model_dump(exclude_unset=True)
    for section, value in payload.items():
        if section not in _MUTABLE_SECTIONS:
            continue  # ← provider / assistant_model / embedding_model 被直接跳过！
```

**前端行为**：

```typescript
// frontend/src/components/SystemSettingsPanel.vue::save()
const payload: any = {}
payload.provider = { ... }        // ← 发送了
payload.assistant_model = { ... } // ← 发送了
payload.embedding_model = { ... } // ← 发送了
payload.context = { ... }         // ← 接收了
payload.tavily = { ... }          // ← 接收了
payload.image_gen = { ... }       // ← 接收了
await api.put('/config', payload)
```

**后果**：
- 用户在 SystemSettingsPanel 的 "对话模型" tab 中配置的 Provider base_url/api_key/model **永远不会被保存到 config.yaml**
- 用户配置的 assistant_model / embedding_model **永远不会被保存**
- 前端显示"保存成功"，但实际上只有 context/tools/tavily/image_gen 被写入
- 实际运行中，Provider 配置来自 `ComputeProvider` 表（通过 AgentEdit.vue 配置），与 SystemSettingsPanel 完全脱节

---

## 3. 加密体系现状

### 3.1 核心结论

> **项目中不存在 `crypto.py`，不存在 Fernet，不存在 AES-GCM。**  
> 所有所谓的"加密"都是 `base64.b64encode/b64decode` 的**混淆（obfuscation）**，不是加密。

### 3.2 假加密（base64）调用点完整清单

| # | 文件 | 函数/代码 | 用途 | 说明 |
|---|------|-----------|------|------|
| 1 | `backend/app/api/compute.py` L57-65 | `_encrypt_key()` / `_decrypt_key()` | Provider API Key 编解码 | "官方"函数，注释自嘲为 simple obfuscation |
| 2 | `backend/app/api/compute.py` L110 | `_encrypt_key(body.api_key)` | 创建 Provider 时加密 | |
| 3 | `backend/app/api/compute.py` L136 | `_decrypt_key(prov.api_key_encrypted)` | 测试连接时解密 | |
| 4 | `backend/app/api/compute.py` L188 | `_encrypt_key(body.api_key)` | 更新 Provider 时加密 | |
| 5 | `backend/app/services/engine_bridge.py` L40-42 | `_decrypt_key(enc)` | EngineBridge 解密 | **独立实现**，与 compute.py 代码重复 |
| 6 | `backend/app/services/engine_bridge.py` L221 | `_decrypt_key(prov_row.api_key_encrypted)` | 构建 transport 时解密 | |
| 7 | `backend/app/services/agent_worker.py` L387 | 内联 `base64.b64decode()` | 构建 transport 时解密 | **没有调用公共函数**，直接内联 |
| 8 | `backend/app/main.py` L147 | 内联 `base64.b64decode()` | Embedding 初始化时解密 | |
| 9 | `backend/app/main.py` L187 | 内联 `base64.b64decode()` | ImageGen 初始化时解密 | |
| 10 | `backend/app/api/agents.py` L511 | 内联 `base64.b64decode()` | Personality analysis 时解密 | |

### 3.3 真加密（crypto.py）调用点

| # | 文件 | 调用点 | 说明 |
|---|------|--------|------|
| — | — | — | **不存在** |

### 3.4 各解密函数实现对比

```python
# compute.py 版本（"官方"）
def _encrypt_key(raw: str) -> str:
    import base64
    return base64.b64encode(raw.encode()).decode()

def _decrypt_key(enc: str) -> str:
    import base64
    return base64.b64decode(enc.encode()).decode()

# engine_bridge.py 版本（重复实现）
def _decrypt_key(enc: str) -> str:
    import base64
    return base64.b64decode(enc.encode()).decode()

# agent_worker.py / main.py / agents.py 版本（内联）
api_key = base64.b64decode(prov.api_key_encrypted.encode()).decode()
```

**结论**：5 处实现，3 种写法，功能完全一致（都是 base64 编解码），没有任何密钥派生或加密算法。

### 3.5 加密统一方案（建议）

如果要引入真正的加密，推荐方案：

```python
# 过渡期双解密逻辑
from cryptography.fernet import Fernet, InvalidToken

def _get_device_key() -> bytes:
    """从机器指纹派生密钥，确保同一设备可解密。"""
    import hashlib
    # 组合多个稳定机器标识
    machine_id = f"{platform.node()}-{uuid.getnode()}"
    return base64.urlsafe_b64encode(hashlib.sha256(machine_id.encode()).digest())

def encrypt_value(raw: str) -> str:
    f = Fernet(_get_device_key())
    return f.encrypt(raw.encode()).decode()

def decrypt_value(enc: str) -> str:
    f = Fernet(_get_device_key())
    try:
        return f.decrypt(enc.encode()).decode()
    except InvalidToken:
        # 可能是旧格式 base64，尝试降级
        try:
            raw = base64.b64decode(enc.encode()).decode()
            # 自动升级：重新加密并保存
            return raw
        except Exception:
            raise ValueError("Cannot decrypt API key")
```

**需要修改的文件**：
1. `backend/app/api/compute.py` — 替换 `_encrypt_key` / `_decrypt_key`
2. `backend/app/services/engine_bridge.py` — 删除独立 `_decrypt_key`，统一引用
3. `backend/app/services/agent_worker.py` — 内联解密改为调用公共函数
4. `backend/app/main.py` — 内联解密改为调用公共函数
5. `backend/app/api/agents.py` — 内联解密改为调用公共函数

---

## 4. 代码重复清单

### 4.1 `_PROFILE_MAP` 重复

**位置 1**：`backend/engine/provider/factory.py` L21-25
```python
_PROFILE_MAP = {
    "deepseek": DeepSeekThinkingProfile,
    "mimo": MiMoThinkingProfile,
    "kimicode": KimiCodeThinkingProfile,
    "glm": GLMThinkingProfile,
    "openai": DeepSeekThinkingProfile,
}
```

**位置 2**：`backend/app/services/engine_bridge.py` L33-37
```python
_PROFILE_MAP = {
    "deepseek": DeepSeekThinkingProfile,
    "mimo": MiMoThinkingProfile,
    "kimicode": KimiCodeThinkingProfile,
    "glm": GLMThinkingProfile,
    "openai": DeepSeekThinkingProfile,
}
```

**差异分析**：**100% 相同**，连 openai → DeepSeekThinkingProfile 的映射都一样。

**建议**：engine_bridge.py 直接 `from engine.provider.factory import _PROFILE_MAP` 或 `from engine.provider import PROFILE_MAP`。

### 4.2 `_build_transport` 重复

**位置 1**：`backend/app/services/agent_worker.py` L394-412
```python
async def _build_transport(self) -> ChatCompletionsTransport | None:
    model_cfg = self.agent_row.model_config or {}
    provider_id = model_cfg.get("provider_id")
    provider_type = (model_cfg.get("provider") or "deepseek").lower()
    model_name = model_cfg.get("model") or "deepseek-v4-pro"

    async def _resolve(ptype: str) -> dict | None:
        return await self._resolve_provider(provider_id=provider_id, provider_type=ptype)

    from engine.provider.factory import build_transport
    return await build_transport(provider_type, model_name, _resolve)
```

**位置 2**：`backend/app/services/engine_bridge.py` L190-228
```python
async def _build_transport(self, agent_row: Agent) -> ChatCompletionsTransport | None:
    model_cfg = agent_row.model_config or {}
    provider_id = model_cfg.get("provider_id")
    provider_type = (model_cfg.get("provider") or "deepseek").lower()
    model_name = model_cfg.get("model") or "deepseek-v4-pro"

    # 独立查 ComputeProvider 表...
    # 独立构建 ChatCompletionsTransport...
```

**差异分析**：
- 两者逻辑高度相似：查 `ComputeProvider` → 解密 api_key → 取 base_url → 选 Profile → 建 Transport
- engine_bridge 版没有使用 `factory.build_transport()`，而是**直接实例化** `ChatCompletionsTransport`
- engine_bridge 版的 `_PROFILE_MAP` 是本地重复的

**建议**：统一使用 `engine.provider.factory.build_transport()`，传入 `resolve_config` callback。

### 4.3 `_decrypt_key` 重复

| # | 位置 | 形式 | 差异 |
|---|------|------|------|
| 1 | `backend/app/api/compute.py` L57-65 | 命名函数 `_encrypt_key` / `_decrypt_key` | 无差异，作为"官方"实现 |
| 2 | `backend/app/services/engine_bridge.py` L40-42 | 命名函数 `_decrypt_key` | **与 compute.py 完全相同的代码**，独立复制 |
| 3 | `backend/app/services/agent_worker.py` L387 | 内联 `base64.b64decode(...)` | 没有调用任何函数 |
| 4 | `backend/app/main.py` L147 | 内联 `base64.b64decode(...)` | 没有调用任何函数 |
| 5 | `backend/app/main.py` L187 | 内联 `base64.b64decode(...)` | 第二次内联 |
| 6 | `backend/app/api/agents.py` L511 | 内联 `base64.b64decode(...)` | 没有调用任何函数 |

**统计**：6 处调用，3 种写法，0 种真正加密。

### 4.4 Provider 解析重复

**位置 1**：`backend/app/services/agent_worker.py` L371-398
```python
async def _resolve_provider(self, provider_id=None, provider_type=None):
    from ..models import ComputeProvider
    # 查表 → 解密 → 返回 {"base_url": ..., "api_key": ...}
```

**位置 2**：`backend/app/api/agents.py` L480-512
```python
# analyze-personality 中的 Provider 解析
# 查表 → 解密 → 注入 model_cfg["marker"]
```

**位置 3**：`backend/app/main.py` L127-154
```python
# Embedding 初始化时的 Provider 解析
# 查表 → 解密 → 构建 Embedder
```

**位置 4**：`backend/app/main.py` L168-193
```python
# ImageGen 初始化时的 Provider 解析
# 查表 → 解密 → 调用 set_image_gen_config()
```

**建议**：抽取公共函数 `resolve_provider_credentials(db, provider_id)` 到 `app/services/provider_resolver.py`。

---

## 5. 配置冲突/不一致问题

### 5.1 问题清单

#### 🔴 P1：SystemSettingsPanel 保存 Provider 配置不生效

**现象**：用户在 "对话模型" tab 配置 Provider，点击保存，前端显示"保存成功"，但配置丢失。

**根因**：
- 前端发送 `payload.provider = {...}`
- 后端 `_MUTABLE_SECTIONS` 不包含 `"provider"`，直接 `continue` 跳过
- 返回的响应是旧 config.yaml 内容（不含 provider），前端 `mergeConfig` 后看起来"保存成功"
- 实际配置从未写入磁盘

**影响**：用户无法通过 SystemSettingsPanel 配置 Provider，必须去 AgentEdit.vue → Compute 配置。

#### 🟡 P2：ImageGen 配置双轨并存

**现象**：SystemSettingsPanel 的 "图片生成" tab 配置似乎有效，但 Compute API 也有一套 ImageGen 配置。

**根因**：
- SystemSettingsPanel → `PUT /config` → 写入 `config.yaml` → `image_gen.*`
- AgentEdit.vue / Compute API → `PUT /compute/image-gen` → 写入 `Setting` 表 (`key="image_gen"`)
- `app/main.py` 启动时读取 **Setting 表**，调用 `set_image_gen_config()`
- `generate_image` tool 使用注入的 `_image_gen_cfg`，**从不读取 config.yaml**

**影响**：用户在 SystemSettingsPanel 配置的 image_gen 实际上**可能被忽略**（如果 Setting 表中有不同值）。

#### 🟡 P3：Tavily API Key 双源

**现象**：Tavily key 可以在 config.yaml 中配置，也可以通过环境变量配置。

**根因**：
- `engine/tools/web/search.py` 优先读取 `TAVILY_API_KEY` 环境变量
-  fallback 读取 `config.yaml` → `tavily.api_key`
- 没有统一的管理界面

**影响**：环境变量优先级高，但用户可能不知道，在 SystemSettingsPanel 修改 config.yaml 的 tavily 配置后仍然使用旧的环境变量值。

#### 🟡 P4：Agent.model_config 是"万能桶"

**现象**：Agent 的 `model_config` JSON 字段中混入了 LLM 配置、Marker 配置、Embedder 配置、Compressor 配置、Fallback 链、人格参数、上下文窗口等十余个不同领域的配置。

**根因**：使用单一 JSON 字段存储所有 Agent 级运行时配置，没有 Schema 约束。

**影响**：
- 前端和后端对 `model_config` 的理解可能不一致
- 无法做数据库级别的外键约束（如 `provider_id` 无法保证指向有效的 ComputeProvider）
- 配置迁移困难（需要逐 key 解析 JSON）
- 容易引入脏数据（用户手动修改 JSON 时）

#### 🟢 P5：EngineBridge 独立加载 config.yaml

**现象**：EngineBridge 在 `__init__` 中独立调用 `load_config()`，而不是复用 `app.state.config`。

**根因**：
```python
# engine_bridge.py L62
_cfg_path = pathlib.Path(__file__).resolve().parent.parent.parent / "engine" / "config.yaml"
app_config = load_config(_cfg_path)
```

**影响**：
- 如果 `app.main.py` 启动时加载了不同的路径（如用户自定义配置），EngineBridge 仍然读默认路径
- 两份 `AppConfig` 实例可能不一致
- 虽然当前都是同一文件，但设计上是隐患

#### 🟢 P6：Search Tool 独立加载 config.yaml

**现象**：`search_web` tool 独立调用 `load_config()`。

**根因**：`engine/tools/web/search.py` 为了不在顶层导入 `app` 层代码，选择独立加载 config.yaml。

**影响**：与 P5 类似，可能读到不一致的配置。

---

## 6. 整合建议

### 6.1 短期（Provider 子系统重做时同步处理）

| 优先级 | 事项 | 方案 |
|--------|------|------|
| 🔴 P0 | **修复 SystemSettingsPanel Provider 保存** | 两种方式：① 后端 `_MUTABLE_SECTIONS` 增加 `"provider"`（临时）；② **推荐**：SystemSettingsPanel LLM tab 完全改为调用 Compute API (`/compute/providers`) |
| 🔴 P0 | **统一加密函数** | 新建 `app/core/crypto.py`，提供 `encrypt_value()` / `decrypt_value()`（先保持 base64 兼容），所有文件统一引用 |
| 🔴 P0 | **删除代码重复** | engine_bridge.py 的 `_PROFILE_MAP` 和 `_decrypt_key` 删除，统一引用 factory / crypto |
| 🟡 P1 | **抽取 Provider 解析公共函数** | 新建 `app/services/provider_resolver.py`，统一处理 ComputeProvider 查表 + 解密 + 返回 credentials dict |
| 🟡 P1 | **清理 ImageGen 双轨** | SystemSettingsPanel 的 image_gen 配置改为调用 `/compute/image-gen` API，不再写入 config.yaml |
| 🟡 P1 | **清理 Embedding 双轨** | SystemSettingsPanel 的 embedding 配置改为调用 `/compute/embedding-model` API |

### 6.2 中期（配置体系重构）

| 优先级 | 事项 | 方案 |
|--------|------|------|
| 🟡 P1 | **拆分 Agent.model_config** | 将 JSON 万能桶拆分为独立的数据库字段：`provider_id`, `model_id`, `temperature`, `top_p`, `marker_provider_id`, `marker_model_id` 等 |
| 🟡 P1 | **迁移 config.yaml 中的非 Provider 配置** | `context.*` → 新增 `ContextSetting` 表或保留为文件配置（全局共享，不常修改）；`agent.*` → 保留为文件配置或迁移到 `AgentSetting` 表；`tools.*` → 保留为文件配置 |
| 🟢 P2 | **统一配置加载入口** | EngineBridge、Search Tool 不再独立调用 `load_config()`，改为从 `_app_state["config"]` 或注入的 `AppConfig` 获取 |
| 🟢 P2 | **引入真正的 API Key 加密** | 使用 Fernet + 设备指纹密钥，过渡期支持双解密（先尝试 Fernet，失败降级 base64） |

### 6.3 长期（配置中心 V2）

| 优先级 | 事项 | 方案 |
|--------|------|------|
| 🟢 P2 | **配置变更热更新** | Provider 配置修改后，通知运行中的 AgentWorker 重新加载 transport（当前需要重启 Agent） |
| 🟢 P2 | **配置版本控制** | 对 config.yaml 和数据库配置做版本快照，支持回滚 |
| ⚪ P3 | **配置 Schema 校验** | Agent.model_config 等 JSON 字段使用 JSON Schema 或 Pydantic 校验，防止脏数据 |

### 6.4 废弃清单

| 项目 | 废弃原因 | 替代方案 |
|------|----------|----------|
| `config.yaml` 中的 `provider.*` | 已迁移到 `ComputeProvider` 表 | `GET/PUT /api/v1/compute/providers` |
| `config.yaml` 中的 `assistant_model.*` | 无消费方，疑似死配置 | 如需使用，改为 `ComputeProvider` + Agent 配置 |
| `config.yaml` 中的 `embedding_model.*` | 已迁移到 `Setting` 表 | `/api/v1/compute/embedding-model` |
| `config.yaml` 中的 `image_gen.*` | 已迁移到 `Setting` 表 | `/api/v1/compute/image-gen` |
| `engine_bridge.py` 的 `_PROFILE_MAP` | 与 factory.py 完全重复 | `from engine.provider.factory import _PROFILE_MAP` |
| `engine_bridge.py` 的 `_decrypt_key` | 与 compute.py 完全重复 | `from app.core.crypto import decrypt_value` |
| `agent_worker.py` / `main.py` 的内联 base64 | 代码分散，难以维护 | 统一调用 `app.core.crypto.decrypt_value` |

---

## 附录 A：关键文件速查

| 文件 | 职责 | 问题 |
|------|------|------|
| `backend/app/api/config.py` | REST API 读写 config.yaml | `_MUTABLE_SECTIONS` 缺少 provider/assistant_model/embedding_model，导致前端保存被静默丢弃 |
| `backend/app/api/compute.py` | ComputeProvider CRUD | `_encrypt_key` / `_decrypt_key` 是唯一的"官方"加密实现，但只是 base64 |
| `backend/app/services/agent_worker.py` | AgentWorker 核心 | `_resolve_provider` / `_build_transport` 逻辑应与 engine_bridge 统一；内联 base64 解密 |
| `backend/app/services/engine_bridge.py` | EngineBridge 兼容层 | 独立加载 config.yaml；重复定义 `_PROFILE_MAP` 和 `_decrypt_key` |
| `backend/engine/provider/factory.py` | Transport 工厂 | `_PROFILE_MAP` 硬编码 5 个 Provider，不支持动态扩展 |
| `backend/engine/tools/web/search.py` | Tavily 搜索 | 独立加载 config.yaml，可能与 app 层配置不一致 |
| `frontend/src/components/SystemSettingsPanel.vue` | 系统设置面板 | LLM/Assistant/Embedding tab 的配置保存到 config.yaml 但后端不接收 |
| `frontend/src/components/AgentEdit.vue` | Agent 编辑 | Compute tab 的配置实际生效（写入 Agent.model_config + ComputeProvider 表） |

---

## 附录 B：配置优先级矩阵

| 配置项 | 环境变量 | config.yaml | 数据库 | 运行时生效优先级 |
|--------|----------|-------------|--------|------------------|
| Tavily API Key | ✅ `TAVILY_API_KEY` | ✅ `tavily.api_key` | ❌ | 环境变量 > config.yaml |
| Provider base_url/api_key | ❌ | ❌ | ✅ `ComputeProvider` | 数据库 |
| Provider model | ❌ | ❌ | ✅ `ComputeProvider.config.models` | 数据库 |
| Agent provider/model | ❌ | ❌ | ✅ `Agent.model_config` | 数据库（JSON） |
| Embedding model | ❌ | ❌（前端写但后端不读） | ✅ `Setting` 表 | 数据库 |
| ImageGen model | ❌ | ✅（前端写） | ✅ `Setting` 表 | **数据库**（main.py 启动时读 Setting 表注入） |
| 记忆/上下文配置 | ❌ | ✅ `context.*` | ❌ | config.yaml |
| 工具配置 | ❌ | ✅ `tools.*` | ❌（Agent 级覆盖在 DB） | config.yaml + Agent.toolsets 覆盖 |

---

*报告完成。等待指挥官确认后进入实施阶段。*
