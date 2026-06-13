"""Provider migration and YAML <-> DB sync.

- Load or create ~/.cloudmind-zome/providers.yaml
- Migrate from legacy config.yaml (one-time)
- Idempotent upsert into ComputeProvider + LLMModel tables on startup
"""

from __future__ import annotations

import logging
import os
from dataclasses import dataclass, field
from pathlib import Path
from typing import Optional

import yaml

from app.core.crypto import decrypt_value, encrypt_value, is_encrypted
from app.core.provider_schema import ModelConfig, ProviderConfig, ProvidersYaml
from app.database import DATA_DIR
from app.models import ComputeProvider, LLMModel, User
from app.models.base import _uuid


logger = logging.getLogger(__name__)

PROVIDERS_YAML_PATH: Path = DATA_DIR / "providers.yaml"
LEGACY_CONFIG_PATH = Path(__file__).resolve().parent.parent.parent / "engine" / "config.yaml"


class ProviderSyncError(Exception):
    """Raised when provider YAML dual-write sync fails.

    Wraps YAML parse errors, file write errors, and path errors so callers
    can surface them instead of silently swallowing.
    """


# ------------------------------------------------------------------
# YAML sync helpers (dual-write consistency)
# ------------------------------------------------------------------

def _normalize_api_key(value: str | None) -> str:
    """Ensure a credential stored in DB/YAML is encrypted with the current key.

    Empty values remain empty. Legacy plaintext or base64-obfuscated values are
    decrypted and re-encrypted. Already-encrypted values are left as-is.
    """
    if not value:
        return ""
    if is_encrypted(value):
        return value
    try:
        plain = decrypt_value(value)
        return encrypt_value(plain)
    except Exception:
        return encrypt_value(value)


def provider_to_yaml_dict(prov: ComputeProvider) -> dict:
    """Convert a ComputeProvider DB row to a plain dict for YAML serialization."""
    models = []
    for m in prov.models:
        d: dict = {
            "id": m.id.split("::")[-1],
            "display_name": m.display_name,
            "status": m.status,
            "is_builtin": m.is_builtin,
            "supports_multimodal": m.supports_multimodal,
            "supports_streaming": m.supports_streaming,
            "supports_tool_calling": m.supports_tool_calling,
            "supports_reasoning": m.supports_reasoning,
            "is_default": m.is_default,
            "input_modalities": m.input_modalities or ["text"],
            "output_modalities": m.output_modalities or ["text"],
            "model_type": m.model_type or "llm",
        }
        if m.context_window is not None:
            d["context_window"] = m.context_window
        if m.max_output_tokens is not None:
            d["max_output_tokens"] = m.max_output_tokens
        models.append(d)
    return {
        "id": prov.id,
        "provider_type": prov.provider_type,
        "display_name": prov.display_name,
        "status": prov.status,
        "is_builtin": prov.is_builtin,
        "base_url": prov.base_url,
        "auth_mode": prov.auth_mode,
        "api_key_encrypted": _normalize_api_key(prov.api_key_encrypted),
        "custom_headers": prov.custom_headers or {},
        "request_timeout": prov.request_timeout,
        "max_retries": prov.max_retries,
        "rate_limit_qpm": prov.rate_limit_qpm,
        "require_api_key": prov.require_api_key,
        "description": prov.description,
        "models": models,
    }


def sync_provider_yaml(operation: str, prov: ComputeProvider) -> None:
    """Sync provider CRUD back to providers.yaml (dual-write consistency).

    Raises:
        ProviderSyncError: on YAML parse failure, file write failure, or path error.
    """
    try:
        if not PROVIDERS_YAML_PATH.exists():
            raise FileNotFoundError(f"providers.yaml not found: {PROVIDERS_YAML_PATH}")
        raw = yaml.safe_load(PROVIDERS_YAML_PATH.read_text("utf-8"))
        if raw is None:
            raise ValueError("providers.yaml is empty or invalid")
        if not isinstance(raw, dict):
            raise ValueError(f"providers.yaml must be a mapping, got {type(raw).__name__}")
        providers = raw.get("providers", [])
        if not isinstance(providers, list):
            raise ValueError(f"providers must be a list, got {type(providers).__name__}")

        if operation == "delete":
            raw["providers"] = [p for p in providers if p.get("id") != prov.id]
        else:  # upsert
            data = provider_to_yaml_dict(prov)
            found = False
            for i, p in enumerate(providers):
                if p.get("id") == prov.id:
                    providers[i] = data
                    found = True
                    break
            if not found:
                providers.append(data)
            raw["providers"] = providers

        tmp = PROVIDERS_YAML_PATH.with_suffix(".yaml.tmp")
        tmp.write_text(
            yaml.safe_dump(raw, allow_unicode=True, sort_keys=False),
            encoding="utf-8",
        )
        os.replace(str(tmp), str(PROVIDERS_YAML_PATH))
    except ProviderSyncError:
        raise
    except Exception as exc:
        logger.error("Failed to sync provider %s to providers.yaml: %s", prov.id, exc, exc_info=True)
        raise ProviderSyncError(f"Failed to sync provider {prov.id}: {exc}") from exc




# ------------------------------------------------------------------
# System user helper
# ------------------------------------------------------------------

async def _ensure_system_user(db) -> str:
    """Return the first admin/user id, or create a system user if none exists."""
    from sqlalchemy import select
    result = await db.execute(select(User).limit(1))
    user = result.scalar_one_or_none()
    if user:
        return user.id

    system_user = User(
        id=_uuid(),
        codename="system",
        nickname="System",
        password_hash=None,
        device_id="system",
        role="admin",
    )
    db.add(system_user)
    await db.flush()
    logger.info("Created system user for built-in providers: %s", system_user.id)
    return system_user.id


# ------------------------------------------------------------------
# Migration report
# ------------------------------------------------------------------

@dataclass
class MigrationReport:
    skipped: bool = False
    reason: str = ""
    migrated_providers: int = 0
    migrated_models: int = 0
    upserted_providers: int = 0
    upserted_models: int = 0
    errors: list[str] = field(default_factory=list)


# ------------------------------------------------------------------
# YAML I/O
# ------------------------------------------------------------------

def _load_yaml(path: Path) -> ProvidersYaml:
    raw = yaml.safe_load(path.read_text("utf-8"))
    return ProvidersYaml(**raw)


def _save_yaml(path: Path, data: ProvidersYaml) -> None:
    """Atomic write: temp file + os.replace()."""
    tmp = path.with_suffix(".yaml.tmp")
    tmp.write_text(
        yaml.safe_dump(data.model_dump(mode="json"), allow_unicode=True, sort_keys=False),
        encoding="utf-8",
    )
    os.replace(str(tmp), str(path))


# ------------------------------------------------------------------
# Legacy config.yaml migration
# ------------------------------------------------------------------

async def migrate_from_legacy_config(
    yaml_path: Path = PROVIDERS_YAML_PATH,
    legacy_config_path: Path = LEGACY_CONFIG_PATH,
) -> MigrationReport:
    """One-shot migration from engine/config.yaml provider.* section.

    Called when providers.yaml does not exist.
    """
    if yaml_path.exists():
        return MigrationReport(skipped=True, reason="providers.yaml already exists")

    providers: list[ProviderConfig] = []

    if legacy_config_path.exists():
        try:
            raw = yaml.safe_load(legacy_config_path.read_text("utf-8"))
            legacy = raw.get("provider", {}) if raw else {}
            for name, cfg in legacy.items():
                prov = ProviderConfig(
                    id=f"legacy-{name}",
                    provider_type=name,
                    display_name=name.capitalize(),
                    is_builtin=False,
                    base_url=cfg.get("base_url", ""),
                    auth_mode="api_key",
                    api_key_encrypted=encrypt_value(cfg.get("api_key", "")),
                    request_timeout=120.0,
                    max_retries=3,
                    models=[
                        ModelConfig(
                            id=cfg.get("model", "unknown"),
                            display_name=cfg.get("model", "unknown"),
                            context_window=64000,
                            max_output_tokens=4096,
                        )
                    ],
                )
                providers.append(prov)
            logger.info("Migrated %d providers from legacy config.yaml", len(providers))
        except Exception as exc:
            logger.warning("Legacy config migration failed: %s", exc)

    if not providers:
        # No legacy config either — create empty providers.yaml
        logger.info("No legacy config found; creating empty providers.yaml")

    root = ProvidersYaml(
        schema_version=2,
        last_modified=__import__("datetime").datetime.now().isoformat(),
        providers=providers,
    )
    _save_yaml(yaml_path, root)
    return MigrationReport(
        skipped=False,
        migrated_providers=len(providers),
        migrated_models=sum(len(p.models) for p in providers),
    )


# ------------------------------------------------------------------
# YAML <-> DB sync
# ------------------------------------------------------------------

async def sync_yaml_to_db(db) -> MigrationReport:
    """Idempotent upsert of providers.yaml into ComputeProvider + LLMModel tables.

    Called on every startup after YAML is validated.
    """
    report = MigrationReport()

    # Strict validity check before any DB mutation. A missing, empty, or
    # unparseable YAML must never be used as authority to delete DB rows.
    try:
        if not PROVIDERS_YAML_PATH.exists():
            raise FileNotFoundError(f"not found: {PROVIDERS_YAML_PATH}")
        content = PROVIDERS_YAML_PATH.read_text("utf-8").strip()
        if not content:
            raise ValueError("empty file")
        root = _load_yaml(PROVIDERS_YAML_PATH)
        if not root.providers:
            raise ValueError("providers list is empty")
    except Exception as exc:
        logger.error("Skipping orphan cleanup due to invalid provider YAML: %s", exc)
        report.errors.append(str(exc))
        return report

    from sqlalchemy import select

    system_user_id = await _ensure_system_user(db)

    # Gather existing IDs
    prov_result = await db.execute(select(ComputeProvider.id))
    existing_prov_ids = {r for (r,) in prov_result.all()}

    model_result = await db.execute(select(LLMModel.id))
    existing_model_ids = {r for (r,) in model_result.all()}

    yaml_prov_ids = set()
    yaml_model_ids = set()

    for cfg in root.providers:
        yaml_prov_ids.add(cfg.id)
        try:
            prov = await _upsert_provider(db, cfg, system_user_id, existing_prov_ids)
            report.upserted_providers += 1
        except Exception as exc:
            logger.warning("Upsert provider %s failed: %s", cfg.id, exc)
            report.errors.append(f"provider {cfg.id}: {exc}")
            continue

        for mcfg in cfg.models:
            composite_id = f"{cfg.id}::{mcfg.id}"
            yaml_model_ids.add(composite_id)
            try:
                await _upsert_model(db, mcfg, cfg.id, system_user_id, composite_id, existing_model_ids)
                report.upserted_models += 1
            except Exception as exc:
                logger.warning("Upsert model %s failed: %s", composite_id, exc)
                report.errors.append(f"model {composite_id}: {exc}")

    # Soft-delete built-in providers not in yaml (should not happen normally)
    # Hard-delete custom providers not in yaml
    orphaned_provs = existing_prov_ids - yaml_prov_ids
    for op_id in orphaned_provs:
        try:
            op = await db.get(ComputeProvider, op_id)
            if op and not op.is_builtin:
                await db.delete(op)
                logger.info("Deleted orphaned custom provider: %s", op_id)
        except Exception as exc:
            logger.warning("Delete orphaned provider %s failed: %s", op_id, exc)

    orphaned_models = existing_model_ids - yaml_model_ids
    for om_id in orphaned_models:
        try:
            om = await db.get(LLMModel, om_id)
            if om:
                await db.delete(om)
                logger.info("Deleted orphaned model: %s", om_id)
        except Exception as exc:
            logger.warning("Delete orphaned model %s failed: %s", om_id, exc)

    await db.commit()
    logger.info(
        "providers.yaml synced: %d providers, %d models (%d errors)",
        report.upserted_providers,
        report.upserted_models,
        len(report.errors),
    )
    return report


async def _upsert_provider(
    db,
    cfg: ProviderConfig,
    user_id: str,
    existing_ids: set[str],
) -> ComputeProvider:
    # Defensive: some DB schemas may have api_key_encrypted as NOT NULL.
    # Normalize legacy plaintext/base64 values into the current encrypted format.
    api_key_enc = _normalize_api_key(cfg.api_key_encrypted)
    if cfg.id in existing_ids:
        prov = await db.get(ComputeProvider, cfg.id)
        # Update fields from yaml
        prov.provider_type = cfg.provider_type
        prov.display_name = cfg.display_name
        prov.status = cfg.status
        prov.base_url = cfg.base_url
        prov.auth_mode = cfg.auth_mode
        prov.api_key_encrypted = api_key_enc
        prov.custom_headers = cfg.custom_headers or {}
        prov.request_timeout = cfg.request_timeout
        prov.max_retries = cfg.max_retries
        prov.rate_limit_qpm = cfg.rate_limit_qpm
        prov.require_api_key = cfg.require_api_key
        prov.is_builtin = cfg.is_builtin
        prov.description = cfg.description
        logger.debug("Updated provider: %s", cfg.id)
    else:
        prov = ComputeProvider(
            id=cfg.id,
            user_id=user_id,
            provider_type=cfg.provider_type,
            display_name=cfg.display_name,
            status=cfg.status,
            api_key_encrypted=api_key_enc,
            config={},
            base_url=cfg.base_url,
            auth_mode=cfg.auth_mode,
            custom_headers=cfg.custom_headers or {},
            request_timeout=cfg.request_timeout,
            max_retries=cfg.max_retries,
            rate_limit_qpm=cfg.rate_limit_qpm,
            require_api_key=cfg.require_api_key,
            is_builtin=cfg.is_builtin,
            description=cfg.description,
        )
        db.add(prov)
        logger.info("Inserted provider: %s", cfg.id)
    return prov


async def _upsert_model(
    db,
    cfg: ModelConfig,
    provider_id: str,
    user_id: str,
    composite_id: str,
    existing_ids: set[str],
) -> LLMModel:
    pricing_json = cfg.pricing.model_dump(mode="json") if cfg.pricing else None
    if composite_id in existing_ids:
        m = await db.get(LLMModel, composite_id)
        m.display_name = cfg.display_name
        m.status = cfg.status
        m.context_window = cfg.context_window
        m.max_output_tokens = cfg.max_output_tokens
        m.supports_multimodal = cfg.supports_multimodal
        m.input_modalities = cfg.input_modalities
        m.output_modalities = cfg.output_modalities
        m.supports_streaming = cfg.supports_streaming
        m.supports_tool_calling = cfg.supports_tool_calling
        m.supports_reasoning = cfg.supports_reasoning
        m.is_default = cfg.is_default
        m.model_type = cfg.model_type or "llm"
        m.pricing = pricing_json
        logger.debug("Updated model: %s", composite_id)
    else:
        m = LLMModel(
            id=composite_id,
            provider_id=provider_id,
            user_id=user_id,
            display_name=cfg.display_name,
            is_builtin=cfg.is_builtin,
            status=cfg.status,
            context_window=cfg.context_window,
            max_output_tokens=cfg.max_output_tokens,
            supports_multimodal=cfg.supports_multimodal,
            input_modalities=cfg.input_modalities,
            output_modalities=cfg.output_modalities,
            supports_streaming=cfg.supports_streaming,
            supports_tool_calling=cfg.supports_tool_calling,
            supports_reasoning=cfg.supports_reasoning,
            is_default=cfg.is_default,
            model_type=cfg.model_type or "llm",
            pricing=pricing_json,
        )
        db.add(m)
        logger.info("Inserted model: %s", composite_id)
    return m
