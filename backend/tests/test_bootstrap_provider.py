"""Tests for built-in provider bootstrap and API key masking.

Uses an in-memory async SQLite database and a minimal FastAPI app so the
real data directory is never touched.
"""

from __future__ import annotations

import sys
from pathlib import Path
from unittest.mock import patch

import pytest
import pytest_asyncio
import yaml

# Ensure backend is on path
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from fastapi import FastAPI
from httpx import AsyncClient, ASGITransport
from sqlalchemy import select
from sqlalchemy.ext.asyncio import (
    AsyncSession,
    async_sessionmaker,
    create_async_engine,
)

from app.api import compute, config
from app.core.crypto import encrypt_value
from app.database import Base
from app.dependencies import get_db, require_user
from app.models import ComputeProvider, LLMModel, User
from app.services.bootstrap import ensure_builtin_provider


@pytest_asyncio.fixture
async def db_session():
    """Fresh in-memory SQLite session for each test."""
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    Session = async_sessionmaker(
        engine, class_=AsyncSession, expire_on_commit=False, autoflush=False
    )
    async with Session() as session:
        yield session
    await engine.dispose()


@pytest_asyncio.fixture
async def test_user(db_session: AsyncSession):
    """Create a deterministic test user in the temporary database."""
    user = User(
        id="00000000-0000-0000-0000-000000000001",
        codename="guest",
        nickname="Guest",
        password_hash=None,
        device_id="test-device",
        role="guest",
    )
    db_session.add(user)
    await db_session.commit()
    return user


@pytest_asyncio.fixture
async def client(db_session: AsyncSession, test_user: User):
    """FastAPI test client with DB and auth dependencies overridden."""
    app = FastAPI()
    app.include_router(compute.router, prefix="/api/v1")
    app.include_router(config.router, prefix="/api/v1")

    async def override_get_db():
        yield db_session

    async def override_require_user():
        return test_user

    app.dependency_overrides[get_db] = override_get_db
    app.dependency_overrides[require_user] = override_require_user

    # Avoid writing to the real providers.yaml during provider CRUD.
    with patch("app.api.compute.sync_provider_yaml"):
        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://test") as c:
            yield c

    app.dependency_overrides.clear()


class TestBootstrapProvider:
    @pytest.mark.asyncio
    async def test_creates_builtin_provider_and_default_model_when_empty(
        self, db_session: AsyncSession
    ):
        prov = await ensure_builtin_provider(db_session)
        assert prov is not None
        assert prov.display_name == "OpenAI Compatible"
        assert prov.provider_type == "openai"
        assert prov.base_url == "https://api.openai.com/v1"
        assert prov.is_builtin is True
        assert prov.api_key_encrypted == ""

        result = await db_session.execute(
            select(LLMModel).where(LLMModel.provider_id == prov.id)
        )
        models = result.scalars().all()
        assert len(models) >= 1
        default_models = [m for m in models if m.is_default]
        assert default_models
        assert any(m.id.endswith("gpt-4o-mini") for m in models)

    @pytest.mark.asyncio
    async def test_skips_when_providers_already_exist(
        self, db_session: AsyncSession, test_user: User
    ):
        custom = ComputeProvider(
            id="custom-prov-1",
            user_id=test_user.id,
            provider_type="openai",
            display_name="My Provider",
            api_key_encrypted="",
            base_url="https://api.example.com/v1",
            is_builtin=False,
        )
        db_session.add(custom)
        await db_session.commit()

        prov = await ensure_builtin_provider(db_session)
        assert prov is None


class TestBuiltinProviderProtection:
    @pytest.mark.asyncio
    async def test_delete_builtin_returns_403(
        self, client: AsyncClient, db_session: AsyncSession
    ):
        prov = await ensure_builtin_provider(db_session)
        assert prov is not None

        resp = await client.delete(f"/api/v1/compute/providers/{prov.id}")
        assert resp.status_code == 403
        data = resp.json()
        assert "built-in" in data.get("detail", "").lower()


class TestApiKeyMasking:
    @pytest.mark.asyncio
    async def test_providers_response_masks_api_key(
        self,
        client: AsyncClient,
        db_session: AsyncSession,
        test_user: User,
    ):
        prov = ComputeProvider(
            id="prov-with-key",
            user_id=test_user.id,
            provider_type="openai",
            display_name="Keyed Provider",
            api_key_encrypted=encrypt_value("sk-secret-key"),
            base_url="https://api.openai.com/v1",
            is_builtin=False,
        )
        db_session.add(prov)
        await db_session.commit()

        resp = await client.get("/api/v1/compute/providers")
        assert resp.status_code == 200
        data = resp.json()
        assert data["code"] == 0
        assert len(data["data"]["items"]) == 1
        item = data["data"]["items"][0]
        assert item["api_key"] == "********"
        assert item["has_api_key"] is True

    @pytest.mark.asyncio
    async def test_providers_response_shows_empty_key_when_no_key(
        self,
        client: AsyncClient,
        db_session: AsyncSession,
        test_user: User,
    ):
        prov = ComputeProvider(
            id="prov-no-key",
            user_id=test_user.id,
            provider_type="openai",
            display_name="Keyless Provider",
            api_key_encrypted="",
            base_url="https://api.openai.com/v1",
            is_builtin=False,
        )
        db_session.add(prov)
        await db_session.commit()

        resp = await client.get("/api/v1/compute/providers")
        data = resp.json()
        item = data["data"]["items"][0]
        assert item["api_key"] == ""
        assert item["has_api_key"] is False

    @pytest.mark.asyncio
    async def test_config_response_masks_secrets(
        self, client: AsyncClient, tmp_path: Path
    ):
        cfg_path = tmp_path / "config.yaml"
        cfg = {
            "tavily": {"api_key": "tavily-secret", "secret_token": "tok"},
            "image_gen": {"api_key": "img-secret", "url": "http://example.com"},
            "context": {"compact_threshold": 0.8},
        }
        cfg_path.write_text(yaml.safe_dump(cfg), encoding="utf-8")

        with patch("app.api.config._CFG_PATH", cfg_path):
            resp = await client.get("/api/v1/config")
            assert resp.status_code == 200
            data = resp.json()
            assert data["data"]["tavily"]["api_key"] == "********"
            assert data["data"]["tavily"]["secret_token"] == "********"
            assert data["data"]["image_gen"]["api_key"] == "********"
            assert data["data"]["image_gen"]["url"] == "http://example.com"
            assert data["data"]["context"]["compact_threshold"] == 0.8

    @pytest.mark.asyncio
    async def test_config_update_response_masks_secrets(
        self, client: AsyncClient, tmp_path: Path
    ):
        cfg_path = tmp_path / "config.yaml"
        cfg_path.write_text(yaml.safe_dump({"tavily": {}}), encoding="utf-8")

        with patch("app.api.config._CFG_PATH", cfg_path):
            payload = {"tavily": {"api_key": "new-secret"}}
            resp = await client.put("/api/v1/config", json=payload)
            assert resp.status_code == 200
            data = resp.json()
            assert data["data"]["tavily"]["api_key"] == "********"
