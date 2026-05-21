"""Configuration loader: YAML + environment variable substitution.

Design reference: §6.8.3 加载流程
    config.yaml → YAML parse → env var substitution → pydantic validation → AppConfig
"""

from __future__ import annotations

import os
import re
from pathlib import Path
from typing import Any

import yaml
from .models import AppConfig

# Pattern: ${VAR} or ${VAR:-default}
_ENV_VAR_PATTERN = re.compile(r"\$\{([^}]+)\}")


def _substitute_env_vars(value: Any) -> Any:
    """Recursively substitute ${VAR} and ${VAR:-default} in config values."""

    def _replace(match: re.Match) -> str:
        expr = match.group(1)
        if ":-" in expr:
            var_name, default = expr.split(":-", 1)
            return os.environ.get(var_name.strip(), default.strip())
        return os.environ.get(expr.strip(), "")

    if isinstance(value, str):
        return _ENV_VAR_PATTERN.sub(_replace, value)
    elif isinstance(value, dict):
        return {k: _substitute_env_vars(v) for k, v in value.items()}
    elif isinstance(value, list):
        return [_substitute_env_vars(v) for v in value]
    return value


def load_config(config_path: str | Path | None = None) -> AppConfig:
    """Load configuration from YAML file with environment variable substitution.

    Args:
        config_path: Path to config.yaml. If None, searches default locations.

    Returns:
        Validated AppConfig instance.

    Raises:
        FileNotFoundError: If config file not found.
        yaml.YAMLError: If YAML parsing fails.
        pydantic.ValidationError: If validation fails.
    """
    if config_path is None:
        # Search default locations
        search_paths = [
            Path("config.yaml"),
            Path("~/.agenschedule/config.yaml").expanduser(),
        ]
        for p in search_paths:
            if p.exists():
                config_path = p
                break
        else:
            # Use defaults
            return AppConfig()

    config_path = Path(config_path)
    if not config_path.exists():
        raise FileNotFoundError(f"Config file not found: {config_path}")

    # 1. Parse YAML
    with open(config_path, "r", encoding="utf-8") as f:
        raw_config = yaml.safe_load(f)

    if raw_config is None:
        return AppConfig()

    # 2. Substitute environment variables
    raw_config = _substitute_env_vars(raw_config)

    # 3. Validate with pydantic → AppConfig
    return AppConfig(**raw_config)