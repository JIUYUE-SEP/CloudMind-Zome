"""Pydantic schema for providers.yaml.

Defines YAML <-> DB mapping and validation rules.
"""

from __future__ import annotations

from datetime import datetime
from typing import Literal, Optional

from pydantic import BaseModel, Field, field_validator


class PricingInfo(BaseModel):
    """Model pricing info for cost estimation."""

    input_per_1m_tokens: float = Field(default=0.0, ge=0)
    output_per_1m_tokens: float = Field(default=0.0, ge=0)
    currency: str = Field(default="USD")


class ModelConfig(BaseModel):
    """Model-level configuration: physical attributes."""

    id: str = Field(..., min_length=1)
    display_name: str = Field(..., min_length=1)
    is_builtin: bool = Field(default=False)
    is_default: bool = Field(default=False)
    status: Literal["active", "inactive"] = Field(default="active")

    context_window: Optional[int] = Field(default=None)
    max_output_tokens: Optional[int] = Field(default=None)
    supports_multimodal: bool = Field(default=False)
    input_modalities: list[str] = Field(default_factory=lambda: ["text"])
    output_modalities: list[str] = Field(default_factory=lambda: ["text"])
    supports_streaming: bool = Field(default=True)
    supports_tool_calling: bool = Field(default=False)
    supports_reasoning: bool = Field(default=False)

    model_type: Literal["llm", "embedding", "image", "stt"] = Field(default="llm")
    pricing: Optional[PricingInfo] = Field(default=None)


class ProviderConfig(BaseModel):
    """Provider-level configuration: network/auth."""

    id: str = Field(..., min_length=1)
    provider_type: str = Field(..., min_length=1)
    display_name: str = Field(..., min_length=1)
    is_builtin: bool = Field(default=False)
    status: Literal["active", "inactive"] = Field(default="active")
    description: Optional[str] = Field(default=None)

    base_url: str = Field(..., min_length=1)
    auth_mode: Literal["api_key", "bearer", "none"] = Field(default="api_key")
    api_key_encrypted: Optional[str] = Field(default=None)
    custom_headers: dict[str, str] = Field(default_factory=dict)
    request_timeout: float = Field(default=120.0, gt=0)
    max_retries: int = Field(default=3, ge=0)
    rate_limit_qpm: int = Field(default=0, ge=0)
    require_api_key: bool = Field(default=True)

    models: list[ModelConfig] = Field(default_factory=list)

    @field_validator("api_key_encrypted")
    @classmethod
    def _check_api_key(cls, v: Optional[str], info) -> Optional[str]:
        data = info.data
        if data.get("auth_mode") != "none" and v is None:
            raise ValueError("auth_mode != 'none' requires api_key_encrypted")
        return v


class ProvidersYaml(BaseModel):
    """Root structure of providers.yaml."""

    schema_version: int = Field(default=2)
    last_modified: Optional[datetime] = Field(default=None)
    providers: list[ProviderConfig] = Field(default_factory=list)
