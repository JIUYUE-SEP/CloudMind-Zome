"""Configuration models using pydantic.

Design reference: §6.8.2 配置结构, §6.8.3 加载流程
"""

from __future__ import annotations

from pydantic import BaseModel, Field


class SmartStopConfig(BaseModel):
    """Smart stop configuration.

    Design reference: §6.10 智能停止
    """

    max_turns: int = 50
    max_tokens: int = 200000
    timeout_seconds: int = 600
    no_progress_rounds: int = 3
    loop_detect_rounds: int = 2


class AgentConfig(BaseModel):
    """Agent configuration."""

    max_turns: int = 50
    identity: str = "agent.identity.yaml"
    smart_stop: SmartStopConfig = Field(default_factory=SmartStopConfig)
    # Tracing (OpenTelemetry, disabled by default)
    tracing_enabled: bool = False
    tracing_endpoint: str = "http://localhost:4318/v1/traces"
    # Memory system selection
    memory_system: str = "simple"  # "simple" | "topic_compression"
    max_memory_messages: int = 500


class ContextConfig(BaseModel):
    """Context management configuration.

    Design reference: §6.4 上下文注入策略
    """

    compact_threshold: float = 0.8  # Trigger compression at 80% of context window
    keep_recent: int = 3  # Number of recent messages to keep in compression
    hot_memory_limit: int = 10  # Max messages in hot memory
    warm_memory_limit: int = 20  # Max summaries in warm memory
    # Context Pipeline settings
    max_context_tokens: int = 128000  # Model context window (for downgrade)
    semantic_search_top_k: int = 10  # Zvec initial top-K
    semantic_score_threshold: float = 0.3  # Minimum relevance score after decay
    hot_context_initial: int = 20  # Initial recent messages in hot context
    time_decay_half_life_hours: float = 72.0  # Time decay half-life for scoring


class ToolItemConfig(BaseModel):
    """Configuration for MCP server tools."""

    command: str = ""
    args: list[str] = Field(default_factory=list)
    env: dict[str, str] = Field(default_factory=dict)
    supports_parallel_tool_calls: bool = False
    timeout: int = 120
    connect_timeout: int = 60


class ToolsConfig(BaseModel):
    """Tools configuration."""

    toolsets: list[str] = Field(default_factory=list)  # default: no tools (pure chat)
    max_result_chars: int = 50000
    safe_to_parallel_default: bool = True
    default_timeout: int = 60  # Default tool timeout in seconds
    # MCP servers (reserved, not yet implemented)
    mcp_servers: dict[str, ToolItemConfig] = Field(default_factory=dict)


class AppConfig(BaseModel):
    """Top-level configuration, maps to config.yaml.

    Design reference: §6.8 配置系统
    """

    _version: int = 1
    agent: AgentConfig = Field(default_factory=AgentConfig)
    context: ContextConfig = Field(default_factory=ContextConfig)
    tools: ToolsConfig = Field(default_factory=ToolsConfig)
    tavily: dict = Field(default_factory=dict)  # Tavily Search API config: {api_key: str}
    image_gen: dict = Field(default_factory=dict)  # Image generation: {api_url, model, api_key}
