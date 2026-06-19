"""Startup migration: encrypt plaintext or base64-obfuscated API keys.

Scans both the compute_providers table and providers.yaml. Any value that is
not already prefixed with ``enc:`` is decrypted (legacy base64 fallback) and
re-encrypted with the current Fernet key.
"""

from __future__ import annotations

import logging
import os
from typing import Any

import yaml
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.crypto import decrypt_value, encrypt_value, is_encrypted
from app.models import ComputeProvider
from app.services.provider_migration import PROVIDERS_YAML_PATH

logger = logging.getLogger(__name__)


async def migrate_plaintext_keys(db: AsyncSession) -> dict[str, int]:
    """Encrypt any plaintext or legacy-obfuscated API keys found at startup.

    Returns:
        Counter dict with ``db_encrypted`` and ``yaml_encrypted``.
    """
    stats = {"db_encrypted": 0, "yaml_encrypted": 0}

    # ------------------------------------------------------------------
    # 1. Database
    # ------------------------------------------------------------------
    try:
        result = await db.execute(select(ComputeProvider))
        providers = result.scalars().unique().all()
        for prov in providers:
            value = prov.api_key_encrypted or ""
            if value and not is_encrypted(value):
                plain = decrypt_value(value)
                prov.api_key_encrypted = encrypt_value(plain)
                stats["db_encrypted"] += 1
                logger.info("Migrated API key encryption for provider %s", prov.id)

        if stats["db_encrypted"]:
            await db.commit()
            logger.info(
                "Migrated %d provider API keys in database",
                stats["db_encrypted"],
            )
    except Exception as exc:
        logger.error("Database key migration failed: %s", exc, exc_info=True)
        try:
            await db.rollback()
        except Exception:
            pass

    # ------------------------------------------------------------------
    # 2. providers.yaml
    # ------------------------------------------------------------------
    try:
        stats["yaml_encrypted"] = _migrate_yaml_keys()
    except Exception as exc:
        logger.error("providers.yaml key migration failed: %s", exc, exc_info=True)

    return stats


def _migrate_yaml_keys() -> int:
    """Encrypt plaintext keys in providers.yaml; return number migrated."""
    if not PROVIDERS_YAML_PATH.exists():
        return 0

    content = PROVIDERS_YAML_PATH.read_text("utf-8")
    if not content.strip():
        return 0

    try:
        raw: Any = yaml.safe_load(content)
    except Exception:
        return 0

    if not isinstance(raw, dict):
        return 0

    providers = raw.get("providers")
    if not isinstance(providers, list):
        return 0

    migrated = 0
    for provider in providers:
        if not isinstance(provider, dict):
            continue
        value = provider.get("api_key_encrypted") or ""
        if value and not is_encrypted(value):
            plain = decrypt_value(value)
            provider["api_key_encrypted"] = encrypt_value(plain)
            migrated += 1

    if migrated:
        tmp = PROVIDERS_YAML_PATH.with_suffix(".yaml.tmp")
        tmp.write_text(
            yaml.safe_dump(raw, allow_unicode=True, sort_keys=False),
            encoding="utf-8",
        )
        os.replace(str(tmp), str(PROVIDERS_YAML_PATH))
        logger.info("Migrated %d provider API keys in providers.yaml", migrated)

    return migrated
