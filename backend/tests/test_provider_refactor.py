"""Provider subsystem refactor tests (batch 4).

Covers:
- FallbackChain new format + backward compat
- Provider migration from legacy config.yaml
- Provider resolver credential resolution
- Agent model_config fallback logic
"""

from __future__ import annotations

import asyncio
import tempfile
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
import yaml

from app.core.crypto import encrypt_value
from app.services.provider_migration import migrate_from_legacy_config
from app.services.provider_resolver import resolve_provider_credentials, ResolvedCredentials
from engine.error.fallback import FallbackChain, FallbackNode, _parse_fallback_chain


# ------------------------------------------------------------------
# FallbackChain (new format)
# ------------------------------------------------------------------
class TestFallbackChainNewFormat:
    def test_create_and_advance(self):
        nodes = [
            FallbackNode("openai-compatible", "gpt-4o", "OpenAI"),
            FallbackNode("deepseek-official", "deepseek-v4-pro", "DeepSeek"),
        ]
        fb = FallbackChain(nodes)
        assert fb.current_node.key == "openai-compatible::gpt-4o"
        assert fb.current_provider == "OpenAI"

        nxt = fb.fallback()
        assert nxt is not None
        assert nxt.key == "deepseek-official::deepseek-v4-pro"
        assert fb.current_provider == "DeepSeek"

    def test_exhausted_returns_none(self):
        fb = FallbackChain([FallbackNode("a", "m1")])
        assert fb.fallback() is None

    def test_reset(self):
        nodes = [
            FallbackNode("a", "m1"),
            FallbackNode("b", "m2"),
            FallbackNode("c", "m3"),
        ]
        fb = FallbackChain(nodes)
        fb.fallback()
        fb.fallback()
        assert fb.current_node.provider_id == "c"
        fb.reset()
        assert fb.current_node.provider_id == "a"


# ------------------------------------------------------------------
# FallbackChain backward compatibility
# ------------------------------------------------------------------
class TestFallbackChainBackwardCompat:
    def test_legacy_format_parsing(self):
        raw = [
            {"provider": "deepseek", "model": "deepseek-chat"},
            {"provider": "mimo", "model": "mimo-large"},
        ]
        nodes = _parse_fallback_chain(raw)
        assert len(nodes) == 2
        assert nodes[0].provider_id == "deepseek"
        assert nodes[0].model_id == "deepseek-chat"
        assert nodes[0].display_name == "deepseek"
        assert nodes[1].key == "mimo::mimo-large"

    def test_new_format_parsing(self):
        raw = [
            {
                "provider_id": "deepseek-official",
                "model_id": "deepseek-v4-pro",
                "display_name": "DeepSeek",
            }
        ]
        nodes = _parse_fallback_chain(raw)
        assert len(nodes) == 1
        assert nodes[0].provider_id == "deepseek-official"
        assert nodes[0].model_id == "deepseek-v4-pro"
        assert nodes[0].display_name == "DeepSeek"

    def test_mixed_format_parsing(self):
        raw = [
            {"provider_id": "new-p", "model_id": "new-m"},
            {"provider": "legacy-p", "model": "legacy-m"},
        ]
        nodes = _parse_fallback_chain(raw)
        assert len(nodes) == 2
        assert nodes[0].provider_id == "new-p"
        assert nodes[1].provider_id == "legacy-p"


# ------------------------------------------------------------------
# Provider migration
# ------------------------------------------------------------------
class TestProviderMigration:
    @pytest.mark.asyncio
    async def test_migrate_from_legacy_config_yaml(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            yaml_path = Path(tmpdir) / "providers.yaml"
            legacy_path = Path(tmpdir) / "config.yaml"

            legacy_config = {
                "provider": {
                    "deepseek": {
                        "base_url": "https://api.deepseek.com/v1",
                        "api_key": "sk-test",
                        "model": "deepseek-chat",
                    },
                    "openai": {
                        "base_url": "https://api.openai.com/v1",
                        "api_key": "sk-openai",
                        "model": "gpt-4o",
                    },
                }
            }
            legacy_path.write_text(yaml.safe_dump(legacy_config), encoding="utf-8")

            report = await migrate_from_legacy_config(
                yaml_path=yaml_path,
                legacy_config_path=legacy_path,
            )

            assert report.skipped is False
            assert report.migrated_providers == 2
            assert report.migrated_models == 2
            assert yaml_path.exists()

            loaded = yaml.safe_load(yaml_path.read_text("utf-8"))
            assert loaded["schema_version"] == 2
            providers = loaded["providers"]
            assert len(providers) == 2
            ids = {p["id"] for p in providers}
            assert ids == {"legacy-deepseek", "legacy-openai"}

            # Verify api_key was encrypted (not plaintext)
            ds = next(p for p in providers if p["id"] == "legacy-deepseek")
            assert ds["api_key_encrypted"] != "sk-test"
            assert ds["base_url"] == "https://api.deepseek.com/v1"

    @pytest.mark.asyncio
    async def test_migrate_skips_when_yaml_exists(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            yaml_path = Path(tmpdir) / "providers.yaml"
            yaml_path.write_text("schema_version: 2\nproviders: []\n", encoding="utf-8")
            report = await migrate_from_legacy_config(yaml_path=yaml_path)
            assert report.skipped is True

    @pytest.mark.asyncio
    async def test_migrate_creates_empty_yaml_when_no_legacy(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            yaml_path = Path(tmpdir) / "providers.yaml"
            report = await migrate_from_legacy_config(yaml_path=yaml_path)
            assert report.skipped is False
            assert report.migrated_providers == 0
            assert yaml_path.exists()
            loaded = yaml.safe_load(yaml_path.read_text("utf-8"))
            assert loaded["schema_version"] == 2
            assert loaded["providers"] == []


# ------------------------------------------------------------------
# Provider resolver
# ------------------------------------------------------------------
class TestProviderResolver:
    @pytest.mark.asyncio
    async def test_resolve_provider_credentials(self):
        mock_prov = MagicMock()
        mock_prov.status = "active"
        mock_prov.id = "prov-1"
        mock_prov.provider_type = "deepseek"
        mock_prov.base_url = "https://api.deepseek.com/v1"
        mock_prov.api_key_encrypted = encrypt_value("sk-secret")
        mock_prov.auth_mode = "api_key"
        mock_prov.custom_headers = {"X-Custom": "v"}
        mock_prov.request_timeout = 120.0
        mock_prov.max_retries = 3
        mock_prov.models = []

        db = AsyncMock()
        db.get = AsyncMock(return_value=mock_prov)

        creds = await resolve_provider_credentials(db, "prov-1", "deepseek-chat")
        assert isinstance(creds, ResolvedCredentials)
        assert creds.provider_id == "prov-1"
        assert creds.provider_type == "deepseek"
        assert creds.base_url == "https://api.deepseek.com/v1"
        assert creds.api_key == "sk-secret"
        assert creds.auth_mode == "api_key"
        assert creds.custom_headers == {"X-Custom": "v"}
        assert creds.request_timeout == 120.0
        assert creds.max_retries == 3

    @pytest.mark.asyncio
    async def test_resolve_provider_credentials_inactive(self):
        mock_prov = MagicMock()
        mock_prov.status = "inactive"

        db = AsyncMock()
        db.get = AsyncMock(return_value=mock_prov)

        creds = await resolve_provider_credentials(db, "prov-1")
        assert creds is None

    @pytest.mark.asyncio
    async def test_resolve_provider_credentials_not_found(self):
        db = AsyncMock()
        db.get = AsyncMock(return_value=None)
        creds = await resolve_provider_credentials(db, "missing")
        assert creds is None


# ------------------------------------------------------------------
# Agent model_config fallback
# ------------------------------------------------------------------
class TestAgentModelConfigFallback:
    @pytest.mark.asyncio
    async def test_new_fields_preferred(self):
        """When provider_id and model_id are set, they are used directly."""
        from app.services.agent_worker import AgentWorker

        mock_agent = MagicMock()
        mock_agent.provider_id = "openai-compatible"
        mock_agent.model_id = "gpt-4o"
        mock_agent.model_config = {"provider": "deepseek", "model": "deepseek-chat"}

        with patch("app.services.agent_worker.ensure_queue", return_value=asyncio.Queue()):
            worker = AgentWorker("agent-1")
        worker.agent_row = mock_agent
        prov_id, model_name, prov_type = await worker._resolve_model_config()
        assert prov_id == "openai-compatible"
        assert model_name == "gpt-4o"

    @pytest.mark.asyncio
    async def test_fallback_to_legacy_model_config(self):
        """When new fields are empty, fallback to legacy model_config JSON."""
        from app.services.agent_worker import AgentWorker

        mock_agent = MagicMock()
        mock_agent.provider_id = None
        mock_agent.model_id = None
        mock_agent.model_config = {
            "provider": "deepseek",
            "model": "deepseek-chat",
            "provider_id": "deepseek-official",
        }

        with patch("app.services.agent_worker.ensure_queue", return_value=asyncio.Queue()):
            worker = AgentWorker("agent-1")
        worker.agent_row = mock_agent
        prov_id, model_name, prov_type = await worker._resolve_model_config()
        assert prov_id == "deepseek-official"
        assert model_name == "deepseek-chat"
        assert prov_type == "deepseek"

    @pytest.mark.asyncio
    async def test_empty_config_uses_defaults(self):
        """When everything is empty, uses hardcoded defaults."""
        from app.services.agent_worker import AgentWorker

        mock_agent = MagicMock()
        mock_agent.provider_id = None
        mock_agent.model_id = None
        mock_agent.model_config = {}

        # Mock DB lookup so we don't need a real database
        mock_result = MagicMock()
        mock_result.scalar_one_or_none = MagicMock(return_value=None)
        mock_db = AsyncMock()
        mock_db.execute = AsyncMock(return_value=mock_result)
        mock_session = MagicMock()
        mock_session.__aenter__ = AsyncMock(return_value=mock_db)
        mock_session.__aexit__ = AsyncMock(return_value=None)

        with patch("app.services.agent_worker.ensure_queue", return_value=asyncio.Queue()):
            worker = AgentWorker("agent-1")
        worker.agent_row = mock_agent

        with patch("app.services.agent_worker.AsyncSessionLocal", return_value=mock_session):
            prov_id, model_name, prov_type = await worker._resolve_model_config()

        assert model_name == "deepseek-v4-pro"
        assert prov_type == "deepseek"
