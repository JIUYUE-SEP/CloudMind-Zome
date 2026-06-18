"""Verify provider/model DB writes happen only after YAML sync succeeds.

Covers the dual-write ordering fix:
- flush -> sync_provider_yaml -> commit
- If YAML sync fails, the DB transaction is rolled back and no row is left.
- Existing valid DB rows are not deleted by a subsequent sync_yaml_to_db restart.

All tests use an in-memory database and a temporary providers.yaml.
"""

from __future__ import annotations

import sys
from pathlib import Path
from unittest.mock import patch

import pytest
import pytest_asyncio
import yaml
from fastapi import FastAPI
from httpx import ASGITransport, AsyncClient
from sqlalchemy import select
from sqlalchemy.ext.asyncio import (
    AsyncSession,
    async_sessionmaker,
    create_async_engine,
)

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app.api import compute, models as models_api
from app.database import Base
from app.dependencies import get_db, require_user
from app.models import ComputeProvider, LLMModel, User
from app.services.provider_migration import (
    ProviderSyncError,
    sync_yaml_to_db,
)


@pytest_asyncio.fixture
async def engine():
    """Fresh in-memory SQLite engine."""
    eng = create_async_engine("sqlite+aiosqlite:///:memory:")
    async with eng.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    yield eng
    await eng.dispose()


@pytest_asyncio.fixture
async def db_session(engine):
    """Session used for test assertions."""
    Session = async_sessionmaker(
        engine, class_=AsyncSession, expire_on_commit=False, autoflush=False
    )
    async with Session() as session:
        yield session


@pytest_asyncio.fixture
async def test_user(db_session: AsyncSession):
    """Deterministic test user."""
    user = User(
        id="00000000-0000-0000-0000-000000000001",
        codename="test",
        nickname="Test",
        password_hash=None,
        device_id="test-device",
        role="guest",
    )
    db_session.add(user)
    await db_session.commit()
    return user


@pytest_asyncio.fixture
async def client(engine, test_user: User, tmp_path: Path):
    """FastAPI client with a *new* DB session for each request and a temp YAML."""
    app = FastAPI()
    app.include_router(compute.router, prefix="/api/v1")
    app.include_router(models_api.router, prefix="/api/v1")

    Session = async_sessionmaker(
        engine, class_=AsyncSession, expire_on_commit=False, autoflush=False
    )

    async def override_get_db():
        async with Session() as session:
            yield session

    async def override_require_user():
        return test_user

    app.dependency_overrides[get_db] = override_get_db
    app.dependency_overrides[require_user] = override_require_user

    yaml_path = tmp_path / "providers.yaml"
    yaml_path.write_text(
        yaml.safe_dump({"schema_version": 2, "providers": []}),
        encoding="utf-8",
    )

    with patch("app.services.provider_migration.PROVIDERS_YAML_PATH", yaml_path):
        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://test") as c:
            yield c

    app.dependency_overrides.clear()


class TestProviderDbYamlOrder:
    @pytest.mark.asyncio
    async def test_create_provider_rolls_back_when_yaml_sync_fails(
        self, client: AsyncClient, db_session: AsyncSession
    ):
        with patch(
            "app.api.compute.sync_provider_yaml",
            side_effect=ProviderSyncError("disk full"),
        ):
            resp = await client.post(
                "/api/v1/compute/providers",
                json={"display_name": "Should Not Persist"},
            )
        assert resp.status_code == 500

        result = await db_session.execute(select(ComputeProvider))
        assert result.scalars().all() == []

    @pytest.mark.asyncio
    async def test_update_provider_rolls_back_when_yaml_sync_fails(
        self, client: AsyncClient, db_session: AsyncSession
    ):
        resp = await client.post(
            "/api/v1/compute/providers",
            json={"display_name": "Original Name"},
        )
        assert resp.status_code == 200
        provider_id = resp.json()["data"]["id"]

        with patch(
            "app.api.compute.sync_provider_yaml",
            side_effect=ProviderSyncError("disk full"),
        ):
            resp = await client.put(
                f"/api/v1/compute/providers/{provider_id}",
                json={"display_name": "New Name"},
            )
        assert resp.status_code == 500

        prov = await db_session.get(ComputeProvider, provider_id)
        assert prov.display_name == "Original Name"


class TestModelDbYamlOrder:
    @pytest.mark.asyncio
    async def test_create_model_rolls_back_when_yaml_sync_fails(
        self, client: AsyncClient, db_session: AsyncSession
    ):
        resp = await client.post(
            "/api/v1/compute/providers",
            json={"display_name": "Base Provider"},
        )
        assert resp.status_code == 200
        provider_id = resp.json()["data"]["id"]

        with patch(
            "app.api.models.sync_provider_yaml",
            side_effect=ProviderSyncError("disk full"),
        ):
            resp = await client.post(
                "/api/v1/models",
                json={
                    "provider_id": provider_id,
                    "id": "m1",
                    "display_name": "Should Not Persist",
                },
            )
        assert resp.status_code == 500

        result = await db_session.execute(
            select(LLMModel).where(LLMModel.provider_id == provider_id)
        )
        assert result.scalars().all() == []

    @pytest.mark.asyncio
    async def test_update_model_rolls_back_when_yaml_sync_fails(
        self, client: AsyncClient, db_session: AsyncSession
    ):
        resp = await client.post(
            "/api/v1/compute/providers",
            json={"display_name": "Base Provider"},
        )
        assert resp.status_code == 200
        provider_id = resp.json()["data"]["id"]

        resp = await client.post(
            "/api/v1/models",
            json={
                "provider_id": provider_id,
                "id": "m1",
                "display_name": "Original Model",
            },
        )
        assert resp.status_code == 200

        with patch(
            "app.api.models.sync_provider_yaml",
            side_effect=ProviderSyncError("disk full"),
        ):
            resp = await client.put(
                f"/api/v1/models/{provider_id}/m1",
                json={"display_name": "New Model Name"},
            )
        assert resp.status_code == 500

        model = await db_session.get(LLMModel, f"{provider_id}::m1")
        assert model.display_name == "Original Model"

    @pytest.mark.asyncio
    async def test_delete_model_rolls_back_when_yaml_sync_fails(
        self, client: AsyncClient, db_session: AsyncSession
    ):
        resp = await client.post(
            "/api/v1/compute/providers",
            json={"display_name": "Base Provider"},
        )
        assert resp.status_code == 200
        provider_id = resp.json()["data"]["id"]

        resp = await client.post(
            "/api/v1/models",
            json={
                "provider_id": provider_id,
                "id": "m1",
                "display_name": "Survivor",
            },
        )
        assert resp.status_code == 200

        with patch(
            "app.api.models.sync_provider_yaml",
            side_effect=ProviderSyncError("disk full"),
        ):
            resp = await client.delete(f"/api/v1/models/{provider_id}/m1")
        assert resp.status_code == 500

        model = await db_session.get(LLMModel, f"{provider_id}::m1")
        assert model is not None


class TestRestartSyncKeepsValidConfig:
    @pytest.mark.asyncio
    async def test_sync_yaml_to_db_keeps_valid_config_after_failed_write(
        self, client: AsyncClient, db_session: AsyncSession
    ):
        # 1. Create a valid provider + model; this succeeds and writes YAML.
        resp = await client.post(
            "/api/v1/compute/providers",
            json={
                "display_name": "Keeper Provider",
                "base_url": "https://api.example.com/v1",
            },
        )
        assert resp.status_code == 200
        provider_id = resp.json()["data"]["id"]

        resp = await client.post(
            "/api/v1/models",
            json={
                "provider_id": provider_id,
                "id": "keeper-model",
                "display_name": "Keeper Model",
            },
        )
        assert resp.status_code == 200

        # 2. Attempt to create another provider; YAML sync fails.
        with patch(
            "app.api.compute.sync_provider_yaml",
            side_effect=ProviderSyncError("disk full"),
        ):
            resp = await client.post(
                "/api/v1/compute/providers",
                json={"display_name": "Should Not Persist"},
            )
        assert resp.status_code == 500

        # 3. Existing records must still be present.
        provs = (
            (await db_session.execute(select(ComputeProvider))).scalars().all()
        )
        models = (
            (await db_session.execute(select(LLMModel))).scalars().all()
        )
        assert len(provs) == 1
        assert provs[0].id == provider_id
        assert len(models) == 1

        # 4. Simulate a restart sync_yaml_to_db(). The valid YAML must keep
        #    the existing provider/model and not treat them as orphans.
        report = await sync_yaml_to_db(db_session)
        assert not report.errors

        provs_after = (
            (await db_session.execute(select(ComputeProvider))).scalars().all()
        )
        models_after = (
            (await db_session.execute(select(LLMModel))).scalars().all()
        )
        assert len(provs_after) == 1
        assert provs_after[0].id == provider_id
        assert len(models_after) == 1
