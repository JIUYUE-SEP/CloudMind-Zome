"""Tests for real API key encryption with Fernet.

Covers:
- encrypt_value / decrypt_value round-trip.
- Plaintext legacy values are returned as-is by decrypt_value.
- Encrypted tokens do not contain the original key.
- DB write/read round-trip through ComputeProvider.
- /api/v1/compute/providers masks api_key in the response.
"""

from __future__ import annotations

import sys
from pathlib import Path
from unittest.mock import patch

import pytest
import pytest_asyncio
from cryptography.fernet import Fernet
from fastapi import FastAPI
from httpx import AsyncClient, ASGITransport
from sqlalchemy import select
from sqlalchemy.ext.asyncio import (
    AsyncSession,
    async_sessionmaker,
    create_async_engine,
)

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app.api import compute
from app.core.crypto import (
    decrypt_value,
    encrypt_value,
    is_encrypted,
)
from app.database import Base
from app.dependencies import get_db, require_user
from app.models import ComputeProvider, User
from app.services.key_migration import migrate_plaintext_keys


@pytest.fixture(autouse=True)
def fixed_encryption_key(monkeypatch):
    """Use a deterministic Fernet key for all tests in this module."""
    key = Fernet.generate_key().decode("utf-8")
    monkeypatch.setenv("CLOUDMIND_ENCRYPTION_KEY", key)
    # Force re-import of the crypto module so it picks up the new env var.
    import importlib

    import app.core.crypto as crypto_mod

    importlib.reload(crypto_mod)


# ------------------------------------------------------------------
# Crypto unit tests
# ------------------------------------------------------------------

def test_encrypt_decrypt_roundtrip():
    plain = "sk-test-secret-key-12345"
    token = encrypt_value(plain)
    assert token != plain
    assert is_encrypted(token)
    assert decrypt_value(token) == plain


def test_encrypt_empty_returns_empty():
    assert encrypt_value("") == ""
    assert encrypt_value(None) == ""  # type: ignore[arg-type]


def test_decrypt_empty_returns_empty():
    assert decrypt_value("") == ""


def test_decrypt_plaintext_returns_plaintext():
    """Legacy plaintext values without the enc: prefix are returned as-is."""
    assert decrypt_value("sk-plaintext-key") == "sk-plaintext-key"
    assert decrypt_value("not-an-api-key") == "not-an-api-key"


def test_decrypt_legacy_base64_obfuscation():
    """Old base64-obfuscated keys are decoded if they look like API keys."""
    import base64

    plain = "sk-legacy-base64-key"
    b64 = base64.b64encode(plain.encode("utf-8")).decode("utf-8")
    assert decrypt_value(b64) == plain


def test_decrypt_legacy_base64_non_api_key_ignored():
    """Base64 strings that do not decode to an API key prefix stay as-is."""
    import base64

    plain = "just-a-plaintext-string"
    b64 = base64.b64encode(plain.encode("utf-8")).decode("utf-8")
    # "just-a" does not match any known API key prefix, so it is treated as
    # plaintext and returned unchanged.
    assert decrypt_value(b64) == b64


def test_encrypted_token_does_not_contain_plaintext():
    plain = "sk-my-secret"
    token = encrypt_value(plain)
    assert plain not in token
    # The raw token part (after enc:) should not contain the secret either.
    raw = token[len("enc:") :]
    assert plain not in raw


def test_is_encrypted():
    assert is_encrypted("enc:abc123") is True
    assert is_encrypted("sk-plaintext") is False
    assert is_encrypted("") is False
    assert is_encrypted(None) is False


def test_double_encryption_is_idempotent():
    plain = "sk-double-encrypt"
    once = encrypt_value(plain)
    twice = encrypt_value(once)
    assert is_encrypted(twice)
    assert decrypt_value(twice) == plain


# ------------------------------------------------------------------
# Database round-trip
# ------------------------------------------------------------------

@pytest_asyncio.fixture
async def db_session():
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


@pytest.mark.asyncio
async def test_compute_provider_db_roundtrip(
    db_session: AsyncSession, test_user: User
):
    plain_key = "sk-db-roundtrip-secret"
    prov = ComputeProvider(
        id="prov-encrypt-1",
        user_id=test_user.id,
        provider_type="openai",
        display_name="Encrypted Provider",
        api_key_encrypted=encrypt_value(plain_key),
        base_url="https://api.openai.com/v1",
    )
    db_session.add(prov)
    await db_session.commit()

    result = await db_session.execute(
        select(ComputeProvider).where(ComputeProvider.id == "prov-encrypt-1")
    )
    loaded = result.scalar_one()
    assert is_encrypted(loaded.api_key_encrypted)
    assert decrypt_value(loaded.api_key_encrypted) == plain_key


@pytest.mark.asyncio
async def test_compute_provider_legacy_plaintext_auto_encrypted(
    db_session: AsyncSession, test_user: User
):
    """Simulate old plaintext api_key_encrypted and verify it decrypts."""
    plain_key = "sk-legacy-plaintext"
    prov = ComputeProvider(
        id="prov-legacy-1",
        user_id=test_user.id,
        provider_type="openai",
        display_name="Legacy Provider",
        api_key_encrypted=plain_key,
        base_url="https://api.example.com/v1",
    )
    db_session.add(prov)
    await db_session.commit()

    # Reading through the resolver-compatible decrypt_value returns the key.
    result = await db_session.execute(
        select(ComputeProvider).where(ComputeProvider.id == "prov-legacy-1")
    )
    loaded = result.scalar_one()
    assert decrypt_value(loaded.api_key_encrypted) == plain_key


# ------------------------------------------------------------------
# HTTP response masking
# ------------------------------------------------------------------

@pytest_asyncio.fixture
async def client(db_session: AsyncSession, test_user: User):
    app = FastAPI()
    app.include_router(compute.router, prefix="/api/v1")

    async def override_get_db():
        yield db_session

    async def override_require_user():
        return test_user

    app.dependency_overrides[get_db] = override_get_db
    app.dependency_overrides[require_user] = override_require_user

    with patch("app.api.compute.sync_provider_yaml"):
        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://test") as c:
            yield c

    app.dependency_overrides.clear()


@pytest.mark.asyncio
async def test_providers_response_masks_encrypted_api_key(
    client: AsyncClient,
    db_session: AsyncSession,
    test_user: User,
):
    prov = ComputeProvider(
        id="prov-mask-1",
        user_id=test_user.id,
        provider_type="openai",
        display_name="Masked Provider",
        api_key_encrypted=encrypt_value("sk-mask-me"),
        base_url="https://api.openai.com/v1",
        is_builtin=False,
    )
    db_session.add(prov)
    await db_session.commit()

    resp = await client.get("/api/v1/compute/providers")
    assert resp.status_code == 200
    data = resp.json()
    assert data["code"] == 0
    items = data["data"]["items"]
    assert len(items) == 1
    assert items[0]["api_key"] == "********"
    assert items[0]["has_api_key"] is True


@pytest.mark.asyncio
async def test_key_migration_encrypts_plaintext_and_base64(
    db_session: AsyncSession,
    test_user: User,
    tmp_path: Path,
):
    """migrate_plaintext_keys encrypts plaintext DB rows and YAML entries."""
    import base64
    import yaml

    plain = "sk-migration-secret"
    b64 = base64.b64encode(plain.encode("utf-8")).decode("utf-8")

    prov_plain = ComputeProvider(
        id="prov-mig-plain",
        user_id=test_user.id,
        provider_type="openai",
        display_name="Plain Provider",
        api_key_encrypted=plain,
        base_url="https://api.example.com/v1",
        is_builtin=False,
    )
    prov_b64 = ComputeProvider(
        id="prov-mig-b64",
        user_id=test_user.id,
        provider_type="openai",
        display_name="Base64 Provider",
        api_key_encrypted=b64,
        base_url="https://api.example.com/v1",
        is_builtin=False,
    )
    db_session.add_all([prov_plain, prov_b64])
    await db_session.commit()

    yaml_path = tmp_path / "providers.yaml"
    yaml_path.write_text(
        yaml.safe_dump(
            {
                "schema_version": 2,
                "providers": [
                    {
                        "id": "yaml-prov",
                        "provider_type": "openai",
                        "display_name": "YAML Provider",
                        "api_key_encrypted": plain,
                        "base_url": "https://api.example.com/v1",
                    }
                ],
            }
        ),
        encoding="utf-8",
    )

    with patch(
        "app.services.key_migration.PROVIDERS_YAML_PATH", yaml_path
    ):
        stats = await migrate_plaintext_keys(db_session)

    assert stats["db_encrypted"] == 2
    assert stats["yaml_encrypted"] == 1

    result = await db_session.execute(
        select(ComputeProvider).where(
            ComputeProvider.id.in_(["prov-mig-plain", "prov-mig-b64"])
        )
    )
    for prov in result.scalars().all():
        assert is_encrypted(prov.api_key_encrypted)
        assert decrypt_value(prov.api_key_encrypted) == plain

    raw = yaml.safe_load(yaml_path.read_text("utf-8"))
    assert is_encrypted(raw["providers"][0]["api_key_encrypted"])
    assert (
        decrypt_value(raw["providers"][0]["api_key_encrypted"]) == plain
    )
