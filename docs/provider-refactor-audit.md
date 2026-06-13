# Provider 子系统重做——摸底报告

> **项目**：CloudMind-Zome  
> **日期**：2026-06-09  
> **范围**：Provider / 模型配置体系全面重做为动态 Provider 体系  
> **状态**：只摸底，不改代码，等待指挥官确认后实施

---

## 目录

1. [当前 Provider 配置的数据流](#1-当前-provider-配置的数据流)
2. [Provider 配置的消费方](#2-provider-配置的消费方)
3. [Fallback 链的实现](#3-fallback-链的实现)
4. [前端 Provider 设置](#4-前端-provider-设置)
5. [Agent 配置中的模型相关字段](#5-agent-配置中的模型相关字段)
6. [API Key 加密现状](#6-api-key-加密现状)
7. [涉及改动的文件清单](#7-涉及改动的文件清单)
8. [风险评估](#8-风险评估)
9. [建议的实施顺序](#9-建议的实施顺序)

---

## 1. 当前 Provider 配置的数据流

### 1.1 硬编码的 4 个 Provider 定义位置

| 位置 | 内容 | 说明 |
|------|------|------|
| `backend/engine/provider/factory.py` L21-24 | `_PROFILE_MAP` 硬编码 5 个 key | `deepseek/mimo/kimicode/glm/openai` → 对应 ThinkingProfile 类 |
| `backend/app/services/engine_bridge.py` L33-36 | 重复的 `_PROFILE_MAP` | 与 factory.py 完全一致，代码重复 |
| `backend/engine/provider/thinking/` | 4 个独立 Profile 文件 | `deepseek.py`, `mimo.py`, `kimicode.py`, `glm.py`, `plain.py` |
| `frontend/src/components/SystemSettingsPanel.vue` L88-93 | `<option>` 硬编码 4 项 | deepseek / mimo / kimicode / glm |
| `backend/app/api/compute.py` L32-37 | `_detect_provider_type()` | 通过 URL 关键词（deepseek/siliconflow/openai）推断 provider_type |

### 1.2 Provider 配置读取路径

**旧体系（config.yaml，将被替换）**

```
backend/engine/config.yaml
  → provider.deepseek.base_url / api_key / model
  → provider.mimo.base_url / api_key / model
  → ...（4 个 Provider 各 3 个字段）
```

- **读取 API**：`GET /api/v1/config` → `backend/app/api/config.py`
- **写入 API**：`PUT /api/v1/config` → 直接覆盖 config.yaml
- **消费端**：`SystemSettingsPanel.vue` 直接读写该配置

**新体系（ComputeProvider 表，已部分实现）**

```
backend/app/models/compute.py → ComputeProvider 表
  → provider_type, display_name, api_key_encrypted, config(JSON)
```

- **读取 API**：`GET /api/v1/compute/providers` / `GET /api/v1/agents/providers`
- **消费端**：AgentWorker、EngineBridge、Embedding 初始化、ImageGen 初始化

### 1.3 Agent 的 model_name / provider 选择存储

存储位置：`Agent.model_config`（JSON 字段），`backend/app/models/agents.py`

当前数据结构：

```json
{
  "provider": "deepseek",
  "provider_id": "uuid",
  "model": "deepseek-v4-pro",
  "marker": {
    "provider_id": "",
    "provider": "",
    "model": ""
  },
  "embedder": {
    "provider_id": "",
    "model": ""
  },
  "compressor": {
    "provider_id": "",
    "model": ""
  },
  "fallback_chain": [
    {"provider_id": "", "provider": "", "model": ""}
  ]
}
```

### 1.4 Fallback 链数据流

- **存储**：`Agent.model_config.fallback_chain`（JSON 数组）
- **构建**：`backend/app/services/agent_worker.py` L103-120
  - 遍历 `fallback_chain`，查 `ComputeProvider` 表构建 `fallback_transports: dict[str, ChatCompletionsTransport]`
- **注入**：`backend/engine/agent/react.py` L106-113
  - `fb_names = [item.get("provider", "deepseek") for item in fb_chain_raw]`
  - `self._fallback = FallbackChain(fb_names)`
  - `self._transports = fallback_transports`

---

## 2. Provider 配置的消费方

### 2.1 消费文件清单

| # | 文件 | 用途 | 使用方式 |
|---|------|------|----------|
| 1 | `backend/app/services/agent_worker.py` | AgentWorker 启动时构建主 transport + fallback transports | `_resolve_provider()` 查 `ComputeProvider` 表 → base64 解密 api_key → `factory.build_transport()` |
| 2 | `backend/app/services/engine_bridge.py` | EngineBridge 兼容层构建 transport | `_build_transport()` 查 `ComputeProvider` 表，逻辑与 agent_worker 重复 |
| 3 | `backend/engine/provider/factory.py` | 根据 provider_type 选择 ThinkingProfile | `_PROFILE_MAP.get(provider_type)` → 创建 `ChatCompletionsTransport` |
| 4 | `backend/engine/provider/transport.py` | 实际调用 LLM API | `AsyncOpenAI(base_url=base_url, api_key=api_key)` → `chat.completions.create(model=self.model, ...)` |
| 5 | `backend/engine/context/token_counter.py` | Token 计数 | `count_tokens(text, model)` 根据 model 名称匹配 tiktoken encoding |
| 6 | `backend/engine/memory/topic_compression/marker.py` | 话题标注 LLM | `TopicMarker.from_config(model_config)` 读取 provider/model/api_key/base_url 创建独立 transport |
| 7 | `backend/engine/personality/extractor.py` | 人格分析 LLM | `PersonalityExtractor.from_marker_config(model_config)` 同上 |
| 8 | `backend/app/main.py` | Embedding / ImageGen 全局初始化 | 查 `ComputeProvider` + `Setting` 表，构建 `Embedder` 和 `set_image_gen_config()` |

### 2.2 model_name 传给 LLM API 的完整链路

```
Agent.model_config.model
  └─→ AgentWorker._build_transport()
        └─→ EngineBridge._build_transport()
              └─→ factory.build_transport(provider_type, model_name, resolve_config)
                    └─→ ChatCompletionsTransport.__init__(..., model=model_name)
                          └─→ _build_request_kwargs()
                                └─→ kwargs["model"] = self.model
                                      └─→ AsyncOpenAI.chat.completions.create(**kwargs)
                                            ← 最终 HTTP 请求体中的 model 字段
```

### 2.3 Provider 配置在 Transport 层的使用

```python
# backend/engine/provider/transport.py
self._client = AsyncOpenAI(
    base_url=base_url,      # ← 来自 ComputeProvider.config.base_url
    api_key=api_key,        # ← 来自 ComputeProvider.api_key_encrypted（base64 解密）
    timeout=timeout,        # ← 硬编码 120.0
    max_retries=max_retries, # ← 硬编码 3
)
```

当前 `timeout` 和 `max_retries` 是硬编码在 `ChatCompletionsTransport` 构造中的，**不支持按 Provider 配置**。

---

## 3. Fallback 链的实现

### 3.1 代码位置

- **定义**：`backend/engine/error/fallback.py` — `FallbackChain` 类
- **消费**：`backend/engine/agent/react.py` — `_call_llm_stream_with_recovery()` L647-694
- **构建**：`backend/app/services/agent_worker.py` L103-120

### 3.2 FallbackChain 当前实现

```python
# backend/engine/error/fallback.py
class FallbackChain:
    def __init__(self, chain: list[str]):
        """chain: e.g. ["deepseek", "mimo", "kimicode", "glm"]"""
        self._chain = chain
        self._current_index = 0

    def should_fallback(self, error: ClassifiedError) -> bool:
        if self._current_index >= len(self._chain) - 1:
            return False
        fallback_reasons = {
            FailoverReason.auth_permanent,
            FailoverReason.model_not_found,
            FailoverReason.rate_limit,    # After retries exhausted
            FailoverReason.server_error,  # After retries exhausted
            FailoverReason.empty_response, # After retries
        }
        return error.reason in fallback_reasons

    def fallback(self) -> str | None:
        if self._current_index >= len(self._chain) - 1:
            return None
        self._current_index += 1
        return self.current_provider

    def reset(self) -> None:
        self._current_index = 0
```

### 3.3 ReActAgent 中的 Fallback 触发逻辑

```python
# backend/engine/agent/react.py L647-694
async def _call_llm_stream_with_recovery(self, messages, tools):
    attempt = 0
    while True:
        try:
            async for block in self._current_transport.stream(messages, tools):
                yield block
            return
        except Exception as e:
            classified = classify_error(e, provider=self._fallback.current_provider)

            # 1. 先重试
            if classified.retryable:
                delay = get_retry_delay(classified.reason.value, attempt, self._retry_config)
                if delay >= 0:
                    await asyncio.sleep(delay)
                    attempt += 1
                    continue

            # 2. 再 fallback
            if self._fallback.should_fallback(classified):
                next_provider = self._fallback.fallback()
                if next_provider and next_provider in self._transports:
                    self._current_transport = self._transports[next_provider]
                    attempt = 0
                    continue

            raise last_error
```

### 3.4 Fallback 链的关键问题

| 问题 | 说明 |
|------|------|
| 以 provider name 为 key | `FallbackChain._chain = ["deepseek", "mimo", ...]`，无法区分同一 Provider 的不同 Model |
| `_transports` 以 name 索引 | `fallback_transports["deepseek"] = transport`，同一 Provider 多个 Model 会覆盖 |
| 不携带 model 信息 | fallback 时只切换 transport，不切换 model。当前每个 provider 只配 1 个 model，所以没暴露问题 |
| 不支持动态更新 | AgentWorker 启动时固化 fallback transports，运行中修改 Provider 配置不会生效 |

---

## 4. 前端 Provider 设置

### 4.1 UI 位置

| 文件 | Tab | 功能 |
|------|-----|------|
| `frontend/src/components/SystemSettingsPanel.vue` | `llm` | 全局 Provider 配置：Fallback 链排序、4 个 Provider 的 base_url/model/api_key |
| `frontend/src/components/AgentEdit.vue` | `compute` | Agent 级 Provider/Model 选择、降级链配置、独立 Marker/Embedder/Compressor |

### 4.2 SystemSettingsPanel.vue 中的硬编码

```vue
<!-- Fallback 添加选项 -->
<select v-model="fallbackInput" @change="addFallback">
  <option value="">+ 添加 fallback</option>
  <option value="deepseek">deepseek</option>
  <option value="mimo">mimo</option>
  <option value="kimicode">kimicode</option>
  <option value="glm">glm</option>
</select>

<!-- Provider 配置卡片 -->
<div v-for="name in ['deepseek', 'mimo', 'kimicode', 'glm']" :key="name">
```

### 4.3 保存配置的 API

| 端点 | 方法 | 说明 |
|------|------|------|
| `/api/v1/config` | GET/PUT | 读写 config.yaml（旧体系，将被废弃） |
| `/api/v1/compute/providers` | GET/POST/PUT/DELETE | ComputeProvider CRUD（新体系） |
| `/api/v1/agents/providers` | GET | AgentEdit 专用，返回 provider 列表 + models |
| `/api/v1/compute/providers/{id}/test` | POST | 测试连接并自动拉取模型列表 |

### 4.4 AgentEdit.vue 中 Provider 选择逻辑

```typescript
// 拉取 Provider 列表
const json = await api.get('/agents/providers')
llmProviders.value = json.data || []  // {id, name, display_name, models[], base_url, supports_*}

// 选择 Provider 后自动填充默认 model
function onLlmProviderChange() {
  const p = llmProviders.value.find(x => x.id === form.value.llm_config.provider_id)
  form.value.llm_config.provider = p?.name || ''
  form.value.llm_config.model = p?.models?.[0] || ''
}
```

---

## 5. Agent 配置中的模型相关字段

### 5.1 数据库字段

**Agent 表**（`backend/app/models/agents.py`）：

```python
model_config: Mapped[Optional[dict]] = mapped_column(JSON, default=dict)
# 当前包含: provider, provider_id, model, marker, embedder, compressor,
#          fallback_chain, personality, api_key, base_url...
```

**ComputeProvider 表**（`backend/app/models/compute.py`）：

```python
provider_type: str       # e.g. "deepseek"
display_name: str        # e.g. "DeepSeek 官方"
api_key_encrypted: str   # base64 编码（实际上是混淆）
config: JSON            # {base_url, models: [...]}
status: str             # active / inactive
```

> **注意**：当前没有独立的 Model 表，模型信息以字符串数组形式存储在 `ComputeProvider.config.models` 中。

### 5.2 Agent 创建/编辑时选模型

**前端流程**：

1. `AgentEdit.vue` → `compute` tab
2. `select` 选择 Provider（`llm_config.provider_id`）
3. `select` 选择 Model（`llm_config.model`），选项来自 `currentLlmProvider.models`
4. 可选：配置独立 Marker / Embedder / Compressor
5. 配置 Fallback 链（`provider_id + model` 组合）
6. 保存 → `POST/PUT /api/v1/agents` → `body.llm_config`

**后端流程**：

1. `agents.py` → `AgentCreate` / `AgentUpdate` Schema
2. `model_config=body.llm_config` 直接存入 JSON 字段
3. 不做外键约束校验（JSON 的自由性）

### 5.3 消费链路

| 消费方 | 读取路径 | 说明 |
|--------|----------|------|
| 主推理模型 | `AgentWorker._build_transport()` | 查 `ComputeProvider` → 构建主 transport |
| Marker 模型 | `TopicMarker.from_config()` | 查 `model_config.marker` → 独立 transport |
| Embedder 模型 | `app/main.py` 启动时 | 查 `Setting` + `ComputeProvider` → 全局 `Embedder` |
| ImageGen 模型 | `app/main.py` 启动时 | 同上 |
| Compressor 模型 | `AgentWorker.start()` | 暂未看到直接调用，字段已预留 |
| Fallback 链 | `AgentWorker.start()` | 预构建所有 fallback transport，注入 `ReActAgent` |

---

## 6. API Key 加密现状

### 6.1 加密/解密函数分布

| 文件 | 函数名 | 实现 | 说明 |
|------|--------|------|------|
| `backend/app/api/compute.py` L56-62 | `_encrypt_key` / `_decrypt_key` | `base64.b64encode/decode` | 唯一"官方"函数 |
| `backend/app/services/agent_worker.py` L390-396 | 内联解密 | `base64.b64decode()` | 查 Provider 时内联使用 |
| `backend/app/services/engine_bridge.py` L41-42 | `_decrypt_key` | `base64.b64decode()` | 独立封装，与 compute.py 重复 |
| `backend/app/main.py` L138, L154 | 内联解密 | `base64.b64decode()` | Embedding / ImageGen 初始化 |
| `backend/app/api/agents.py` L508-512 | 内联解密 | `base64.b64decode()` | Personality analysis 时 |

### 6.2 现状结论

> 注释原文：*"MVP: simple obfuscation. Production: use AES-GCM with device key."*

- `ComputeProvider.api_key_encrypted` 实际上是 **base64 编码（混淆）**，不是加密
- 没有使用设备密钥或 AES-GCM
- 数据库中存储的是可逆的 base64 字符串，安全性较低
- 重做时应引入真正的加密（如 Fernet 或 AES-GCM），并使用设备/环境派生密钥

### 6.3 升级建议

```python
# 过渡期双解密逻辑（伪代码）
def decrypt_key(enc: str) -> str:
    try:
        return aes_gcm_decrypt(enc, device_key)
    except InvalidToken:
        # 可能是旧格式 base64
        raw = base64.b64decode(enc.encode()).decode()
        # 读取成功后，自动升级为新加密
        re_encrypt_and_save(raw)
        return raw
```

---

## 7. 涉及改动的文件清单

### 7.1 后端改动

| # | 文件 | 改动内容 | 预估行数 |
|---|------|----------|----------|
| 1 | `backend/app/models/compute.py` | ComputeProvider 表新增字段：`auth_mode`, `custom_headers`, `is_builtin`, `require_api_key`, `request_timeout`, `max_retries`, `rate_limit_qpm` | ~30 |
| 2 | `backend/app/models/agents.py` | Agent 表新增：`provider_id`, `model_id`, `temperature`, `top_p` | ~15 |
| 3 | **新建** `backend/app/models/models.py` | 新建 `LLMModel` 表 | ~40 |
| 4 | `backend/app/api/compute.py` | Provider CRUD 扩展：支持新字段、自动检测优化、加密升级 | ~80 |
| 5 | **新建** `backend/app/api/models.py` | Model CRUD API（绑定到 Provider 下） | ~100 |
| 6 | `backend/app/api/agents.py` | Agent API 适配新字段；`analyze-personality` 适配；`list_providers` 返回 Model 列表 | ~60 |
| 7 | `backend/app/services/agent_worker.py` | `_resolve_provider()` / `_build_transport()` / fallback transport 构建改为 `provider_id/model_id` | ~80 |
| 8 | `backend/app/services/engine_bridge.py` | `_build_transport()` 适配新体系；去除重复 `_PROFILE_MAP` | ~40 |
| 9 | `backend/engine/provider/factory.py` | `_PROFILE_MAP` 改为动态查找；支持自定义 Provider 的 profile 映射 | ~30 |
| 10 | `backend/engine/provider/transport.py` | 支持 `auth_mode`（api_key/bearer）、`custom_headers`、`timeout`、`max_retries` 动态注入 | ~40 |
| 11 | `backend/engine/error/fallback.py` | `FallbackChain` 改造为 `provider_id/model_id` 组合节点 | ~30 |
| 12 | `backend/engine/agent/react.py` | fallback_chain 解析适配新格式；`_transports` 使用新 key | ~30 |
| 13 | `backend/engine/context/token_counter.py` | 扩展模型名称映射，支持更多动态模型 | ~15 |
| 14 | `backend/engine/memory/topic_compression/marker.py` | `from_config()` 适配新 Provider/Model 格式 | ~20 |
| 15 | `backend/engine/personality/extractor.py` | `from_marker_config()` 适配新格式 | ~20 |
| 16 | `backend/app/main.py` | 启动迁移逻辑：config.yaml → ComputeProvider + LLMModel | ~60 |
| 17 | `backend/app/api/config.py` | 移除 `provider` 相关配置读写（标记 deprecated） | ~20 |
| 18 | `backend/tests/test_fallback_chain.py` | 测试用例更新 | ~30 |

**后端小计**：~18 个文件，约 **740 行**改动。

### 7.2 前端改动

| # | 文件 | 改动内容 | 预估行数 |
|---|------|----------|----------|
| 1 | `frontend/src/components/SystemSettingsPanel.vue` | LLM tab 重做：移除硬编码 4 Provider，改为动态 Provider 管理 | ~200 |
| 2 | `frontend/src/components/AgentEdit.vue` | compute tab 适配新字段、新选择器、新 fallback 格式 | ~120 |
| 3 | `frontend/src/stores/compute.ts` | 扩展 store：Model 列表、Provider 详情缓存 | ~40 |
| 4 | **新建** `frontend/src/components/ProviderManager.vue` | Provider 独立管理组件 | ~250 |
| 5 | **新建** `frontend/src/components/ModelSelector.vue` | Provider → Model 级联选择器 | ~80 |

**前端小计**：~3 个文件改动 + 2 个新建组件，约 **690 行**。

### 7.3 总工作量估算

| 类别 | 文件数 | 代码行数 |
|------|--------|----------|
| 后端改动 | 18 | ~740 |
| 前端改动 | 5 | ~690 |
| **合计** | **23** | **~1430** |

> 不含测试补充、文档更新、config.yaml 废弃清理的后续工作。

---

## 8. 风险评估

| # | 风险 | 严重度 | 说明 | 缓解方案 |
|---|------|--------|------|----------|
| 1 | **运行中的 Agent 受影响** | 🔴 高 | AgentWorker 启动时固化 transport，Provider 配置修改后已运行的 Worker 不会感知 | ① AgentEdit 保存后发送信号重启对应 Worker；② 文档提示"修改 Provider 后需重启 Agent" |
| 2 | **旧配置迁移失败** | 🟡 中 | config.yaml 格式可能不统一、api_key 缺失 | 迁移脚本加 try/except 和日志，单条失败不阻断启动；启动后生成迁移报告 |
| 3 | **Fallback 链改动导致对话中断** | 🟡 中 | 旧数据 `fallback_chain` 格式为 `[{"provider": "deepseek"}]`，新格式需要 `provider_id/model_id` | `ReActAgent.__init__()` 做向后兼容解析：找不到 `provider_id` 时回退到按 `provider` name 查找并 warn |
| 4 | **API Key 加密升级导致旧 key 无法解密** | 🔴 高 | 当前 base64"加密"和真正加密算法不兼容 | 过渡期双解密逻辑：先尝试 AES-GCM，失败再尝试 base64，成功后自动重写为新加密 |
| 5 | **ThinkingProfile 动态化** | 🟢 低 | 用户添加自定义 Provider（如 siliconflow）时没有对应 Profile | ① Provider 表增加 `thinking_profile` 字段（默认 `deepseek`）；② 未知类型回退到 `DeepSeekThinkingProfile`（最通用） |
| 6 | **前端状态不一致** | 🟢 低 | AgentEdit 中 `llmProviders` 缓存可能过期 | 保存 Agent 后刷新 Provider/Model 列表；删除 Provider 时校验是否有 Agent 引用 |
| 7 | **Schema 变更导致现有 Agent 启动失败** | 🔴 高 | Agent 表新增非空字段时，旧数据缺少这些字段 | 新增字段全部设置 `nullable=True` 或合理 default；JSON 字段内部做 `get(key, default)` |

---

## 9. 建议的实施顺序

分为 **4 批**，每批可独立 review/merge，降低风险。

### 第一批：数据层 + 迁移（无业务逻辑影响）

> 目标：打好数据基础，旧系统继续正常运行

1. **新建 `LLMModel` 表**，扩展 `ComputeProvider` 表（新增网络/认证字段）
2. **扩展 `Agent` 表**：新增 `provider_id`, `model_id`, `temperature`, `top_p`
3. **写启动迁移脚本**（`app/main.py` 中）：
   - 读取 `config.yaml` 的 `provider.*` 配置
   - 创建 `ComputeProvider` 记录（4 个内置 Provider）
   - 为每个 Provider 创建默认 `LLMModel` 记录
   - 更新所有 Agent 的 `model_config`，补充 `provider_id`（按 `provider` name 匹配）
4. **API Key 加密升级**：
   - 保留旧 base64 解密兼容
   - 写入时改用新加密算法
   - 启动时自动检测并升级旧格式

### 第二批：后端 API + 引擎适配

> 目标：新数据模型跑通，旧格式保持兼容

5. **新建 `/api/v1/models` CRUD API**
6. **扩展 `/api/v1/compute/providers`**：返回关联的 Model 列表
7. **改造 `factory.py` + `transport.py`**：支持 `auth_mode`, `custom_headers`, `timeout`, `max_retries`
8. **改造 `FallbackChain`**：内部存储 `(provider_id, model_id)` 组合，日志仍显示 name
9. **改造 `AgentWorker` + `EngineBridge`**：使用 `provider_id/model_id` 查表构建 transport
10. **改造 `ReActAgent`**：fallback 链解析适配新格式，**向后兼容旧格式**
11. **改造 `marker.py` + `extractor.py`**：从新的 Provider/Model 配置读取

### 第三批：前端改造

> 目标：用户界面完全切换到新体系

12. **新建 `ProviderManager.vue`**：Provider CRUD、测试连接、模型自动发现
13. **新建 `ModelSelector.vue`**：Provider → Model 级联选择，带能力图标
14. **重写 `SystemSettingsPanel.vue` LLM tab**：移除硬编码，接入 `ProviderManager`
15. **改造 `AgentEdit.vue` compute tab**：
    - 接入 `ModelSelector`
    - 新增 `temperature` / `top_p` 滑块/输入
    - Fallback 链使用 `provider_id/model_id` 格式
16. **更新 `compute.ts` store**：缓存 Model 列表、Provider 详情

### 第四批：清理 + 测试

> 目标：移除旧代码，验证稳定性

17. **移除 `config.yaml` 中的 provider 配置**（或注释标记废弃）
18. **删除 `engine_bridge.py` 中的重复 `_PROFILE_MAP`**
19. **更新 `test_fallback_chain.py`** 和补充集成测试
20. **验证旧 Agent 配置的向后兼容性**
21. **文档更新**：README / 开发文档中更新 Provider 配置说明

---

## 附录 A：关键文件速查

| 文件 | 行数 | 当前职责 |
|------|------|----------|
| `backend/app/models/compute.py` | ~60 | ComputeProvider / ComputeUsage 表定义 |
| `backend/app/models/agents.py` | ~80 | Agent 表定义（含 model_config JSON） |
| `backend/app/api/compute.py` | ~370 | Provider CRUD + 连接测试 + usage |
| `backend/app/api/agents.py` | ~820 | Agent CRUD + providers 列表 + personality |
| `backend/app/services/agent_worker.py` | ~420 | AgentWorker：构建 transport、fallback、运行 Job |
| `backend/app/services/engine_bridge.py` | ~260 | EngineBridge：stream_chat / run_sync / _build_transport |
| `backend/engine/provider/factory.py` | ~55 | build_transport：_PROFILE_MAP + 创建 ChatCompletionsTransport |
| `backend/engine/provider/transport.py` | ~290 | ChatCompletionsTransport：OpenAI 兼容 API 调用 |
| `backend/engine/error/fallback.py` | ~70 | FallbackChain：降级链管理 |
| `backend/engine/agent/react.py` | ~700 | ReActAgent：核心循环 + fallback 触发 |
| `frontend/src/components/SystemSettingsPanel.vue` | ~520 | 系统设置面板（LLM tab 硬编码 4 Provider） |
| `frontend/src/components/AgentEdit.vue` | ~2600 | Agent 编辑页（算力配置、fallback 链） |

---

*报告完成。等待指挥官确认后进入实施阶段。*
