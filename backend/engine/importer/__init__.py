"""Conversation history importers."""
from __future__ import annotations

from .base import ImportAdapter
from .qwenpaw import QwenPawAdapter

_ADAPTERS: dict[str, ImportAdapter] = {
    QwenPawAdapter().platform_name(): QwenPawAdapter(),
}


def get_adapter(platform: str) -> ImportAdapter | None:
    """Get an import adapter by platform name."""
    return _ADAPTERS.get(platform.lower())


def list_platforms() -> list[str]:
    """Return available platform names."""
    return list(_ADAPTERS.keys())
