"""Provider registry: scan llmprovider/*.json, resolve env vars."""
from __future__ import annotations
import json
import logging
import os
import re
from pathlib import Path
from dataclasses import dataclass
from typing import Optional

logger = logging.getLogger(__name__)

LLMPROVIDER_DIR = Path.home() / ".cloudmind-zome" / "llmprovider"


@dataclass(frozen=True)
class ProviderConfig:
    name: str
    display_name: str
    base_url: str
    api_key: str
    default_model: str
    models: list[str]
    supports_streaming: bool
    supports_vision: bool
    supports_reasoning: bool
    marker_model: Optional[str]
    embedding_model: Optional[str]


def _resolve_env(text: str) -> str:
    pattern = re.compile(r"\$\{([A-Za-z0-9_]+)\}")

    def replacer(m: re.Match) -> str:
        key = m.group(1)
        val = os.environ.get(key)
        if val is None:
            raise ValueError(f"Environment variable {key} not found")
        return val

    return pattern.sub(replacer, text)


def _load_provider(path: Path) -> ProviderConfig:
    raw = json.loads(path.read_text(encoding="utf-8"))
    return ProviderConfig(
        name=raw["name"],
        display_name=raw.get("display_name", raw["name"]),
        base_url=_resolve_env(raw["base_url"]),
        api_key=_resolve_env(raw["api_key"]),
        default_model=raw["default_model"],
        models=raw.get("models", [raw["default_model"]]),
        supports_streaming=raw.get("supports_streaming", True),
        supports_vision=raw.get("supports_vision", False),
        supports_reasoning=raw.get("supports_reasoning", False),
        marker_model=raw.get("marker_model"),
        embedding_model=raw.get("embedding_model"),
    )


class ProviderRegistry:
    def __init__(self) -> None:
        self._providers: dict[str, ProviderConfig] = {}
        if LLMPROVIDER_DIR.exists():
            for f in LLMPROVIDER_DIR.glob("*.json"):
                try:
                    cfg = _load_provider(f)
                    self._providers[cfg.name] = cfg
                except Exception as e:
                    logger.warning("Failed to load provider %s: %s", f, e)

    def get(self, name: str) -> ProviderConfig:
        if name not in self._providers:
            raise KeyError(f"Provider '{name}' not found in {LLMPROVIDER_DIR}")
        return self._providers[name]

    def list(self) -> list[ProviderConfig]:
        return list(self._providers.values())

    def has(self, name: str) -> bool:
        return name in self._providers


# Singleton
_registry: Optional[ProviderRegistry] = None


def get_registry() -> ProviderRegistry:
    global _registry
    if _registry is None:
        _registry = ProviderRegistry()
    return _registry


def clear_registry() -> None:
    """Clear singleton (mainly for tests)."""
    global _registry
    _registry = None
