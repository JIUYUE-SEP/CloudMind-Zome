#!/usr/bin/env python3
"""Package the Python backend into frontend/src-tauri/backend/ for Tauri bundling.

Copies backend/ while excluding caches, tests, logs, and other development-only
artifacts.  Keeps the tree idempotent: running again wipes the destination first.
"""

from __future__ import annotations

import logging
import shutil
import sys
from pathlib import Path

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    handlers=[logging.StreamHandler(sys.stdout)],
)
logger = logging.getLogger("package_backend")

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "backend"
DST = ROOT / "frontend" / "src-tauri" / "backend"

EXCLUDE_DIRS = {
    "__pycache__",
    ".pytest_cache",
    "tests",
    ".git",
    ".venv",
    "venv",
    ".mypy_cache",
    ".ruff_cache",
    ".tox",
}

EXCLUDE_PATTERNS = (
    "*.pyc",
    "*.pyo",
    "*.pyd",
    "*.log",
    "*.db",
    ".DS_Store",
    "*.sqlite",
    "*.sqlite3",
)

# Windows reserved device names that cannot be used as filenames.
RESERVED_NAMES = {
    "CON", "PRN", "AUX", "NUL",
    "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8", "COM9",
    "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
}


def should_copy(path: Path, relative: Path) -> bool:
    """Return False for excluded directories/files."""
    if any(part in EXCLUDE_DIRS for part in relative.parts):
        return False
    if any(path.match(pat) for pat in EXCLUDE_PATTERNS):
        return False
    if path.name.upper() in RESERVED_NAMES:
        logger.warning("Skipping Windows reserved name: %s", relative)
        return False
    # Also skip any nested __pycache__ even if parent wasn't caught.
    if "__pycache__" in relative.parts:
        return False
    return True


def copy_backend() -> None:
    """Mirror backend/ into frontend/src-tauri/backend/."""
    logger.info("Cleaning destination: %s", DST)
    if DST.exists():
        shutil.rmtree(DST)
    DST.mkdir(parents=True, exist_ok=True)

    total_files = 0
    for src_path in SRC.rglob("*"):
        relative = src_path.relative_to(SRC)
        if not should_copy(src_path, relative):
            continue
        dst_path = DST / relative
        if src_path.is_dir():
            dst_path.mkdir(parents=True, exist_ok=True)
        else:
            dst_path.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(src_path, dst_path)
            total_files += 1

    logger.info("Copied %d files to %s", total_files, DST)


def ensure_config() -> None:
    """Keep config.yaml.example and create config.yaml from it if missing."""
    config_example = DST / "engine" / "config.yaml.example"
    config = DST / "engine" / "config.yaml"

    if not config_example.exists():
        logger.warning("config.yaml.example not found in packaged backend.")
        return

    if not config.exists():
        shutil.copy2(config_example, config)
        logger.info("Created config.yaml from config.yaml.example")
    else:
        logger.info("config.yaml already exists")


def main() -> int:
    if not SRC.exists():
        logger.error("Source backend directory not found: %s", SRC)
        return 1

    copy_backend()
    ensure_config()
    logger.info("Backend packaged successfully.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
