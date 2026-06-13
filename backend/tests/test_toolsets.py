"""Tests for toolset filtering in ToolRegistry."""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import pytest

from engine.tool.registry import ToolRegistry


@pytest.fixture
def registry():
    r = ToolRegistry()

    def dummy_read():
        pass

    def dummy_write():
        pass

    def dummy_search():
        pass

    r._tools = {
        "read_file": {
            "toolset": "file",
            "schema": {"function": {"name": "read_file"}},
        },
        "write_file": {
            "toolset": "file",
            "schema": {"function": {"name": "write_file"}},
        },
        "search_web": {
            "toolset": "web",
            "schema": {"function": {"name": "search_web"}},
        },
    }
    return r


class TestGetSchemasFiltering:
    def test_none_returns_all(self, registry: ToolRegistry) -> None:
        schemas = registry.get_schemas(toolsets=None)
        names = {s["function"]["name"] for s in schemas}
        assert names == {"read_file", "write_file", "search_web"}

    def test_empty_list_returns_empty(self, registry: ToolRegistry) -> None:
        schemas = registry.get_schemas(toolsets=[])
        assert schemas == []

    def test_single_toolset(self, registry: ToolRegistry) -> None:
        schemas = registry.get_schemas(toolsets=["file"])
        names = {s["function"]["name"] for s in schemas}
        assert names == {"read_file", "write_file"}

    def test_multiple_toolsets(self, registry: ToolRegistry) -> None:
        schemas = registry.get_schemas(toolsets=["file", "web"])
        names = {s["function"]["name"] for s in schemas}
        assert names == {"read_file", "write_file", "search_web"}

    def test_wildcard_returns_all(self, registry: ToolRegistry) -> None:
        schemas = registry.get_schemas(toolsets=["*"])
        names = {s["function"]["name"] for s in schemas}
        assert names == {"read_file", "write_file", "search_web"}

    def test_unknown_toolset_warns_and_returns_empty(self, registry: ToolRegistry, caplog) -> None:
        schemas = registry.get_schemas(toolsets=["nonexistent"])
        assert schemas == []
        assert "unknown toolsets" in caplog.text.lower()
