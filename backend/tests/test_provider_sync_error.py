"""Tests for provider YAML/DB dual-write error handling.

Covers:
- ProviderSyncError is raised on YAML parse/write failures.
- API routes return HTTP 500 when YAML sync fails.
- sync_yaml_to_db never cleans orphans from a damaged/empty YAML.
- migrate_add_columns drops the leftover llm_models_new table.

All tests use temporary directories; they never touch ~/.cloudmind-zome/.
"""

from __future__ import annotations

from pathlib import Path
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
import yaml
from fastapi import HTTPException

from app.api.compute import create_provider, delete_provider, update_provider
from app.api.compute import ProviderCreate, ProviderUpdate
from app.api.models import create_model, ModelCreate
from app.services.provider_migration import (
    ProviderSyncError,
    sync_provider_yaml,
    sync_yaml_to_db,
)
from migrate_add_columns import main as migrate_columns


# ------------------------------------------------------------------
# Fixtures
# ------------------------------------------------------------------
@pytest.fixture
def temp_providers_yaml(tmp_path: Path):
    """Patch PROVIDERS_YAML_PATH to a file inside tmp_path."""
    yaml_path = tmp_path / "providers.yaml"
    with patch("app.services.provider_migration.PROVIDERS_YAML_PATH", yaml_path):
        yield yaml_path


@pytest.fixture
def mock_compute_provider():
    """Return a ComputeProvider-like mock with one model."""
    model = MagicMock()
    model.id = "p1::m1"
    model.display_name = "Model One"
    model.status = "active"
    model.is_builtin = False
    model.is_default = False
    model.supports_multimodal = False
    model.supports_streaming = True
    model.supports_tool_calling = False
    model.supports_reasoning = False
    model.input_modalities = ["text"]
    model.output_modalities = ["text"]
    model.model_type = "llm"
    model.context_window = 64000
    model.max_output_tokens = 4096

    prov = MagicMock()
    prov.id = "p1"
    prov.provider_type = "openai"
    prov.display_name = "Test Provider"
    prov.status = "active"
    prov.is_builtin = False
    prov.base_url = "https://api.openai.com/v1"
    prov.auth_mode = "api_key"
    prov.api_key_encrypted = "enc"
    prov.custom_headers = {}
    prov.request_timeout = 120.0
    prov.max_retries = 3
    prov.rate_limit_qpm = 0
    prov.require_api_key = True
    prov.description = None
    prov.models = [model]
    return prov


@pytest.fixture
def mock_user():
    user = MagicMock()
    user.id = "user-1"
    return user


@pytest.fixture
def mock_db_for_create():
    """Minimal AsyncSession mock supporting add/commit/refresh."""
    db = AsyncMock()
    db.add = MagicMock()
    db.commit = AsyncMock()
    db.refresh = AsyncMock()
    return db


def _mock_db_session():
    """Return an AsyncMock session safe for sync_yaml_to_db invalid-YAML paths."""
    result = MagicMock()
    result.all = MagicMock(return_value=[("orphan-prov",)])
    result.scalar_one_or_none = MagicMock(return_value=None)
    db = MagicMock()
    db.execute = AsyncMock(return_value=result)
    db.delete = MagicMock()
    return db


# ------------------------------------------------------------------
# sync_provider_yaml error paths
# ------------------------------------------------------------------
def test_sync_provider_yaml_raises_on_corrupt_yaml(temp_providers_yaml, mock_compute_provider):
    temp_providers_yaml.write_text("this is not: valid: yaml: [", encoding="utf-8")

    with pytest.raises(ProviderSyncError):
        sync_provider_yaml("upsert", mock_compute_provider)


def test_sync_provider_yaml_raises_on_empty_yaml(temp_providers_yaml, mock_compute_provider):
    temp_providers_yaml.write_text("", encoding="utf-8")

    with pytest.raises(ProviderSyncError):
        sync_provider_yaml("upsert", mock_compute_provider)


def test_sync_provider_yaml_raises_on_missing_yaml(temp_providers_yaml, mock_compute_provider):
    if temp_providers_yaml.exists():
        temp_providers_yaml.unlink()

    with pytest.raises(ProviderSyncError):
        sync_provider_yaml("upsert", mock_compute_provider)


def test_sync_provider_yaml_raises_on_write_failure(
    temp_providers_yaml, mock_compute_provider, monkeypatch
):
    """Simulate a write failure by making the atomic temp write raise PermissionError."""
    temp_providers_yaml.write_text(
        yaml.safe_dump({"providers": []}), encoding="utf-8"
    )

    def _raise_permission(*args, **kwargs):
        raise PermissionError("denied")

    monkeypatch.setattr(Path, "write_text", _raise_permission)

    with pytest.raises(ProviderSyncError):
        sync_provider_yaml("upsert", mock_compute_provider)


def test_sync_provider_yaml_success(temp_providers_yaml, mock_compute_provider):
    temp_providers_yaml.write_text(
        yaml.safe_dump({"providers": []}), encoding="utf-8"
    )
    sync_provider_yaml("upsert", mock_compute_provider)

    raw = yaml.safe_load(temp_providers_yaml.read_text("utf-8"))
    assert any(p["id"] == "p1" for p in raw["providers"])


# ------------------------------------------------------------------
# API routes return 500 on sync failure
# ------------------------------------------------------------------
@pytest.mark.asyncio
async def test_create_provider_returns_500_on_sync_error(mock_user, mock_db_for_create):
    body = ProviderCreate(display_name="Test")
    with patch("app.api.compute.sync_provider_yaml", side_effect=ProviderSyncError("boom")):
        with pytest.raises(HTTPException) as exc_info:
            await create_provider(body, user=mock_user, db=mock_db_for_create)
    assert exc_info.value.status_code == 500
    assert "Provider sync failed" in exc_info.value.detail


@pytest.mark.asyncio
async def test_update_provider_returns_500_on_sync_error(mock_user):
    prov = MagicMock()
    prov.id = "p1"
    prov.user_id = mock_user.id

    result = MagicMock()
    result.scalar_one_or_none = MagicMock(return_value=prov)
    db = AsyncMock()
    db.execute = AsyncMock(return_value=result)
    db.commit = AsyncMock()

    body = ProviderUpdate(display_name="New Name")
    with patch("app.api.compute.sync_provider_yaml", side_effect=ProviderSyncError("boom")):
        with pytest.raises(HTTPException) as exc_info:
            await update_provider("p1", body, user=mock_user, db=db)
    assert exc_info.value.status_code == 500


@pytest.mark.asyncio
async def test_delete_provider_returns_500_on_sync_error(mock_user):
    prov = MagicMock()
    prov.id = "p1"
    prov.user_id = mock_user.id
    prov.is_builtin = False

    result = MagicMock()
    result.scalar_one_or_none = MagicMock(return_value=prov)
    db = AsyncMock()
    db.execute = AsyncMock(return_value=result)

    with patch("app.api.compute.sync_provider_yaml", side_effect=ProviderSyncError("boom")):
        with pytest.raises(HTTPException) as exc_info:
            await delete_provider("p1", user=mock_user, db=db)
    assert exc_info.value.status_code == 500
    # DB delete must not happen when YAML sync fails
    db.delete.assert_not_awaited()


@pytest.mark.asyncio
async def test_create_model_returns_500_on_sync_error(mock_user):
    prov = MagicMock()
    prov.id = "p1"
    prov.user_id = mock_user.id
    prov.models = []

    async def _fake_get(cls, key):
        # provider exists, model does not
        return prov if key == "p1" else None

    db = AsyncMock()
    db.get = AsyncMock(side_effect=_fake_get)
    db.add = MagicMock()
    db.commit = AsyncMock()
    db.refresh = AsyncMock()
    db.expire_all = MagicMock()
    db.execute = AsyncMock()

    body = ModelCreate(provider_id="p1", id="m1", display_name="Model One")
    with patch("app.api.models.sync_provider_yaml", side_effect=ProviderSyncError("boom")):
        with pytest.raises(HTTPException) as exc_info:
            await create_model(body, user=mock_user, db=db)
    assert exc_info.value.status_code == 500


# ------------------------------------------------------------------
# sync_yaml_to_db safety: no cleanup with invalid YAML
# ------------------------------------------------------------------
@pytest.mark.asyncio
async def test_sync_yaml_to_db_skips_cleanup_on_corrupt_yaml(temp_providers_yaml):
    temp_providers_yaml.write_text("not: valid: yaml: [", encoding="utf-8")

    db = _mock_db_session()
    report = await sync_yaml_to_db(db)
    assert report.errors
    db.delete.assert_not_called()


@pytest.mark.asyncio
async def test_sync_yaml_to_db_skips_cleanup_on_empty_yaml(temp_providers_yaml):
    temp_providers_yaml.write_text("", encoding="utf-8")

    db = _mock_db_session()
    report = await sync_yaml_to_db(db)
    assert report.errors
    db.delete.assert_not_called()


@pytest.mark.asyncio
async def test_sync_yaml_to_db_skips_cleanup_on_missing_yaml(temp_providers_yaml):
    if temp_providers_yaml.exists():
        temp_providers_yaml.unlink()

    db = _mock_db_session()
    report = await sync_yaml_to_db(db)
    assert report.errors
    db.delete.assert_not_called()


@pytest.mark.asyncio
async def test_sync_yaml_to_db_skips_cleanup_when_providers_empty(temp_providers_yaml):
    temp_providers_yaml.write_text(
        yaml.safe_dump({"schema_version": 2, "providers": []}), encoding="utf-8"
    )

    db = _mock_db_session()
    report = await sync_yaml_to_db(db)
    assert report.errors
    db.delete.assert_not_called()


# ------------------------------------------------------------------
# Migration script drops leftover llm_models_new
# ------------------------------------------------------------------
def test_migration_drops_llm_models_new(tmp_path: Path):
    db_path = tmp_path / "test.db"
    conn = __import__("sqlite3").connect(str(db_path))
    cur = conn.cursor()
    # Minimal tables required by the migration script
    cur.execute("CREATE TABLE chat_sessions (id TEXT)")
    cur.execute("CREATE TABLE chat_messages (id TEXT)")
    cur.execute("CREATE TABLE chat_session_members (id TEXT)")
    cur.execute("CREATE TABLE users (id TEXT)")
    cur.execute("CREATE TABLE agents (id TEXT)")
    cur.execute("CREATE TABLE llm_models_new (id TEXT)")
    conn.commit()
    conn.close()

    migrate_columns(db_path=db_path)

    conn = __import__("sqlite3").connect(str(db_path))
    cur = conn.cursor()
    cur.execute(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='llm_models_new'"
    )
    assert cur.fetchone() is None
    conn.close()
