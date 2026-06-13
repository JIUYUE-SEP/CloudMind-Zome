# CloudMind-Zome Provider 子系统重做——详细技术方案设计

> **版本**：v1.0  
> **日期**：2026-06-09  
> **状态**：设计阶段（待评审后实施）  
> **依赖文档**：
> - `docs/provider-refactor-audit.md` — 后端摸底报告
> - `docs/config-system-audit.md` — 配置体系审查报告
> - `docs/frontend-ui-audit.md` — 前端 UI 审查报告

---

## 目录

1. [providers.yaml 文件格式规范](#1-providersyaml-文件格式规范)
2. [数据库 Schema 变更](#2-数据库-schema-变更)
3. [启动流程](#3-启动流程)
4. [双写一致性](#4-双写一致性)
5. [后端 API 变更](#5-后端-api-变更)
6. [引擎层改造](#6-引擎层改造)
7. [前端改造](#7-前端改造)
8. [代码重复清理清单](#8-代码重复清理清单)
9. [废弃清单](#9-废弃清单)
10. [实施批次](#10-实施批次)
11. [风险评估与缓解](#11-风险评估与缓解)

---

## 1. providers.yaml 文件格式规范

### 1.1 设计原则

- **文件是真相源（Source of Truth）**：所有 Provider 和 Model 的持久化配置首先写入 `providers.yaml`。文件位于用户数据目录 `~/.cloudmind-zome/providers.yaml`（与 `cloudmind.db` 同级），不跟随代码仓库，Tauri 打包升级后不会覆盖。
- **数据库是运行时缓存**：启动时从 yaml 加载到数据库，运行时只读数据库；写操作完成后同时更新 yaml 和数据库。
- **三层归属严格分离**：
  - **Provider 级**：网络/认证（base_url, api_key, auth_mode, custom_headers, timeout, retries, rate_limit）
  - **Model 级**：物理属性（context_window, max_output_tokens, supports_*, pricing）
  - **Agent 级**：行为偏好（temperature, top_p, provider_id, model_id）—— 不存储在 yaml 中，存 Agent 表

### 1.2 完整 YAML Schema（示例 + 注释）

```yaml
# providers.yaml
# 位于 ~/.cloudmind-zome/providers.yaml（用户数据目录）
# 这是 CloudMind-Zome 的 Provider 与模型配置文件。
# 启动时会被加载到数据库 ComputeProvider + LLMModel 表中。
# 用户可通过前端「算力中枢」修改，修改后自动回写此文件。

_version: 2              # 配置文件版本号，用于迁移识别
last_modified: "2026-06-09T14:30:00+08:00"  # 最后修改时间（ISO 8601）

# ─────────────────────────────────────────────
# 内置 Provider 模板
# 这些 Provider 的 is_builtin=true，用户只能编辑部分字段（如 api_key），
# 不能删除内置 Provider 本身，但可以禁用（status=inactive）。
# ─────────────────────────────────────────────
providers:
  # ── OpenAI Compatible（通用模板）──
  - id: "openai-compatible-01"          # 【必填】Provider 唯一标识（UUID 或稳定字符串）
    provider_type: "openai"             # 【必填】Provider 类型，决定 ThinkingProfile 映射
    display_name: "OpenAI 兼容"          # 【必填】前端展示名称
    is_builtin: true                    # 【只读】是否内置模板，内置不可删除
    status: "active"                    # 【可选】active | inactive，默认 active
    description: "通用 OpenAI 兼容接口"   # 【可选】Tooltip 说明文字

    # ── Provider 级：网络/认证 ──
    base_url: "https://api.openai.com/v1"   # 【必填】API 基础地址，末尾可带 /v1
    auth_mode: "api_key"                # 【可选】api_key | bearer | none，默认 api_key
    api_key_encrypted: "..."            # 【条件必填】auth_mode!=none 时必须存在
    custom_headers:                     # 【可选】额外请求头，键值对形式
      "X-Custom-Header": "value"
    request_timeout: 120.0              # 【可选】单次请求超时（秒），默认 120.0
    max_retries: 3                      # 【可选】失败重试次数，默认 3
    rate_limit_qpm: 60                  # 【可选】每分钟请求配额，用于引擎限流，默认 0（不限）
    require_api_key: true               # 【可选】是否必须填写 API Key，默认 true

    # ── 关联模型列表 ──
    models:
      - id: "gpt-4o"                    # 【必填】模型唯一标识（在 Provider 内唯一）
        display_name: "GPT-4o"          # 【必填】前端展示名称
        is_builtin: true                # 【只读】是否内置
        status: "active"                # 【可选】active | inactive，默认 active

        # ── Model 级：物理属性 ──
        context_window: 128000          # 【必填】上下文窗口大小（token 数）
        max_output_tokens: 4096         # 【必填】最大输出 token 数
        supports_multimodal: true       # 【可选】是否支持图文输入，默认 false
        input_modalities: ["text", "image"]   # 【可选】支持的输入模态列表
        output_modalities: ["text"]     # 【可选】支持的输出模态列表
        supports_streaming: true        # 【可选】是否支持流式输出，默认 true
        supports_tool_calling: true     # 【可选】是否支持 Function Calling，默认 false
        supports_reasoning: false       # 【可选】是否输出 reasoning_content，默认 false

        # ── 计费信息（可选，用于用量估算）──
        pricing:
          input_per_1m_tokens: 5.0      # 每百万输入 token 价格（USD）
          output_per_1m_tokens: 15.0    # 每百万输出 token 价格（USD）
          currency: "USD"               # 币种

      - id: "gpt-4o-mini"
        display_name: "GPT-4o Mini"
        is_builtin: true
        context_window: 128000
        max_output_tokens: 16384
        supports_multimodal: true
        input_modalities: ["text", "image"]
        output_modalities: ["text"]
        supports_tool_calling: true
        pricing:
          input_per_1m_tokens: 0.15
          output_per_1m_tokens: 0.6

  # ── DeepSeek（官方）──
  - id: "deepseek-official"
    provider_type: "deepseek"
    display_name: "DeepSeek 官方"
    is_builtin: true
    status: "active"
    description: "DeepSeek 官方 API，支持深度思考模式"

    base_url: "https://api.deepseek.com/v1"
    auth_mode: "api_key"
    api_key_encrypted: "..."
    request_timeout: 180.0              # DeepSeek 推理较长，建议 180s
    max_retries: 3
    rate_limit_qpm: 120

    models:
      - id: "deepseek-v4-pro"
        display_name: "DeepSeek V4 Pro"
        context_window: 64000
        max_output_tokens: 8192
        supports_reasoning: true        # DeepSeek 输出 reasoning_content
        supports_tool_calling: true
        pricing:
          input_per_1m_tokens: 2.0
          output_per_1m_tokens: 8.0

      - id: "deepseek-chat"
        display_name: "DeepSeek Chat"
        context_window: 64000
        max_output_tokens: 4096
        supports_reasoning: false
        pricing:
          input_per_1m_tokens: 1.0
          output_per_1m_tokens: 2.0

  # ── Ollama（本地模型）──
  - id: "ollama-local"
    provider_type: "ollama"
    display_name: "Ollama 本地"
    is_builtin: true
    status: "active"
    description: "本地运行的 Ollama 服务，无需 API Key"

    base_url: "http://localhost:11434/v1"
    auth_mode: "none"                   # 本地服务通常不需要认证
    require_api_key: false
    request_timeout: 300.0              # 本地模型推理慢，超时放宽
    max_retries: 1
    rate_limit_qpm: 0                   # 本地不限流

    models:
      - id: "llama3.1:8b"
        display_name: "Llama 3.1 8B"
        context_window: 128000
        max_output_tokens: 4096
        supports_tool_calling: true
        pricing:                          # 本地运行，价格为 0
          input_per_1m_tokens: 0.0
          output_per_1m_tokens: 0.0

  # ── LM Studio（本地兼容）──
  - id: "lmstudio-local"
    provider_type: "openai"             # LM Studio 是 OpenAI 兼容接口
    display_name: "LM Studio"
    is_builtin: true
    status: "active"
    base_url: "http://localhost:1234/v1"
    auth_mode: "none"
    require_api_key: false
    request_timeout: 300.0

    models: []                          # 本地模型动态发现，初始为空

# ─────────────────────────────────────────────
# 用户自定义 Provider 示例
# 用户通过「算力中枢」添加的 Provider 会追加到该列表末尾。
# ─────────────────────────────────────────────
  - id: "custom-siliconflow-01"         # 自动生成 UUID，或用户可修改的短 ID
    provider_type: "openai"             # 用户选择最接近的类型（影响 ThinkingProfile）
    display_name: "SiliconFlow"
    is_builtin: false                   # 用户自定义
    status: "active"

    base_url: "https://api.siliconflow.cn/v1"
    auth_mode: "api_key"
    api_key_encrypted: "..."
    request_timeout: 120.0
    max_retries: 3
    rate_limit_qpm: 60

    models:
      - id: "deepseek-ai/DeepSeek-V2.5"
        display_name: "DeepSeek V2.5"
        context_window: 128000
        max_output_tokens: 4096
        supports_reasoning: false
        pricing:
          input_per_1m_tokens: 1.33
          output_per_1m_tokens: 1.33
```

### 1.3 Pydantic Model 定义

```python
# backend/app/core/provider_schema.py
from pydantic import BaseModel, Field, HttpUrl, field_validator
from typing import Literal, Optional
from datetime import datetime

class PricingInfo(BaseModel):
    """模型计费信息（面向用户的用量估算）"""
    input_per_1m_tokens: float = Field(default=0.0, ge=0, description="每百万输入 token 价格")
    output_per_1m_tokens: float = Field(default=0.0, ge=0, description="每百万输出 token 价格")
    currency: str = Field(default="USD", description="币种")

class ModelConfig(BaseModel):
    """Model 级配置：物理属性"""
    id: str = Field(..., min_length=1, description="模型唯一标识（Provider 内唯一）")
    display_name: str = Field(..., min_length=1, description="前端展示名称")
    is_builtin: bool = Field(default=False, description="是否内置模板")
    status: Literal["active", "inactive"] = Field(default="active", description="模型状态")

    # 物理属性
    context_window: int = Field(..., gt=0, description="上下文窗口大小（token）")
    max_output_tokens: int = Field(..., gt=0, description="最大输出 token 数")
    supports_multimodal: bool = Field(default=False, description="是否支持多模态输入")
    input_modalities: list[str] = Field(default=["text"], description="支持的输入模态")
    output_modalities: list[str] = Field(default=["text"], description="支持的输出模态")
    supports_streaming: bool = Field(default=True, description="是否支持流式输出")
    supports_tool_calling: bool = Field(default=False, description="是否支持 Function Calling")
    supports_reasoning: bool = Field(default=False, description="是否输出 reasoning_content")

    pricing: Optional[PricingInfo] = Field(default=None, description="计费信息")

class ProviderConfig(BaseModel):
    """Provider 级配置：网络/认证"""
    id: str = Field(..., min_length=1, description="Provider 唯一标识（全局唯一）")
    provider_type: str = Field(..., min_length=1, description="Provider 类型，映射到 ThinkingProfile")
    display_name: str = Field(..., min_length=1, description="前端展示名称")
    is_builtin: bool = Field(default=False, description="是否内置，内置不可删除")
    status: Literal["active", "inactive"] = Field(default="active", description="Provider 状态")
    description: Optional[str] = Field(default=None, description="Tooltip 说明文字")

    # 网络/认证
    base_url: str = Field(..., min_length=1, description="API 基础地址")
    auth_mode: Literal["api_key", "bearer", "none"] = Field(default="api_key", description="认证模式")
    api_key_encrypted: Optional[str] = Field(default=None, description="加密后的 API Key")
    custom_headers: dict[str, str] = Field(default_factory=dict, description="额外请求头")
    request_timeout: float = Field(default=120.0, gt=0, description="请求超时（秒）")
    max_retries: int = Field(default=3, ge=0, description="失败重试次数")
    rate_limit_qpm: int = Field(default=0, ge=0, description="每分钟请求配额，0 表示不限")
    require_api_key: bool = Field(default=True, description="是否必须提供 API Key")

    models: list[ModelConfig] = Field(default_factory=list, description="关联模型列表")

    @field_validator("api_key_encrypted")
    @classmethod
    def validate_api_key(cls, v, info):
        # auth_mode != none 时，api_key_encrypted 不能为空
        data = info.data
        if data.get("auth_mode") != "none" and not v:
            raise ValueError("auth_mode 不为 none 时，api_key_encrypted 必填")
        return v

class ProvidersYaml(BaseModel):
    """providers.yaml 根结构"""
    _version: int = Field(default=2, description="配置文件版本号")
    last_modified: Optional[datetime] = Field(default=None, description="最后修改时间")
    providers: list[ProviderConfig] = Field(..., description="Provider 列表")
```

### 1.4 字段校验规则汇总

| 字段 | 类型 | 必填 | 默认值 | 校验规则 | 面向用户的说明 |
|------|------|------|--------|----------|--------------|
| `id` | str | ✅ | — | 全局唯一，1-64 字符 | Provider 的唯一编号，删除后重新添加会生成新 ID |
| `provider_type` | str | ✅ | — | 小写字母+下划线 | 决定该 Provider 使用哪种思考模式解析响应 |
| `display_name` | str | ✅ | — | 1-64 字符 | 你在界面上看到的中文名称 |
| `base_url` | str | ✅ | — | 合法 URL，末尾可带 /v1 | API 服务器地址，如 `https://api.deepseek.com/v1` |
| `auth_mode` | enum | ❌ | `api_key` | `api_key` / `bearer` / `none` | 认证方式：密钥 / Bearer Token / 无需认证 |
| `api_key_encrypted` | str | 条件 | — | auth_mode!=none 时必填 | 你的 API Key（前端输入明文，保存时自动加密） |
| `request_timeout` | float | ❌ | 120.0 | > 0 | 等待模型响应的最长时间（秒），本地模型建议 300 |
| `max_retries` | int | ❌ | 3 | ≥ 0 | 网络错误时自动重试次数 |
| `rate_limit_qpm` | int | ❌ | 0 | ≥ 0 | 每分钟最多请求次数，0 表示不限制 |
| `custom_headers` | dict | ❌ | `{}` | 键值对均为字符串 | 需要额外携带的 HTTP 请求头 |
| `models[].id` | str | ✅ | — | Provider 内唯一 | 模型标识，如 `deepseek-v4-pro` |
| `models[].context_window` | int | ✅ | — | > 0 | 该模型一次能处理的最大上下文长度 |
| `models[].max_output_tokens` | int | ✅ | — | > 0 | 该模型一次最多输出多少 token |
| `models[].supports_reasoning` | bool | ❌ | false | — | 是否显示「已思考 X 字」的推理过程 |
| `models[].supports_tool_calling` | bool | ❌ | false | — | 是否支持调用工具（如搜索、画图） |
| `models[].supports_multimodal` | bool | ❌ | false | — | 是否支持发送图片给模型 |

---

## 2. 数据库 Schema 变更

### 2.1 ComputeProvider 表（扩展）

**当前表**（`backend/app/models/compute.py`）已有字段保持不变，新增以下字段：

```python
class ComputeProvider(Base):
    __tablename__ = "compute_providers"

    # 已有字段（保持不变）
    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    user_id: Mapped[str] = mapped_column(String(64), ForeignKey("users.id"), nullable=False)
    provider_type: Mapped[str] = mapped_column(String(32), nullable=False)
    display_name: Mapped[str] = mapped_column(String(128), nullable=False)
    api_key_encrypted: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    config: Mapped[Optional[dict]] = mapped_column(JSON, default=dict)  # 保留兼容旧数据
    quota_total: Mapped[int] = mapped_column(BigInteger, default=0)
    quota_used: Mapped[int] = mapped_column(BigInteger, default=0)
    quota_remaining: Mapped[int] = mapped_column(BigInteger, default=0)
    expires_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)
    status: Mapped[str] = mapped_column(String(16), default="active")
    last_sync_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=func.now())
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=func.now(), onupdate=func.now())

    # ── 新增字段（与 provider-refactor-audit.md 第 7 节对照）──

    # 认证与网络（Provider 级）
    base_url: Mapped[Optional[str]] = mapped_column(String(512), nullable=True,
        comment="API 基础地址，如 https://api.deepseek.com/v1")
    auth_mode: Mapped[str] = mapped_column(String(16), default="api_key",
        comment="api_key | bearer | none")
    custom_headers: Mapped[Optional[dict]] = mapped_column(JSON, nullable=True,
        comment="额外 HTTP 请求头，键值对")
    request_timeout: Mapped[float] = mapped_column(Float, default=120.0,
        comment="单次请求超时（秒）")
    max_retries: Mapped[int] = mapped_column(Integer, default=3,
        comment="失败重试次数")
    rate_limit_qpm: Mapped[int] = mapped_column(Integer, default=0,
        comment="每分钟请求配额，0 为不限")
    require_api_key: Mapped[bool] = mapped_column(Boolean, default=True,
        comment="是否必须提供 API Key")
    is_builtin: Mapped[bool] = mapped_column(Boolean, default=False,
        comment="是否内置 Provider，内置不可删除")
    description: Mapped[Optional[str]] = mapped_column(Text, nullable=True,
        comment="面向用户的 Tooltip 说明")

    # 关系：一对多 → LLMModel
    models: Mapped[list["LLMModel"]] = relationship("LLMModel", back_populates="provider",
        cascade="all, delete-orphan", lazy="selectin")
```

**与审计报告的对照**：

| 审计报告建议字段 | 数据库字段 | 说明 |
|----------------|------------|------|
| `auth_mode` | `auth_mode` | ✅ 新增 |
| `custom_headers` | `custom_headers` (JSON) | ✅ 新增 |
| `is_builtin` | `is_builtin` | ✅ 新增 |
| `require_api_key` | `require_api_key` | ✅ 新增 |
| `request_timeout` | `request_timeout` | ✅ 新增 |
| `max_retries` | `max_retries` | ✅ 新增 |
| `rate_limit_qpm` | `rate_limit_qpm` | ✅ 新增 |

> **关于 `config` 字段的兼容**：旧数据中的 `config` 字段仍保留，迁移时将 `config.base_url` 提取到 `base_url` 列，`config.models` 提取到独立的 `LLMModel` 表。新写入时 `config` 逐步置为空或保留为 `{}`。

### 2.2 新建 LLMModel 表（独立 Model 表，关联 Provider）

```python
class LLMModel(Base):
    __tablename__ = "llm_models"

    id: Mapped[str] = mapped_column(String(64), primary_key=True,
        comment="模型唯一标识（在 Provider 内唯一，格式：provider_id::model_id）")
    provider_id: Mapped[str] = mapped_column(String(64), ForeignKey("compute_providers.id"), nullable=False)
    user_id: Mapped[str] = mapped_column(String(64), ForeignKey("users.id"), nullable=False)

    display_name: Mapped[str] = mapped_column(String(128), nullable=False,
        comment="前端展示名称，如 DeepSeek V4 Pro")
    is_builtin: Mapped[bool] = mapped_column(Boolean, default=False,
        comment="是否内置模型")
    status: Mapped[str] = mapped_column(String(16), default="active",
        comment="active | inactive")

    # Model 级：物理属性
    context_window: Mapped[int] = mapped_column(Integer, nullable=False,
        comment="上下文窗口大小（token），如 128000")
    max_output_tokens: Mapped[int] = mapped_column(Integer, nullable=False,
        comment="单次最大输出 token 数，如 4096")
    supports_multimodal: Mapped[bool] = mapped_column(Boolean, default=False,
        comment="是否支持图文输入")
    input_modalities: Mapped[Optional[list]] = mapped_column(JSON, nullable=True,
        comment="支持的输入模态列表，如 [text, image]")
    output_modalities: Mapped[Optional[list]] = mapped_column(JSON, nullable=True,
        comment="支持的输出模态列表，如 [text]")
    supports_streaming: Mapped[bool] = mapped_column(Boolean, default=True,
        comment="是否支持流式输出")
    supports_tool_calling: Mapped[bool] = mapped_column(Boolean, default=False,
        comment="是否支持 Function Calling")
    supports_reasoning: Mapped[bool] = mapped_column(Boolean, default=False,
        comment="是否输出 reasoning_content")

    # 计费信息（JSON 结构，兼容 PricingInfo schema）
    pricing: Mapped[Optional[dict]] = mapped_column(JSON, nullable=True,
        comment="计费信息：{input_per_1m_tokens, output_per_1m_tokens, currency}")

    created_at: Mapped[datetime] = mapped_column(DateTime, default=func.now())
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=func.now(), onupdate=func.now())

    # 关系
    provider: Mapped["ComputeProvider"] = relationship("ComputeProvider", back_populates="models")
```

**主键设计说明**：
- `id` 采用复合语义键 `"provider_id::model_id"`（如 `deepseek-official::deepseek-v4-pro`），而非 UUID。
- 理由：模型 ID 在 Provider 内天然唯一，且 FallbackChain、Agent 配置中需要可读性强的稳定标识。
- 前端展示时使用 `display_name`。

### 2.3 Agent 表新增字段（拆分 model_config JSON）

```python
class Agent(Base):
    __tablename__ = "agents"

    # 已有字段（保持不变）
    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    user_id: Mapped[str] = mapped_column(String(64), ForeignKey("users.id"), nullable=False)
    name: Mapped[str] = mapped_column(String(128), nullable=False)
    # ... 其他已有字段 ...

    # 已有 JSON 字段（过渡期内保留，逐步废弃）
    model_config: Mapped[Optional[dict]] = mapped_column(JSON, default=dict,
        comment="【已废弃，过渡期兼容】旧版 LLM 配置万能桶")

    # ── 新增独立字段（Agent 级：行为偏好 + 指向关系）──
    # 主推理模型
    provider_id: Mapped[Optional[str]] = mapped_column(String(64), ForeignKey("compute_providers.id"), nullable=True,
        comment="主 Provider ID")
    model_id: Mapped[Optional[str]] = mapped_column(String(64), nullable=True,
        comment="主 Model ID（在 Provider 内唯一）")

    # Agent 级行为参数
    temperature: Mapped[Optional[float]] = mapped_column(Float, nullable=True,
        comment="采样温度，0-2，越高输出越随机")
    top_p: Mapped[Optional[float]] = mapped_column(Float, nullable=True,
        comment="核采样阈值，0-1")

    # 独立 Marker 模型（替代 model_config.marker）
    marker_provider_id: Mapped[Optional[str]] = mapped_column(String(64), ForeignKey("compute_providers.id"), nullable=True,
        comment="话题标注专用 Provider")
    marker_model_id: Mapped[Optional[str]] = mapped_column(String(64), nullable=True,
        comment="话题标注专用 Model")

    # 独立 Embedder 模型（替代 model_config.embedder）
    embedder_provider_id: Mapped[Optional[str]] = mapped_column(String(64), ForeignKey("compute_providers.id"), nullable=True,
        comment="嵌入模型 Provider")
    embedder_model_id: Mapped[Optional[str]] = mapped_column(String(64), nullable=True,
        comment="嵌入模型 Model")

    # 独立 Compressor 模型（替代 model_config.compressor）
    compressor_provider_id: Mapped[Optional[str]] = mapped_column(String(64), ForeignKey("compute_providers.id"), nullable=True,
        comment="记忆压缩专用 Provider")
    compressor_model_id: Mapped[Optional[str]] = mapped_column(String(64), nullable=True,
        comment="记忆压缩专用 Model")

    # Fallback 链（替代 model_config.fallback_chain）
    fallback_chain: Mapped[Optional[list]] = mapped_column(JSON, nullable=True,
        comment="降级链：[{provider_id, model_id, display_name}]")

    # 人格参数（从 model_config.personality 迁移）
    personality: Mapped[Optional[dict]] = mapped_column(JSON, nullable=True,
        comment="人格参数：{extraversion, talkativeness, ...}")

    # 上下文窗口覆盖（可选，默认从 Model 表读取）
    max_context_tokens: Mapped[Optional[int]] = mapped_column(Integer, nullable=True,
        comment="覆盖 Model 表的上下文限制（用户自定义上限）")
```

### 2.4 数据库迁移脚本设计

**迁移脚本**：`backend/alembic/versions/xxx_provider_refactor.py`

```python
"""
Provider 子系统重做迁移脚本
- 扩展 ComputeProvider 表（新增 9 个字段）
- 新建 LLMModel 表
- 扩展 Agent 表（新增 12 个字段）
- 数据迁移：ComputeProvider.config → 平铺字段 + LLMModel 记录
- 数据迁移：Agent.model_config → 独立字段
"""

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

# revision identifiers
revision = "xxx"
down_revision = "yyy"
branch_labels = None
depends_on = None


def upgrade():
    # ── 1. 扩展 ComputeProvider 表 ──
    op.add_column("compute_providers", sa.Column("base_url", sa.String(512), nullable=True))
    op.add_column("compute_providers", sa.Column("auth_mode", sa.String(16), server_default="api_key"))
    op.add_column("compute_providers", sa.Column("custom_headers", postgresql.JSONB, nullable=True))
    op.add_column("compute_providers", sa.Column("request_timeout", sa.Float, server_default="120.0"))
    op.add_column("compute_providers", sa.Column("max_retries", sa.Integer, server_default="3"))
    op.add_column("compute_providers", sa.Column("rate_limit_qpm", sa.Integer, server_default="0"))
    op.add_column("compute_providers", sa.Column("require_api_key", sa.Boolean, server_default="true"))
    op.add_column("compute_providers", sa.Column("is_builtin", sa.Boolean, server_default="false"))
    op.add_column("compute_providers", sa.Column("description", sa.Text, nullable=True))

    # ── 2. 新建 LLMModel 表 ──
    op.create_table(
        "llm_models",
        sa.Column("id", sa.String(64), primary_key=True, comment="provider_id::model_id"),
        sa.Column("provider_id", sa.String(64), sa.ForeignKey("compute_providers.id"), nullable=False),
        sa.Column("user_id", sa.String(64), sa.ForeignKey("users.id"), nullable=False),
        sa.Column("display_name", sa.String(128), nullable=False),
        sa.Column("is_builtin", sa.Boolean, server_default="false"),
        sa.Column("status", sa.String(16), server_default="active"),
        sa.Column("context_window", sa.Integer, nullable=False),
        sa.Column("max_output_tokens", sa.Integer, nullable=False),
        sa.Column("supports_multimodal", sa.Boolean, server_default="false"),
        sa.Column("input_modalities", postgresql.JSONB, nullable=True),
        sa.Column("output_modalities", postgresql.JSONB, nullable=True),
        sa.Column("supports_streaming", sa.Boolean, server_default="true"),
        sa.Column("supports_tool_calling", sa.Boolean, server_default="false"),
        sa.Column("supports_reasoning", sa.Boolean, server_default="false"),
        sa.Column("pricing", postgresql.JSONB, nullable=True),
        sa.Column("created_at", sa.DateTime, server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime, server_default=sa.func.now(), onupdate=sa.func.now()),
    )
    op.create_index("idx_llm_models_provider", "llm_models", ["provider_id"])
    op.create_index("idx_llm_models_user", "llm_models", ["user_id"])

    # ── 3. 扩展 Agent 表 ──
    op.add_column("agents", sa.Column("provider_id", sa.String(64), sa.ForeignKey("compute_providers.id"), nullable=True))
    op.add_column("agents", sa.Column("model_id", sa.String(64), nullable=True))
    op.add_column("agents", sa.Column("temperature", sa.Float, nullable=True))
    op.add_column("agents", sa.Column("top_p", sa.Float, nullable=True))
    op.add_column("agents", sa.Column("marker_provider_id", sa.String(64), sa.ForeignKey("compute_providers.id"), nullable=True))
    op.add_column("agents", sa.Column("marker_model_id", sa.String(64), nullable=True))
    op.add_column("agents", sa.Column("embedder_provider_id", sa.String(64), sa.ForeignKey("compute_providers.id"), nullable=True))
    op.add_column("agents", sa.Column("embedder_model_id", sa.String(64), nullable=True))
    op.add_column("agents", sa.Column("compressor_provider_id", sa.String(64), sa.ForeignKey("compute_providers.id"), nullable=True))
    op.add_column("agents", sa.Column("compressor_model_id", sa.String(64), nullable=True))
    op.add_column("agents", sa.Column("fallback_chain", postgresql.JSONB, nullable=True))
    op.add_column("agents", sa.Column("personality", postgresql.JSONB, nullable=True))
    op.add_column("agents", sa.Column("max_context_tokens", sa.Integer, nullable=True))

    # ── 4. 数据迁移（Python 逻辑，在 batch 1 的启动脚本中执行更稳妥）──
    # 注：Alembic 中只做 Schema 变更，数据迁移在 app/main.py 的启动脚本中执行
    # 原因：数据迁移需要读取 config.yaml、解密 api_key、解析 JSON，逻辑较复杂


def downgrade():
    # 删除新增字段和表（回滚谨慎）
    op.drop_table("llm_models")
    # ... 逐个删除 Agent 和 ComputeProvider 的新增列 ...
```

**数据迁移策略**：Schema 变更由 Alembic 执行；数据迁移（config.yaml → DB、Agent.model_config 拆分）由 `app/main.py` 启动时的 Python 脚本执行，便于调试、打日志、失败回退。

---

## 3. 启动流程

### 3.1 完整启动流程图

```
┌─────────────────────────────────────────────────────────────┐
│  app.main.py lifespan start                                  │
│                                                              │
│  1. 加载 ~/.cloudmind-zome/providers.yaml                   │
│     └─→ 若文件不存在：从 config.yaml 的 provider.* 迁移生成    │
│         └─→ 若 config.yaml 也不存在：创建默认内置 Provider     │
│                                                              │
│  2. Pydantic 校验 (ProvidersYaml)                           │
│     └─→ 失败：打印详细错误日志，启动中断（fail-fast）          │
│         成功：继续                                            │
│                                                              │
│  3. 幂等 Upsert 到数据库                                     │
│     ├─→ 遍历 yaml.providers[]                               │
│     │   ├─→ ComputeProvider：按 provider.id 匹配 upsert      │
│     │   └─→ LLMModel：按 "provider_id::model_id" 匹配 upsert │
│     │                                                        │
│     └─→ 删除数据库中 yaml 里已不存在的自定义 Provider/Model    │
│         （内置的标记为 inactive 而非物理删除）                 │
│                                                              │
│  4. 旧 config.yaml 数据迁移（仅首次）                         │
│     ├─→ 读取 config.yaml provider.* 段                        │
│     ├─→ 转换为 ProviderConfig + ModelConfig                  │
│     ├─→ api_key 从 base64 升级为新加密                        │
│     └─→ 写入 providers.yaml，然后删除 config.yaml 中的 provider│
│                                                              │
│  5. Agent.model_config 拆分迁移（仅首次）                     │
│     ├─→ 遍历所有 Agent，读取 model_config JSON                │
│     ├─→ 提取 provider_id, model_id, temperature...           │
│     ├─→ 按 provider name 反向查找 ComputeProvider.id         │
│     └─→ 写入新独立字段，保留原 JSON 作为备份                   │
│                                                              │
│  6. 生成迁移报告日志                                          │
│     └─→ INFO 级别输出迁移统计（Provider/Model/Agent 数量）     │
└─────────────────────────────────────────────────────────────┘
```

### 3.2 首次启动时从旧 config.yaml 迁移的逻辑

```python
# backend/app/services/provider_migration.py

async def migrate_from_legacy_config(
    yaml_path: Path,
    legacy_config_path: Path,
    db: AsyncSession
) -> MigrationReport:
    """
    从旧 config.yaml 迁移 Provider 配置到 ~/.cloudmind-zome/providers.yaml。
    只执行一次：检测 providers.yaml 不存在且 config.yaml 存在 provider.* 时触发。
    """
    if yaml_path.exists():
        return MigrationReport(skipped=True, reason="providers.yaml 已存在")

    if not legacy_config_path.exists():
        return MigrationReport(skipped=True, reason="config.yaml 不存在，创建默认内置 Provider")

    raw = yaml.safe_load(legacy_config_path.read_text("utf-8"))
    legacy_providers = raw.get("provider", {})

    if not legacy_providers:
        return MigrationReport(skipped=True, reason="config.yaml 中没有 provider 配置")

    providers: list[ProviderConfig] = []
    for name, cfg in legacy_providers.items():
        # name: "deepseek", "mimo", "kimicode", "glm"
        # cfg: {base_url, model, api_key}
        provider = ProviderConfig(
            id=f"legacy-{name}",
            provider_type=name,
            display_name=name.capitalize(),
            is_builtin=False,  # 旧配置视为用户自定义
            base_url=cfg.get("base_url", ""),
            auth_mode="api_key",
            api_key_encrypted=await crypto.encrypt_value(cfg.get("api_key", "")),
            request_timeout=120.0,
            max_retries=3,
            models=[
                ModelConfig(
                    id=cfg.get("model", "unknown"),
                    display_name=cfg.get("model", "unknown"),
                    context_window=64000,  # 默认值
                    max_output_tokens=4096,
                )
            ]
        )
        providers.append(provider)

    # 写入 ~/.cloudmind-zome/providers.yaml
    root = ProvidersYaml(providers=providers)
    yaml_path.write_text(root.model_dump_yaml(), encoding="utf-8")

    return MigrationReport(
        skipped=False,
        migrated_providers=len(providers),
        migrated_models=sum(len(p.models) for p in providers)
    )
```

### 3.3 Upsert 策略

**Provider 的 Upsert Key**：`ComputeProvider.id`（全局唯一，与 yaml 中的 `provider.id` 对应）。

**LLMModel 的 Upsert Key**：`LLMModel.id` = `"provider_id::model_id"`。

**幂等规则**：

| 场景 | 行为 |
|------|------|
| yaml 有，DB 无 | INSERT |
| yaml 有，DB 有，且 yaml.last_modified > DB.updated_at | UPDATE（以 yaml 为准） |
| yaml 有，DB 有，且 yaml.last_modified ≤ DB.updated_at | SKIP（DB 更新，可能是运行时修改未回写） |
| yaml 无，DB 有，且 DB.is_builtin=False | DELETE（用户删除了自定义 Provider） |
| yaml 无，DB 有，且 DB.is_builtin=True | UPDATE status='inactive'（内置 Provider 不可物理删除） |

**冲突检测**：
- 启动时如果发现某个 Provider 在 yaml 和 DB 中的 `api_key_encrypted` 不一致（可能是外部手动编辑了 yaml），以 yaml 为准并打 WARN 日志。
- 如果 yaml 格式错误，启动失败（fail-fast），提示用户修正 yaml。

### 3.4 错误处理

| 错误类型 | 处理策略 | 日志级别 |
|----------|----------|----------|
| YAML 格式错误（SyntaxError） | 启动中断，打印文件路径和行号 | ERROR |
| Pydantic 校验失败（必填字段缺失） | 启动中断，打印具体字段和错误信息 | ERROR |
| 单个 Provider 校验失败 | 跳过该 Provider，启动继续，其他 Provider 正常加载 | WARN |
| 数据库连接失败 | 启动中断 | ERROR |
| 旧 config.yaml 迁移失败（单条） | 跳过该 Provider，记录失败原因，启动继续 | WARN |
| Agent.model_config 拆分失败（单条） | 跳过该 Agent，保留原 JSON，启动继续 | WARN |
| api_key 加密升级失败（旧 base64 损坏） | 将 api_key 置空，标记 Provider 状态为 error，启动继续 | WARN |

---

## 4. 双写一致性

### 4.1 写入顺序

**推荐顺序：先写 YAML，后写数据库。**

```
前端 CRUD 请求
    │
    ▼
┌─────────────────┐
│ 1. 更新内存中的  │
│    ProvidersYaml │
│    对象          │
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│ 2. 原子写入      │
│    providers.yaml│
│    （临时文件 +   │
│     rename）     │
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│ 3. Pydantic 校验 │
│    写入后的 yaml │
│    （自校验）    │
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│ 4. Upsert 到    │
│    数据库        │
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│ 5. 返回成功响应  │
└─────────────────┘
```

**理由**：
- YAML 是真相源，必须先保证其正确写入。
- 步骤 2 使用临时文件 + `os.replace()` 保证原子性，避免写一半崩溃导致 yaml 损坏。
- 步骤 3 的自校验确保写入后的 yaml 能被正确读取，防止写入 bug。
- 数据库写入失败时，yaml 已是最新状态，下次启动会自动重试同步到数据库。

### 4.2 冲突处理：YAML 被外部编辑后与数据库不一致

**场景**：用户用文本编辑器直接修改了 `providers.yaml`，但没有重启服务。

**检测机制**：
- 每次前端请求 Provider 列表时，比较 `providers.yaml` 的 `last_modified` 与内存中缓存的时间戳。
- 如果 yaml 文件mtime更新，触发**热重载**：重新执行「Pydantic 校验 → 幂等 Upsert」流程。

**热重载限制**：
- 运行中的 AgentWorker 不会自动感知 Provider 配置变更（详见风险评估）。
- 热重载只更新数据库缓存，已运行的 Worker 需要重新启动 Agent 才能生效。

### 4.3 是否需要文件锁

**结论：需要，但采用乐观策略。**

```python
# backend/app/core/provider_store.py

import portalocker
from contextlib import contextmanager
from pathlib import Path

@contextmanager
def _yaml_write_lock(yaml_path: Path):
    """跨进程写锁：使用 portalocker 防止多 worker/多实例同时写入 providers.yaml"""
    lock_path = yaml_path.with_suffix(".yaml.lock")
    with open(lock_path, "a") as f:
        portalocker.lock(f, portalocker.LOCK_EX)  # 独占锁，跨平台
        yield
```

**使用场景**：
- 写 YAML 时必须持有锁。
- 读 YAML 时不需要锁（YAML 写入是原子 rename，读操作要么读到旧版本，要么读到新版本，不会读到半成品）。

**依赖说明**：
- `portalocker` 是跨平台文件锁库（支持 Windows/Linux/macOS），需加入 `requirements.txt`：`pip install portalocker`。

---

## 5. 后端 API 变更

### 5.1 /api/v1/compute/providers 扩展

**GET /api/v1/compute/providers**

响应体扩展（新增字段 + 嵌套 models）：

```json
{
  "data": [
    {
      "id": "deepseek-official",
      "provider_type": "deepseek",
      "display_name": "DeepSeek 官方",
      "status": "active",
      "is_builtin": true,
      "description": "DeepSeek 官方 API，支持深度思考模式",
      "base_url": "https://api.deepseek.com/v1",
      "auth_mode": "api_key",
      "custom_headers": {},
      "request_timeout": 180.0,
      "max_retries": 3,
      "rate_limit_qpm": 120,
      "require_api_key": true,
      // api_key_encrypted 不返回，只返回 has_api_key: bool
      "has_api_key": true,
      "models": [
        {
          "id": "deepseek-v4-pro",
          "display_name": "DeepSeek V4 Pro",
          "status": "active",
          "context_window": 64000,
          "max_output_tokens": 8192,
          "supports_multimodal": false,
          "supports_streaming": true,
          "supports_tool_calling": true,
          "supports_reasoning": true,
          "pricing": { "input_per_1m_tokens": 2.0, "output_per_1m_tokens": 8.0, "currency": "USD" }
        }
      ],
      "created_at": "2026-06-09T14:30:00",
      "updated_at": "2026-06-09T14:30:00"
    }
  ]
}
```

**POST /api/v1/compute/providers**

- 接收完整 ProviderConfig（不含 models 时可空）。
- 后端自动加密 `api_key`（明文传入，写入前加密）。
- 写入 providers.yaml → 数据库。

**PUT /api/v1/compute/providers/{id}**

- 支持部分更新（`exclude_unset=True`）。
- `api_key` 字段规则：传空字符串表示不修改；传非空字符串则重新加密覆盖。

**DELETE /api/v1/compute/providers/{id}**

- 拒绝删除 `is_builtin=true` 的 Provider（返回 409 Conflict）。
- 删除前校验：是否有 Agent 引用该 Provider（包括主模型、Marker、Embedder、Compressor、FallbackChain）。
- 如有引用，返回 409 + 引用列表，前端提示用户先修改 Agent 配置。

### 5.2 新建 /api/v1/models CRUD API

模型作为独立资源，但依附于 Provider。

**GET /api/v1/models?provider_id={id}**

- 返回某 Provider 下的模型列表（含物理属性）。
- 若 `provider_id` 为空，返回当前用户所有模型（用于全局模型搜索）。

**POST /api/v1/models**

```json
{
  "provider_id": "deepseek-official",
  "id": "deepseek-v4-pro",
  "display_name": "DeepSeek V4 Pro",
  "context_window": 64000,
  "max_output_tokens": 8192,
  "supports_reasoning": true
}
```

- 校验 `provider_id` 存在且属于当前用户。
- 写入 providers.yaml → 数据库。

**PUT /api/v1/models/{provider_id}/{model_id}**

- 部分更新模型属性（如只改 `max_output_tokens`）。

**DELETE /api/v1/models/{provider_id}/{model_id}**

- 删除前校验：是否有 Agent 引用该模型。

> **API 层与数据层 Key 格式差异说明**：
> - **数据库主键**：`LLMModel.id` 使用复合语义键 `"provider_id::model_id"`（如 `deepseek-official::deepseek-v4-pro`），便于 FallbackChain 和内部索引直接引用。
> - **API 路径参数**：REST API 使用两个独立路径参数 `/{provider_id}/{model_id}`，更符合资源层级语义（Model 依附于 Provider），前端调用时无需拼接字符串。
> - 后端在接收到 API 请求后，将两个路径参数拼接为 `"{provider_id}::{model_id}"` 用于数据库查询。

### 5.3 /api/v1/agents/providers 返回值变更

**现状**：返回 Provider 列表 + `models[]` 字符串数组。

**新响应**：

```json
{
  "data": [
    {
      "id": "deepseek-official",
      "display_name": "DeepSeek 官方",
      "provider_type": "deepseek",
      "status": "active",
      "models": [
        {
          "id": "deepseek-v4-pro",
          "display_name": "DeepSeek V4 Pro",
          "context_window": 64000,
          "max_output_tokens": 8192,
          "supports_reasoning": true,
          "supports_tool_calling": true,
          "supports_multimodal": false
        }
      ]
    }
  ]
}
```

**变更点**：
- `models` 从字符串数组变为完整对象数组，前端可直接读取 `context_window` 等物理属性做提示。
- 增加 `provider_type`，用于前端显示能力图标（reasoning/tool/multimodal）。

### 5.4 SystemSettingsPanel 的三个假保存 Tab 处理

根据 `config-system-audit.md` 和 `frontend-ui-audit.md` 的发现：

| Tab | 当前行为 | 处理方案 | 理由 |
|-----|----------|----------|------|
| **LLM** | 保存到 config.yaml，但后端 `_MUTABLE_SECTIONS` 不包含 `"provider"`，被静默丢弃 | **移除**该 Tab，改为底部提示文字「Provider 管理已迁移至「算力中枢」」 | ComputeCenter 已实现真正的 Provider CRUD，SystemSettingsPanel 的硬编码 4 Provider 体系废弃 |
| **Assistant** | 同上，保存到 config.yaml 但后端不接收 | **移除**该 Tab | 无消费方，疑似死配置；如需后台任务模型，改为在 AgentEdit → Compute 中配置 Marker 模型 |
| **Embedding** | 同上，保存到 config.yaml 但后端不接收；实际生效的是 ComputeCenter 的 Embedding 设置 | **移除**该 Tab，改为底部提示文字「Embedding 配置请前往「算力中枢」」 | ComputeCenter 已提供真正的 Embedding 配置入口 |

**保留的 Tab**：`tools`（只读）、`memory`（仍写 config.yaml）、`image`（需评估是否也迁移到 ComputeCenter）。

**过渡期兼容**：
- 若用户打开旧版 SystemSettingsPanel，LLM/Assistant/Embedding Tab 显示 deprecation 提示，并提供「前往算力中枢」按钮。
- 后端 `PUT /config` 的 `_MUTABLE_SECTIONS` 中仍不包含 `"provider"` / `"assistant_model"` / `"embedding_model"`，前端发送了也会被后端拒绝（返回 400 + 明确错误信息，不再静默丢弃）。

---

## 6. 引擎层改造

### 6.1 _PROFILE_MAP 改为动态查找机制

**现状**：`factory.py` 和 `engine_bridge.py` 各有一份硬编码的 `_PROFILE_MAP`，只支持 5 个 Provider 类型。

**新方案**：

```python
# backend/engine/provider/factory.py

from typing import Type
from .thinking.deepseek import DeepSeekThinkingProfile
from .thinking.mimo import MiMoThinkingProfile
from .thinking.kimicode import KimiCodeThinkingProfile
from .thinking.glm import GLMThinkingProfile

# 内置映射： Provider 类型 → ThinkingProfile 类
_BUILTIN_PROFILES: dict[str, Type[ThinkingProfile]] = {
    "deepseek": DeepSeekThinkingProfile,
    "mimo": MiMoThinkingProfile,
    "kimicode": KimiCodeThinkingProfile,
    "glm": GLMThinkingProfile,
    "openai": DeepSeekThinkingProfile,  # OpenAI 兼容格式回退到 DeepSeekProfile（最通用）
    "ollama": DeepSeekThinkingProfile,  # Ollama 也是 OpenAI 兼容接口
}

def resolve_profile(provider_type: str, custom_profile: str | None = None) -> Type[ThinkingProfile]:
    """
    动态解析 ThinkingProfile。
    - 优先使用用户自定义的 profile（来自 Provider 表 thinking_profile 字段，预留）
    - 其次匹配内置映射
    - 未知类型回退到 DeepSeekThinkingProfile（最通用，支持 reasoning + tool_calls）
    """
    if custom_profile and custom_profile in _BUILTIN_PROFILES:
        return _BUILTIN_PROFILES[custom_profile]
    return _BUILTIN_PROFILES.get(provider_type, DeepSeekThinkingProfile)

async def build_transport(
    provider_type: str,
    model_name: str,
    resolve_config: Callable,
    *,
    custom_profile: str | None = None,
) -> ChatCompletionsTransport:
    """工厂函数，engine_bridge.py 和 agent_worker.py 统一调用此函数构建 transport。"""
    profile_cls = resolve_profile(provider_type, custom_profile)
    config = await resolve_config(provider_type)
    # ... 后续逻辑不变
```

**关键变更**：
- 删除 `engine_bridge.py` 中的重复 `_PROFILE_MAP`。
- 未知 Provider 类型不再抛异常，而是回退到 `DeepSeekThinkingProfile`（最通用）。
- 预留 `custom_profile` 字段，未来允许用户在 Provider 配置中显式指定 Profile。

### 6.2 FallbackChain 从 provider name 改为 (provider_id, model_id) 组合

**现状**：`FallbackChain._chain = ["deepseek", "mimo", "kimicode", "glm"]`，`_transports` 以 name 为 key。

**新数据结构**：

```python
# backend/engine/error/fallback.py
from dataclasses import dataclass

@dataclass(frozen=True)
class FallbackNode:
    """Fallback 链中的单个节点"""
    provider_id: str      # 如 "deepseek-official"
    model_id: str         # 如 "deepseek-v4-pro"
    display_name: str = "" # 仅用于日志展示，不参与逻辑

class FallbackChain:
    def __init__(self, chain: list[FallbackNode]):
        self._chain = chain
        self._current_index = 0

    @property
    def current_node(self) -> FallbackNode:
        return self._chain[self._current_index]

    def fallback(self) -> FallbackNode | None:
        if self._current_index >= len(self._chain) - 1:
            return None
        self._current_index += 1
        return self.current_node

    def reset(self) -> None:
        self._current_index = 0
```

**ReActAgent 中的适配**：

```python
# backend/engine/agent/react.py

class ReActAgent:
    def __init__(self, ..., fallback_chain: FallbackChain, transports: dict[str, ChatCompletionsTransport]):
        self._fallback = fallback_chain
        # transports 的 key 改为 "provider_id::model_id"
        self._transports = transports
        self._current_transport = transports.get(self._fallback.current_node.key)

    def _key(self, node: FallbackNode) -> str:
        return f"{node.provider_id}::{node.model_id}"
```

**向后兼容**：Agent 表中的旧 `fallback_chain` 格式 `[{"provider": "deepseek"}]` 仍被支持：

```python
def _parse_fallback_chain(raw: list[dict]) -> list[FallbackNode]:
    nodes = []
    for item in raw:
        if "provider_id" in item and "model_id" in item:
            nodes.append(FallbackNode(provider_id=item["provider_id"], model_id=item["model_id"]))
        elif "provider" in item:
            # 旧格式兼容：按 provider name 查找默认 model
            provider_id = _legacy_name_to_id(item["provider"])  # 查 ComputeProvider 表
            model_id = _get_default_model(provider_id)
            nodes.append(FallbackNode(provider_id=provider_id, model_id=model_id))
            logger.warning(f"FallbackChain 使用旧格式 'provider'，已自动转换为 ({provider_id}, {model_id})")
    return nodes
```

### 6.3 ChatCompletionsTransport 支持动态参数

**现状**：`timeout=120.0` 和 `max_retries=3` 硬编码在 `__init__` 中。

**新签名**：

```python
# backend/engine/provider/transport.py

class ChatCompletionsTransport:
    def __init__(
        self,
        *,
        model: str,
        base_url: str,
        api_key: str | None,
        profile: ThinkingProfile,
        # 新增动态参数
        auth_mode: Literal["api_key", "bearer", "none"] = "api_key",
        custom_headers: dict[str, str] | None = None,
        request_timeout: float = 120.0,
        max_retries: int = 3,
        rate_limit_qpm: int = 0,
    ):
        self.model = model
        self.profile = profile
        self.request_timeout = request_timeout
        self.max_retries = max_retries

        # 认证头处理
        headers = dict(custom_headers) if custom_headers else {}
        if auth_mode == "api_key" and api_key:
            headers["Authorization"] = f"Bearer {api_key}"
        elif auth_mode == "bearer" and api_key:
            headers["Authorization"] = f"Bearer {api_key}"
        # auth_mode == "none": 不添加认证头

        self._client = AsyncOpenAI(
            base_url=base_url,
            api_key=api_key if auth_mode != "none" else "sk-dummy",  # AsyncOpenAI 需要非空字符串
            timeout=request_timeout,
            max_retries=max_retries,
            default_headers=headers,
        )
```

### 6.4 provider_resolver.py 公共函数设计

**新建文件**：`backend/app/services/provider_resolver.py`

**目标**：统一所有 Provider 查表 + 解密 + 返回 credentials 的逻辑，替代当前 4 处分散的重复代码。

```python
# backend/app/services/provider_resolver.py

from app.models import ComputeProvider, LLMModel
from app.core.crypto import decrypt_value
from typing import NamedTuple

class ResolvedCredentials(NamedTuple):
    provider_id: str
    provider_type: str
    model_id: str
    base_url: str
    api_key: str | None
    auth_mode: str
    custom_headers: dict[str, str]
    request_timeout: float
    max_retries: int

class ResolvedModel(NamedTuple):
    model_id: str
    display_name: str
    context_window: int
    max_output_tokens: int
    supports_reasoning: bool
    supports_tool_calling: bool
    supports_multimodal: bool

async def resolve_provider_credentials(
    db: AsyncSession,
    provider_id: str,
    model_id: str | None = None,
) -> ResolvedCredentials:
    """
    统一解析 Provider 凭据。
    被以下模块调用：
    - AgentWorker._build_transport()
    - EngineBridge._build_transport()
    - marker.py / extractor.py
    - main.py Embedding/ImageGen 初始化
    - personality analysis API
    """
    prov = await db.get(ComputeProvider, provider_id)
    if not prov:
        raise ValueError(f"Provider not found: {provider_id}")

    api_key = None
    if prov.api_key_encrypted:
        api_key = await decrypt_value(prov.api_key_encrypted)

    return ResolvedCredentials(
        provider_id=prov.id,
        provider_type=prov.provider_type,
        model_id=model_id or (prov.models[0].id if prov.models else ""),
        base_url=prov.base_url or "",
        api_key=api_key,
        auth_mode=prov.auth_mode,
        custom_headers=prov.custom_headers or {},
        request_timeout=prov.request_timeout,
        max_retries=prov.max_retries,
    )

async def resolve_model_attributes(
    db: AsyncSession,
    provider_id: str,
    model_id: str,
) -> ResolvedModel:
    """解析 Model 物理属性，用于 token 计数、窗口截断等。"""
    composite_id = f"{provider_id}::{model_id}"
    model = await db.get(LLMModel, composite_id)
    if not model:
        # 降级：返回保守默认值
        return ResolvedModel(
            model_id=model_id,
            display_name=model_id,
            context_window=32000,
            max_output_tokens=4096,
            supports_reasoning=False,
            supports_tool_calling=False,
            supports_multimodal=False,
        )
    return ResolvedModel(
        model_id=model.id,
        display_name=model.display_name,
        context_window=model.context_window,
        max_output_tokens=model.max_output_tokens,
        supports_reasoning=model.supports_reasoning,
        supports_tool_calling=model.supports_tool_calling,
        supports_multimodal=model.supports_multimodal,
    )
```

### 6.5 marker.py / extractor.py 适配

**现状**：`TopicMarker.from_config(model_config)` 和 `PersonalityExtractor.from_marker_config(model_config)` 从 JSON dict 中读取 `provider_id` / `provider` / `model` / `api_key` / `base_url`。

**新方案**：

```python
# backend/engine/memory/topic_compression/marker.py

class TopicMarker:
    @classmethod
    async def from_agent(cls, db: AsyncSession, agent_row: Agent):
        """从 Agent 表的独立字段创建 Marker Transport"""
        from app.services.provider_resolver import resolve_provider_credentials

        creds = await resolve_provider_credentials(
            db,
            provider_id=agent_row.marker_provider_id,
            model_id=agent_row.marker_model_id,
        )
        # 如果 Marker 没有独立配置，回退到主模型
        if not creds.base_url:
            creds = await resolve_provider_credentials(
                db,
                provider_id=agent_row.provider_id,
                model_id=agent_row.model_id,
            )

        return cls(transport=build_transport_from_credentials(creds))
```

同理改造 `extractor.py`。

---

## 7. 前端改造

### 7.1 SystemSettingsPanel.vue LLM/Assistant/Embedding Tab 处理方案

**处理决策**：**移除** LLM、Assistant、Embedding 三个 Tab，替换为迁移提示。

```vue
<!-- SystemSettingsPanel.vue 中的新 LLM Tab -->
<template v-if="activeTab === 'llm'">
  <div class="deprecated-notice">
    <div class="notice-icon">⚠️</div>
    <h3>Provider 管理已迁移</h3>
    <p>「对话模型」配置已移至「算力中枢」，请前往该页面管理 Provider、模型列表和 Fallback 链。</p>
    <button @click="$router.push('/compute')">前往算力中枢</button>

    <!-- 仅保留 Tavily API Key（尚未迁移到 ComputeCenter 的独立配置） -->
    <div class="tavily-section" style="margin-top: 24px;">
      <label>Tavily API Key（网络搜索）</label>
      <input
        v-model="form.tavily.api_key"
        type="password"
        placeholder="用于 search_web 工具的 Tavily API Key"
      />
      <p class="hint">用于 Agent 调用网络搜索工具，可在 https://tavily.com 获取</p>
    </div>
  </div>
</template>
```

**保留 Tab**：`tools`（只读）、`memory`（写 config.yaml）、`image`（需确认是否迁移到 ComputeCenter，若迁移则同样移除）。

**弃用 Tab 的 config.yaml 写入清理**：
- 前端 `save()` 不再发送 `payload.provider`、`payload.assistant_model`、`payload.embedding_model`。
- 若后端 `PUT /config` 收到这些字段，返回 `400 Bad Request` + `detail: "provider/assistant_model/embedding_model 配置已废弃，请使用 /compute/providers 和 /compute/embedding-model API"`。

### 7.2 AgentEdit.vue Compute Tab 改造

#### 7.2.1 ModelSelector 组件（新建）

```vue
<!-- frontend/src/components/ModelSelector.vue -->
<template>
  <div class="model-selector">
    <div class="field-row">
      <label>Provider</label>
      <select v-model="selectedProviderId" @change="onProviderChange">
        <option value="">请选择 Provider</option>
        <option v-for="p in providers" :key="p.id" :value="p.id">
          {{ p.display_name }}
        </option>
      </select>
      <p class="hint">选择提供该模型的服务商，如 DeepSeek 官方、SiliconFlow 等</p>
    </div>

    <div class="field-row" v-if="selectedProviderId">
      <label>模型</label>
      <select v-model="selectedModelId">
        <option value="">请选择模型</option>
        <option v-for="m in currentModels" :key="m.id" :value="m.id">
          {{ m.display_name }}
          <span v-if="m.supports_reasoning" title="支持深度思考">🧠</span>
          <span v-if="m.supports_tool_calling" title="支持工具调用">🔧</span>
          <span v-if="m.supports_multimodal" title="支持图文输入">👁️</span>
        </option>
      </select>
      <p class="hint">
        当前模型上下文窗口：{{ currentModel?.context_window?.toLocaleString() ?? '未知' }} tokens，
        最大输出：{{ currentModel?.max_output_tokens?.toLocaleString() ?? '未知' }} tokens
      </p>
    </div>
  </div>
</template>
```

#### 7.2.2 Compute Tab 新布局

```
算力配置 Tab
├── 推理模型（主模型）
│   ├── <ModelSelector v-model:provider="form.provider_id" v-model:model="form.model_id" />
│   ├── temperature 滑块 [0 ———●——— 2]
│   │   └── hint: "控制输出随机性，0 更确定，2 更有创意"
│   └── top_p 滑块 [0 ———●——— 1]
│       └── hint: "核采样阈值，通常保持 1，与 temperature 二选一即可"
│
├── 独立标注模型（checkbox）
│   └── <ModelSelector v-model:provider="form.marker_provider_id" v-model:model="form.marker_model_id" />
│       └── hint: "话题边界标注专用模型，默认与主模型相同"
│
├── 独立嵌入模型（checkbox）
│   └── <ModelSelector v-model:provider="form.embedder_provider_id" v-model:model="form.embedder_model_id" />
│       └── hint: "语义记忆搜索使用的向量模型"
│
├── 独立压缩模型（checkbox）
│   └── <ModelSelector v-model:provider="form.compressor_provider_id" v-model:model="form.compressor_model_id" />
│       └── hint: "历史记忆压缩专用模型，默认与主模型相同"
│
└── 降级链（Fallback Chain）
    ├── 说明: "当主模型不可用时，按以下顺序尝试其他模型"
    ├── 节点列表（可拖拽排序）
    │   ├── 1. DeepSeek V4 Pro @ DeepSeek 官方  ↑ ↓ ✕
    │   ├── 2. GPT-4o @ OpenAI 兼容            ↑ ↓ ✕
    │   └── ...
    └── + 添加降级模型（弹出 ModelSelector，选择 provider + model）
```

#### 7.2.3 Fallback 链数据结构变更

旧格式（前端发送）：
```json
[{ "provider_id": "", "provider": "deepseek", "model": "deepseek-v4-pro" }]
```

新格式：
```json
[
  { "provider_id": "deepseek-official", "model_id": "deepseek-v4-pro", "display_name": "DeepSeek V4 Pro" },
  { "provider_id": "openai-compatible-01", "model_id": "gpt-4o", "display_name": "GPT-4o" }
]
```

**向后兼容**：前端发送新格式，后端同时兼容旧格式（见 6.2 节）。

### 7.3 ComputeCenter.vue 扩展

#### 7.3.1 模型自动发现

**现状**：添加 Provider 后，模型列表需要手动输入。

**改造**：
- 添加 Provider 表单增加「自动发现模型」按钮。
- 调用 `POST /api/v1/compute/providers/{id}/test`，后端返回模型列表时同时返回自动发现的模型数组。
- 前端展示发现结果，用户可勾选要添加的模型，一键导入。

```typescript
async function discoverModels(providerId: string) {
  const res = await api.post(`/compute/providers/${providerId}/test`)
  if (res.data.discovered_models?.length) {
    // 弹出选择框，展示 discovered_models
    showDiscoveryModal.value = true
    discoveredModels.value = res.data.discovered_models
  }
}
```

#### 7.3.2 max_input_length 编辑

ComputeCenter 的 Provider 卡片中增加「模型管理」按钮：
- 点击后展开该 Provider 的模型列表表格。
- 表格列：模型名称、上下文窗口、最大输出、多模态、工具调用、思考模式、操作（编辑/删除）。
- 编辑 Modal 中可修改 `context_window`、`max_output_tokens`、`supports_*` 开关。

### 7.4 AgentEdit.vue 拆分方案

参考 `frontend-ui-audit.md` 第 2.4 节，按以下结构拆分：

```
AgentEdit.vue（壳子：Sidebar + Stage + Tab 切换，目标 < 300 行）
├── AgentSidebar.vue（左侧 Agent 列表）
├── AgentStage.vue（中间 3D 展示，预留插槽）
├── tabs/
│   ├── ProfileTab.vue
│   ├── PersonaTab.vue
│   ├── SkillsTab.vue
│   ├── SecurityTab.vue
│   ├── ToolsTab.vue
│   ├── ComputeTab.vue          ← 本次重点改造
│   ├── AppearanceTab.vue
│   └── MindTab.vue
└── modals/
    ├── MindFileModal.vue
    ├── MemoryModal.vue
    ├── ImportHistoryModal.vue
    └── PersonalityModal.vue
```

**ComputeTab.vue 的 Props/Events**：

```typescript
interface ComputeTabProps {
  providerId: string | null
  modelId: string | null
  temperature: number | null
  topP: number | null
  markerProviderId: string | null
  markerModelId: string | null
  embedderProviderId: string | null
  embedderModelId: string | null
  compressorProviderId: string | null
  compressorModelId: string | null
  fallbackChain: FallbackNode[]
}

// 事件：任何字段变更实时 emit，由父组件聚合后 PUT /agents/{id}
interface ComputeTabEmits {
  (e: 'update:providerId', v: string | null): void
  (e: 'update:modelId', v: string | null): void
  // ... 其他字段
}
```

---

## 8. 代码重复清理清单

基于三份审计报告，逐个列出要删除/统一的重复代码。

### 8.1 `_PROFILE_MAP`（factory.py vs engine_bridge.py）

| # | 当前位置 | 当前状态 | 处理方案 |
|---|----------|----------|----------|
| 1 | `backend/engine/provider/factory.py` L21-25 | 硬编码 5 个 key，保留作为内置映射表 | 重命名为 `_BUILTIN_PROFILES`，删除 `_PROFILE_MAP` 旧名 |
| 2 | `backend/app/services/engine_bridge.py` L33-37 | **100% 重复** | **删除**，改为 `from engine.provider.factory import resolve_profile` |

### 8.2 `_decrypt_key`（3 种写法 → 统一到 crypto.py）

| # | 当前位置 | 当前形式 | 处理方案 |
|---|----------|----------|----------|
| 1 | `backend/app/api/compute.py` L57-65 | 命名函数 `_encrypt_key` / `_decrypt_key`（base64） | 替换为 `from app.core.crypto import encrypt_value, decrypt_value` |
| 2 | `backend/app/services/engine_bridge.py` L40-42 | 命名函数 `_decrypt_key`（与 compute.py 完全相同） | **删除该函数**，统一引用 crypto.py |
| 3 | `backend/app/services/agent_worker.py` L387 | 内联 `base64.b64decode(...)` | 改为调用 `decrypt_value()` |
| 4 | `backend/app/main.py` L147 | 内联 `base64.b64decode(...)`（Embedding 初始化） | 改为调用 `decrypt_value()` |
| 5 | `backend/app/main.py` L187 | 内联 `base64.b64decode(...)`（ImageGen 初始化） | 改为调用 `decrypt_value()` |
| 6 | `backend/app/api/agents.py` L511 | 内联 `base64.b64decode(...)`（Personality analysis） | 改为调用 `decrypt_value()` |

**统一后**：所有 API Key 加解密通过 `app/core/crypto.py` 的 `encrypt_value()` / `decrypt_value()` 完成，支持过渡期双解密（先尝试新加密，失败降级 base64）。

### 8.3 `_build_transport`（agent_worker.py vs engine_bridge.py）

| # | 当前位置 | 当前逻辑 | 处理方案 |
|---|----------|----------|----------|
| 1 | `backend/app/services/agent_worker.py` L394-412 | 查 ComputeProvider → 解密 → `factory.build_transport()` | 保留，但将「查表+解密」逻辑抽取到 `provider_resolver.resolve_provider_credentials()` |
| 2 | `backend/app/services/engine_bridge.py` L190-228 | 查 ComputeProvider → 解密 → **直接实例化** ChatCompletionsTransport | **重构**：统一调用 `factory.build_transport()`，传入 `resolve_provider_credentials` callback |

### 8.4 Provider 解析逻辑（4 处 → 统一到 provider_resolver.py）

| # | 当前位置 | 用途 | 统一后调用方式 |
|---|----------|------|----------------|
| 1 | `backend/app/services/agent_worker.py` L371-398 | AgentWorker 主 transport | `await resolve_provider_credentials(db, agent.provider_id, agent.model_id)` |
| 2 | `backend/app/api/agents.py` L480-512 | Personality analysis Marker | `await resolve_provider_credentials(db, agent.marker_provider_id, agent.marker_model_id)` |
| 3 | `backend/app/main.py` L127-154 | Embedding 初始化 | `await resolve_provider_credentials(db, embedder_provider_id)` |
| 4 | `backend/app/main.py` L168-193 | ImageGen 初始化 | `await resolve_provider_credentials(db, imagegen_provider_id)` |

**统一后**：新建 `backend/app/services/provider_resolver.py`，提供 `resolve_provider_credentials()` 和 `resolve_model_attributes()`。

---

## 9. 废弃清单

以下代码路径和配置项在本次重做后明确废弃。

### 9.1 后端废弃项

| 项目 | 废弃原因 | 替代方案 | 处理方式 |
|------|----------|----------|----------|
| `backend/engine/config.yaml` 中的 `provider.*` | 已迁移到 `providers.yaml` + ComputeProvider 表 | `providers.yaml` | 启动迁移后从 `config.yaml` 中移除该段，保留文件其他内容 |
| `backend/engine/config.yaml` 中的 `assistant_model.*` | 无消费方，疑似死配置 | AgentEdit → Compute Tab 中配置 Marker 模型 | 启动时忽略，不迁移 |
| `backend/engine/config.yaml` 中的 `embedding_model.*` | 已迁移到 Setting 表，且 SystemSettingsPanel 写入不生效 | ComputeCenter 的 Embedding 设置 | 启动时忽略，不迁移 |
| `backend/app/api/config.py` 中 `_MUTABLE_SECTIONS` 的 `"provider"` / `"assistant_model"` / `"embedding_model"` | 前端保存被静默丢弃 | 明确拒绝并返回 400 | 保留拒绝逻辑，但返回明确错误信息 |
| `ComputeProvider.config['models']`（JSON 内字符串数组） | 已拆分为独立 LLMModel 表 | `LLMModel` 表 | 过渡期内读取做兼容，新写入时清空 |
| `Agent.model_config['provider']`（name 字符串） | 已拆分为 `Agent.provider_id`（UUID） | `Agent.provider_id` + `Agent.model_id` | 向后兼容读取，新 Agent 不再写入 |
| `Agent.model_config['marker']` / `['embedder']` / `['compressor']` | 已拆分为独立数据库字段 | `Agent.marker_provider_id` 等 | 向后兼容读取，新 Agent 不再写入 |
| `Agent.model_config['fallback_chain']` 旧格式（含 `provider` name） | 改为 `provider_id` + `model_id` | 新 JSON 格式 + 独立解析逻辑 | 向后兼容解析，新写入使用新格式 |
| `engine_bridge.py` 的 `_PROFILE_MAP` | 与 factory.py 完全重复 | `factory.resolve_profile()` | 删除 |
| `engine_bridge.py` 的 `_decrypt_key` | 与 compute.py 重复 | `crypto.decrypt_value()` | 删除 |

### 9.2 前端废弃项

| 项目 | 废弃原因 | 替代方案 | 处理方式 |
|------|----------|----------|----------|
| `SystemSettingsPanel.vue` LLM Tab 硬编码 4 Provider 卡片 | 假保存，后端不接收 | ComputeCenter | 移除 Tab，显示迁移提示 |
| `SystemSettingsPanel.vue` Assistant Tab | 假保存，无消费方 | ComputeCenter / AgentEdit Marker | 移除 Tab |
| `SystemSettingsPanel.vue` Embedding Tab | 假保存，实际生效在 ComputeCenter | ComputeCenter | 移除 Tab |
| `AgentEdit.vue` 中 `llm_config.provider`（name 字符串） | 已改为 provider_id | `llm_config.provider_id` | 数据层兼容，UI 改用 ModelSelector |
| `AgentEdit.vue` 中 `llm_config.model`（裸字符串） | 已关联到 Provider | `llm_config.model_id` + Provider 上下文 | UI 改用级联选择器 |

---

## 10. 实施批次

分为 4 批，每批明确文件列表、改动内容、依赖关系和验证方式。

### 第一批：数据层 + 迁移（无业务逻辑影响）

**目标**：打好数据基础，旧系统继续正常运行。

**涉及文件列表**：
- `backend/app/models/compute.py` — 扩展 ComputeProvider 表（新增 9 字段）
- `backend/app/models/models.py` — **新建** LLMModel 表
- `backend/app/models/agents.py` — 扩展 Agent 表（新增 12 字段）
- `backend/alembic/versions/xxx_provider_refactor.py` — Schema 迁移脚本
- `backend/app/core/provider_schema.py` — **新建** Pydantic YAML Schema
- `backend/app/core/crypto.py` — **新建** 统一加密模块（先保持 base64 兼容）
- `backend/app/services/provider_migration.py` — **新建** 启动迁移逻辑
- `backend/app/main.py` — 启动时调用迁移脚本
- `~/.cloudmind-zome/providers.yaml` — **新建** 默认配置文件（用户数据目录，与 cloudmind.db 同级）

**改动内容概述**：
1. Alembic 执行 Schema 变更（新增表和列）。
2. 创建 `crypto.py`，提供 `encrypt_value()` / `decrypt_value()`（先实现 base64，预留 Fernet 接口）。
3. 创建 `provider_schema.py`，定义 YAML ↔ DB 的 Pydantic 校验。
4. 创建 `provider_migration.py`，实现 config.yaml → providers.yaml → DB 的迁移。
5. `main.py` 启动时：若 providers.yaml 不存在，触发迁移；若存在，执行校验 + upsert。
6. `provider_migration.py` 等新代码路径使用 `crypto.encrypt_value()` 写入 API Key。现有 `compute.py`、`engine_bridge.py`、`agent_worker.py`、`main.py`、`agents.py` 中的 base64 调用**不改动**，留到第四批统一替换。

**依赖关系**：
- 无前置依赖，可独立部署。
- 但必须先完成 Alembic 迁移，才能启动新代码。

**验证方式**：
1. 启动服务，检查日志：应看到 `providers.yaml loaded: X providers, Y models`。
2. 检查数据库：`compute_providers` 表新字段已填充，`llm_models` 表已有记录。
3. 检查旧 Agent：`agents` 表新字段（`provider_id`, `model_id`）已根据 `model_config` 填充。
4. 所有现有功能（对话、Agent 启动、Fallback）应**完全不受影响**。

---

### 第二批：后端 API + 引擎适配

**目标**：新数据模型跑通，旧格式保持兼容。

**涉及文件列表**：
- `backend/app/api/compute.py` — 扩展 Provider CRUD：返回嵌套 models、支持新字段、加密升级
- `backend/app/api/models.py` — **新建** Model CRUD API
- `backend/app/api/agents.py` — Agent API 适配新字段；`analyze-personality` 适配；`list_providers` 返回 Model 详情
- `backend/app/services/provider_resolver.py` — **新建** 统一 Provider 解析公共函数
- `backend/app/services/agent_worker.py` — `_resolve_provider()` / `_build_transport()` / fallback transport 构建改为 `provider_id/model_id`
- `backend/app/services/engine_bridge.py` — `_build_transport()` 适配新体系；去除重复 `_PROFILE_MAP` 和 `_decrypt_key`
- `backend/engine/provider/factory.py` — `_PROFILE_MAP` 改为动态查找 `resolve_profile()`
- `backend/engine/provider/transport.py` — 支持 `auth_mode`, `custom_headers`, `timeout`, `max_retries` 动态注入
- `backend/engine/error/fallback.py` — `FallbackChain` 改造为 `(provider_id, model_id)` 组合节点
- `backend/engine/agent/react.py` — fallback_chain 解析适配新格式，向后兼容旧格式
- `backend/engine/memory/topic_compression/marker.py` — `from_config()` 适配新 Provider/Model 格式
- `backend/engine/personality/extractor.py` — `from_marker_config()` 适配新格式

**改动内容概述**：
1. 新建 `/api/v1/models` CRUD。
2. 扩展 `/api/v1/compute/providers`：响应中嵌套 `models[]`，接收 `base_url`, `auth_mode` 等新字段。
3. 新建 `provider_resolver.py`，将 4 处 Provider 查表+解密逻辑统一。
4. `factory.py` 改为 `resolve_profile()` 动态查找。
5. `transport.py` 构造函数接收动态参数。
6. `FallbackChain` 内部改为 `FallbackNode`，`ReActAgent` 的 `_transports` key 改为 `"provider_id::model_id"`。
7. `agent_worker.py` 和 `engine_bridge.py` 统一使用 `provider_resolver` + `factory.build_transport()`。
8. `marker.py` / `extractor.py` 从 Agent 独立字段读取配置。

**依赖关系**：
- 依赖**第一批**完成（数据库新字段和表必须已存在）。
- 前端尚未改造，因此 API 需要同时兼容旧前端（AgentEdit 仍发送旧 `model_config` 格式）。

**验证方式**：
1. API 测试：
   - `GET /compute/providers` 返回嵌套 models，且模型带有 `context_window` 等物理属性。
   - `POST /models` 创建模型后，yaml 和 DB 双写成功。
2. Agent 启动测试：新 Agent（使用 `provider_id` + `model_id`）能正常对话。
3. Fallback 测试：手动切断主模型网络，验证降级到备用模型。
4. Marker 测试：触发话题压缩，验证 Marker transport 正常创建。

---

### 第三批：前端改造

**目标**：用户界面完全切换到新体系。

**涉及文件列表**：
- `frontend/src/components/ModelSelector.vue` — **新建** Provider → Model 级联选择器
- `frontend/src/components/SystemSettingsPanel.vue` — 移除 LLM/Assistant/Embedding Tab，添加迁移提示
- `frontend/src/components/AgentEdit.vue` — Compute tab 适配新字段、接入 ModelSelector、添加 temperature/top_p
- `frontend/src/components/tabs/ComputeTab.vue` — **新建**（AgentEdit 拆分的一部分）
- `frontend/src/components/ComputeCenter.vue` — 扩展模型自动发现、模型属性编辑
- `frontend/src/stores/compute.ts` — 扩展 Model 列表缓存、Provider 详情缓存

**改动内容概述**：
1. 新建 `ModelSelector.vue`：级联选择 Provider → Model，展示能力图标和物理属性提示。
2. 新建 `ComputeTab.vue`（AgentEdit 拆分的第一步），包含主模型选择、行为参数（temperature/top_p）、独立模型勾选、Fallback 链管理。
3. `AgentEdit.vue` 移除内联 Compute tab 代码，改为引用 `<ComputeTab>` 组件。
4. `SystemSettingsPanel.vue` 移除三个假保存 Tab。
5. `ComputeCenter.vue` 添加「自动发现模型」按钮和模型属性编辑表格。
6. `compute.ts` store 增加 `models` 缓存和 getter。

**依赖关系**：
- 依赖**第二批**完成（后端 API 必须已支持新字段和嵌套 models）。
- AgentEdit 需要同时兼容旧 Agent（尚未迁移的 `model_config`）和新 Agent（独立字段），因此前端读取时做兼容：优先读独立字段，若为空则回退到 `model_config`。

**验证方式**：
1. 打开 SystemSettingsPanel，确认 LLM/Assistant/Embedding Tab 已消失，显示迁移提示。
2. 打开 AgentEdit → Compute Tab：
   - 能级联选择 Provider 和 Model。
   - 选择 Model 后显示 context_window、max_output_tokens。
   - 能调节 temperature / top_p。
   - Fallback 链能添加/删除/排序，且保存后数据结构为 `provider_id` + `model_id`。
3. 打开 ComputeCenter：
   - 添加 Provider 后点击「测试连接」，能自动发现模型并展示选择框。
   - 能编辑模型的 context_window 等属性。
4. 端到端：新建 Agent → 选择 Provider/Model → 对话 → 验证调用的是正确模型。

---

### 第四批：清理 + 测试

**目标**：移除旧代码，验证稳定性。

**涉及文件列表**：
- `backend/engine/config.yaml` — 移除 `provider.*` 段（若迁移成功）
- `backend/app/api/config.py` — 更新 `_MUTABLE_SECTIONS` 拒绝逻辑，返回明确错误
- `backend/app/api/compute.py` — 替换 `_encrypt_key` / `_decrypt_key` 为 `crypto.py` 统一调用
- `backend/app/services/engine_bridge.py` — 删除 `_PROFILE_MAP`、`_decrypt_key`、独立 `load_config()`；内联 base64 改为 `crypto.decrypt_value()`
- `backend/app/services/agent_worker.py` — 删除内联 base64 解密、删除旧 `_resolve_provider` 逻辑
- `backend/app/api/agents.py` — 删除内联 base64 解密
- `backend/app/main.py` — 删除 Embedding/ImageGen 初始化中的内联 base64
- `backend/tests/test_fallback_chain.py` — 更新测试用例
- `backend/tests/test_provider_migration.py` — **新建** 迁移测试
- `frontend/src/components/AgentEdit.vue` — 完成剩余拆分（如 Modal 抽取）

**改动内容概述**：
1. 后端将 6 个文件中的内联/独立 base64 解密统一替换为 `crypto.decrypt_value()`，将 `compute.py` 的 `_encrypt_key` 替换为 `crypto.encrypt_value()`。
2. 删除 `engine_bridge.py` 中的重复代码（`_PROFILE_MAP`、`_decrypt_key`）。
3. `config.yaml` 清理：确认 `provider.*`、`assistant_model.*`、`embedding_model.*` 段已移除。
4. 补充测试：
   - FallbackChain 使用 `(provider_id, model_id)` 的单元测试。
   - Provider 迁移脚本测试（模拟旧 config.yaml → 验证输出）。
   - 双写一致性测试（并发修改 yaml）。
   - 向后兼容测试（旧 Agent.model_config 仍能启动）。
5. 前端完成 AgentEdit 剩余拆分（可选，不影响 Provider 体系）。

**依赖关系**：
- 依赖**第三批**完成且稳定运行至少 1 周（确保前端已完全切换，无回退需求）。

**验证方式**：
1. 代码扫描：项目中不存在 `base64.b64decode` 的裸调用（`crypto.py` 内部除外）。
2. 代码扫描：`engine_bridge.py` 中不存在 `_PROFILE_MAP` 和 `_decrypt_key`。
3. 回归测试：所有现有 Agent（含旧格式配置）能正常启动和对话。
4. 性能测试：启动时 yaml 加载 + upsert 耗时 < 500ms（100 个 Provider / 500 个 Model 规模）。

---

## 11. 风险评估与缓解

基于 `provider-refactor-audit.md` 第 8 节的风险矩阵，结合新的 `providers.yaml` 方案更新如下：

| # | 风险 | 严重度 | 说明 | 缓解方案（更新） |
|---|------|--------|------|------------------|
| 1 | **运行中的 Agent 受影响** | 🔴 高 | AgentWorker 启动时固化 transport，Provider 配置修改后已运行的 Worker 不会感知 | ① **不变**：AgentEdit 保存后发送信号重启对应 Worker（WebSocket / 内部事件）；② 在 ComputeCenter 和 AgentEdit 中添加提示：「修改 Provider 配置后，已运行的 Agent 将在下次重启时生效」；③ 提供「重启 Agent」按钮 |
| 2 | **旧配置迁移失败** | 🟡 中 | config.yaml 格式可能不统一、api_key 缺失、JSON 结构异常 | ① 迁移脚本加 try/except，**单条失败不阻断启动**；② 启动后生成迁移报告日志（INFO 级别，列出成功/失败条目）；③ 提供 `GET /admin/migration-report` API 供前端展示迁移状态；④ 失败项保留在 config.yaml 中，下次启动重试 |
| 3 | **Fallback 链改动导致对话中断** | 🟡 中 | 旧数据 `fallback_chain` 格式为 `[{"provider": "deepseek"}]`，新格式需要 `provider_id/model_id` | ① `ReActAgent.__init__()` 做**向后兼容解析**：找不到 `provider_id` 时回退到按 `provider` name 查找 ComputeProvider 表并 warn；② 过渡期（1-2 个版本）保留兼容逻辑；③ 前端保存 Agent 时自动将旧格式升级为新格式 |
| 4 | **API Key 加密升级导致旧 key 无法解密** | 🔴 高 | 当前 base64"加密"和真正加密算法不兼容 | ① `crypto.decrypt_value()` 实现**过渡期双解密**：先尝试 Fernet/AES-GCM，失败降级 base64，成功后自动重写为新加密；② 若 base64 也损坏（极少数），将该 Provider 标记为 `status="error"`，前端显示「API Key 损坏，请重新输入」；③ 启动迁移时批量升级，打日志记录升级数量 |
| 5 | **ThinkingProfile 动态化** | 🟢 低 | 用户添加自定义 Provider（如 siliconflow）时没有对应 Profile | ① `resolve_profile()` 未知类型回退到 `DeepSeekThinkingProfile`（最通用，支持 reasoning + tool_calls）；② Provider 表预留 `thinking_profile` 字段，未来允许用户显式指定；③ 文档说明「自定义 Provider 默认使用通用 OpenAI 兼容解析模式」 |
| 6 | **前端状态不一致** | 🟢 低 | AgentEdit 中 `llmProviders` 缓存可能过期 | ① 保存 Agent 后刷新 Provider/Model 列表；② 删除 Provider 时后端做引用校验，若有 Agent 引用则返回 409，前端提示「该 Provider 正在被 X 个 Agent 使用」；③ `compute.ts` store 增加 TTL 缓存和强制刷新按钮 |
| 7 | **Schema 变更导致现有 Agent 启动失败** | 🔴 高 | Agent 表新增非空字段时，旧数据缺少这些字段 | ① **所有新增字段均为 `nullable=True`**，旧数据自动为 NULL；② 代码中读取时做 `get(key, default)` 回退到 `model_config` JSON；③ 启动迁移脚本自动填充独立字段；④ 若 `provider_id` 仍为空（迁移失败），回退到旧逻辑（按 `model_config.provider` name 查找） |
| 8 | **providers.yaml 并发写入损坏** | 🟡 中 | 多进程/多实例同时写入 yaml 可能导致文件损坏 | ① 使用临时文件 + 原子 rename；② 写操作加 **portalocker 文件锁**（跨平台独占锁）；③ 数据库写失败时 yaml 已是最新，下次启动自动重试同步 |
| 9 | **yaml 被用户手动编辑后格式错误** | 🟡 中 | 用户可能手动修改 providers.yaml 导致语法错误 | ① 启动时 Pydantic 校验，失败则**启动中断**（fail-fast），打印具体错误位置；② 提供 CLI 工具 `python -m app.cli.validate_yaml` 供用户预检查；③ 备份机制：每次写入前复制 `.yaml.bak` |
| 10 | **内置 Provider 被误删** | 🟢 低 | 用户可能尝试删除内置 Provider | ① `is_builtin=true` 的 Provider 禁止删除（DB 层面 + API 层面 409）；② 删除内置 Provider 的模型时校验引用，但允许删除（用户可能不需要某个内置模型） |

### 11.1 新增风险（providers.yaml 方案引入）

| # | 风险 | 严重度 | 说明 | 缓解方案 |
|---|------|--------|------|----------|
| 11 | **yaml 与 DB 长期不一致** | 🟡 中 | 若某次写入 yaml 成功但 DB 失败，且下次启动未检测到 yaml 变更（mtime 未变），则 DB 永远落后 | ① 启动时**无条件全量比对**：遍历 yaml 所有 Provider/Model 与 DB 做 diff，而非仅依赖 mtime；② 提供 `POST /admin/resync-providers` 管理接口强制重同步；③ 定期（每周）或每次启动都做全量比对 |
| 12 | **providers.yaml 体积膨胀** | 🟢 低 | 用户添加大量自定义 Provider 和模型后，yaml 可能达到数 MB | ① yaml 设计已按 Provider 分组，结构清晰；② 若未来超过 1000 个模型，考虑将 models 拆分为 `models.yaml`；③ 当前阶段无需处理，Pydantic + yaml 解析数 MB 文件在 100ms 内完成 |

---

## 附录 A：关键术语表

| 术语 | 含义 |
|------|------|
| **Provider** | LLM 服务商，如 DeepSeek 官方、OpenAI、Ollama 本地 |
| **Model** | 具体模型，如 DeepSeek-V4-Pro、GPT-4o，隶属于某个 Provider |
| **ThinkingProfile** | 引擎层解析模型响应的策略（如是否提取 reasoning_content、如何处理 tool_calls） |
| **FallbackChain** | 主模型不可用时，按优先级尝试的备用模型列表 |
| **Marker** | 话题边界标注模型，用于压缩历史记忆时识别话题切换点 |
| **Embedder** | 嵌入模型，用于将文本转为向量进行语义搜索 |
| **Compressor** | 记忆压缩模型，用于将长历史对话压缩为摘要 |
| **真相源（Source of Truth）** | 指 `providers.yaml` 文件，所有 Provider/Model 配置的最终持久化存储 |
| **幂等 Upsert** | 多次执行结果相同：已存在则更新，不存在则插入，不重复创建 |

## 附录 B：文件路径汇总

| 类型 | 路径 |
|------|------|
| YAML 真相源 | `~/.cloudmind-zome/providers.yaml`（用户数据目录，与 cloudmind.db 同级） |
| 加密模块 | `backend/app/core/crypto.py` |
| YAML Schema | `backend/app/core/provider_schema.py` |
| Provider 解析器 | `backend/app/services/provider_resolver.py` |
| 迁移脚本 | `backend/app/services/provider_migration.py` |
| Alembic 迁移 | `backend/alembic/versions/xxx_provider_refactor.py` |
| Model CRUD API | `backend/app/api/models.py` |
| 前端级联选择器 | `frontend/src/components/ModelSelector.vue` |
| 前端算力配置 Tab | `frontend/src/components/tabs/ComputeTab.vue` |

---

*文档结束。本方案待技术评审通过后进入实施阶段。*
