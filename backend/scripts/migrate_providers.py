#!/usr/bin/env python3
"""Migrate provider credentials from config.yaml to llmprovider/*.json.

Run once on first boot. After migration, config.yaml provider credentials
are deprecated; llmprovider/*.json is the sole source.
"""
from __future__ import annotations

import json
import logging
import os
from pathlib import Path

import yaml

from engine.provider._default_providers import LLMPROVIDER_DIR

logger = logging.getLogger(__name__)

MIGRATION_MARKER = LLMPROVIDER_DIR / ".migrated"


def _sanitize_key(key: str) -> str:
    """Replace raw API keys with ${ENV} references."""
    # If key looks like a real key (not empty and not a placeholder), replace with env ref
    if key and not key.startswith("${") and not key.startswith("YOUR_"):
        return f"${{{key[:8].upper()}_API_KEY}}"
    return key


def migrate_providers(config_path: Path | None = None) -> bool:
    """Migrate provider credentials from config.yaml to llmprovider/*.json.

    Returns True if migration was performed, False if skipped.
    """
    if MIGRATION_MARKER.exists():
        return False

    LLMPROVIDER_DIR.mkdir(parents=True, exist_ok=True)

    if config_path is None:
        config_path = Path(__file__).resolve().parent.parent / "engine" / "config.yaml"

    if not config_path.exists():
        logger.info("No config.yaml found, skipping provider migration")
        MIGRATION_MARKER.touch()
        return False

    try:
        with open(config_path, "r", encoding="utf-8") as f:
            config = yaml.safe_load(f) or {}
    except Exception as e:
        logger.warning("Failed to read config.yaml: %s", e)
        MIGRATION_MARKER.touch()
        return False

    providers = config.get("provider", {})
    if not providers:
        MIGRATION_MARKER.touch()
        return False

    migrated_any = False
    for name, cfg in providers.items():
        if name in ("default", "fallback_chain"):
            continue
        if not isinstance(cfg, dict):
            continue

        path = LLMPROVIDER_DIR / f"{name}.json"
        if path.exists():
            logger.info("Provider %s already exists, skipping", name)
            continue

        base_url = cfg.get("base_url", "")
        api_key = cfg.get("api_key", "")
        model = cfg.get("model", "")

        # Skip empty / placeholder configs
        if not base_url and not api_key and not model:
            continue

        # Convert raw api_key to env reference if it looks real
        safe_key = api_key
        if api_key and not api_key.startswith("${") and not api_key.startswith("YOUR_"):
            env_name = f"{name.upper().replace('-', '_')}_API_KEY"
            safe_key = f"${{{env_name}}}"
            # Also set it in the current process environment so it works immediately
            os.environ.setdefault(env_name, api_key)
            logger.info("Migrated API key for %s to env var %s", name, env_name)

        data = {
            "name": name,
            "display_name": name.capitalize(),
            "base_url": base_url,
            "api_key": safe_key,
            "default_model": model,
            "models": [model] if model else [],
            "supports_streaming": True,
            "supports_vision": False,
            "supports_reasoning": False,
        }

        path.write_text(json.dumps(data, indent=2, ensure_ascii=False), encoding="utf-8")
        logger.info("Migrated provider %s -> %s", name, path)
        migrated_any = True

    if migrated_any:
        logger.info(
            "Provider migration complete. Please set environment variables for API keys, "
            "or edit files in %s directly.",
            LLMPROVIDER_DIR,
        )

    MIGRATION_MARKER.touch()
    return migrated_any


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO)
    migrate_providers()
