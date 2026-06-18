#!/usr/bin/env python3
"""Prepare an embedded Python 3.11 runtime for Tauri Windows bundle.

This script downloads the official Windows embeddable Python zip, extracts it
into frontend/src-tauri/runtime/python/, installs backend/requirements.txt,
and patches python311._pth so the bundled backend/ directory is on sys.path.

It is idempotent: if the runtime already exists, download/setup is skipped.
"""

from __future__ import annotations

import logging
import os
import platform
import shutil
import subprocess
import sys
import urllib.request
import zipfile
from pathlib import Path

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------
PYTHON_VERSION = "3.11.9"
EMBED_ZIP = f"python-{PYTHON_VERSION}-embed-amd64.zip"

# Prefer HuaweiCloud mirror, fallback to python.org official CDN.
MIRRORS = [
    f"https://mirrors.huaweicloud.com/python/{PYTHON_VERSION}/{EMBED_ZIP}",
    f"https://www.python.org/ftp/python/{PYTHON_VERSION}/{EMBED_ZIP}",
]

GET_PIP_URL = "https://bootstrap.pypa.io/get-pip.py"

ROOT = Path(__file__).resolve().parent.parent
RUNTIME_DIR = ROOT / "frontend" / "src-tauri" / "runtime" / "python"
PTH_FILE = RUNTIME_DIR / "python311._pth"
SITE_PACKAGES = RUNTIME_DIR / "Lib" / "site-packages"
REQUIREMENTS = ROOT / "backend" / "requirements.txt"
LOG_FILE = ROOT / "scripts" / "prepare_embedded_python.log"

# ---------------------------------------------------------------------------
# Logging
# ---------------------------------------------------------------------------
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    handlers=[
        logging.FileHandler(LOG_FILE, encoding="utf-8", mode="a"),
        logging.StreamHandler(sys.stdout),
    ],
)
logger = logging.getLogger("prepare_embedded_python")


def ensure_dir(path: Path) -> None:
    path.mkdir(parents=True, exist_ok=True)


def download_file(url: str, dest: Path) -> bool:
    """Download url to dest, return True on success."""
    logger.info("Downloading %s -> %s", url, dest)
    try:
        urllib.request.urlretrieve(url, dest)
        return True
    except Exception as exc:  # noqa: BLE001
        logger.warning("Failed to download from %s: %s", url, exc)
        return False


def download_with_fallback(filename: str, urls: list[str], dest: Path) -> bool:
    """Try each URL until one succeeds."""
    if dest.exists():
        logger.info("%s already exists, skipping download.", dest)
        return True

    for url in urls:
        if download_file(url, dest):
            logger.info("Downloaded %s successfully.", filename)
            return True
    logger.error("All download sources failed for %s.", filename)
    return False


def extract_zip(zip_path: Path, dest_dir: Path) -> bool:
    """Extract zip_path into dest_dir."""
    logger.info("Extracting %s to %s", zip_path, dest_dir)
    try:
        with zipfile.ZipFile(zip_path, "r") as zf:
            zf.extractall(dest_dir)
        return True
    except Exception as exc:  # noqa: BLE001
        logger.error("Failed to extract %s: %s", zip_path, exc)
        return False


def patch_pth_file(pth: Path) -> None:
    """Patch python311._pth to include site-packages and the bundled backend."""
    logger.info("Patching %s", pth)
    lines = pth.read_text(encoding="utf-8").splitlines()

    # Keep builtin entries, remove existing imports if present to avoid duplicates.
    cleaned: list[str] = []
    for line in lines:
        stripped = line.strip()
        if stripped in {"import site", "Lib\\site-packages", "..\\..\\..\\backend"}:
            continue
        cleaned.append(line)

    # Append our custom paths and enable site module.
    cleaned.append("")
    cleaned.append("Lib\\site-packages")
    cleaned.append("..\\..\\..\\backend")
    cleaned.append("import site")

    pth.write_text("\n".join(cleaned) + "\n", encoding="utf-8")
    logger.info("Patched python._pth successfully.")


def install_pip_into_embedded(target: Path) -> bool:
    """Download and run get-pip.py into the embedded environment."""
    get_pip_script = target.parent / "get-pip.py"
    if not get_pip_script.exists():
        logger.info("Downloading get-pip.py...")
        if not download_file(GET_PIP_URL, get_pip_script):
            return False

    python_exe = RUNTIME_DIR / "python.exe"
    logger.info("Installing pip into embedded Python...")
    cmd = [
        str(python_exe),
        str(get_pip_script),
        "--target",
        str(target),
        "--no-warn-script-location",
        "--no-setuptools",
        "--no-wheel",
    ]
    try:
        subprocess.run(cmd, check=True)
        logger.info("pip installed into embedded Python.")
        return True
    except subprocess.CalledProcessError as exc:
        logger.error("Failed to install pip into embedded Python: %s", exc)
        return False


def install_requirements_embedded(target: Path, requirements: Path) -> bool:
    """Install requirements using the embedded Python's pip."""
    python_exe = RUNTIME_DIR / "python.exe"
    logger.info("Installing requirements via embedded pip: %s", python_exe)
    cmd = [
        str(python_exe),
        "-m",
        "pip",
        "install",
        "-r",
        str(requirements),
        "--target",
        str(target),
        "--upgrade",
        "--no-warn-script-location",
    ]
    try:
        subprocess.run(cmd, check=True)
        logger.info("Requirements installed via embedded pip successfully.")
        return True
    except subprocess.CalledProcessError as exc:
        logger.error("Embedded pip install failed: %s", exc)
        return False


def install_requirements_with_system_pip(target: Path, requirements: Path) -> bool:
    """Fallback: try installing requirements using the system Python's pip."""
    python_exe = sys.executable
    logger.info("Installing requirements via system pip (fallback): %s", python_exe)
    cmd = [
        python_exe,
        "-m",
        "pip",
        "install",
        "-r",
        str(requirements),
        "--target",
        str(target),
        "--upgrade",
        "--python-version",
        "3.11",
        "--only-binary=:all:",
    ]
    try:
        subprocess.run(cmd, check=True)
        logger.info("Requirements installed successfully via system pip.")
        return True
    except subprocess.CalledProcessError as exc:
        logger.warning("System pip install failed: %s", exc)
        return False


def main() -> int:
    logger.info("=" * 60)
    logger.info("Starting embedded Python preparation")
    logger.info("Platform: %s", platform.system())

    if platform.system() != "Windows":
        logger.error("This script only supports Windows.")
        return 1

    ensure_dir(RUNTIME_DIR)
    ensure_dir(SITE_PACKAGES)

    zip_path = RUNTIME_DIR / EMBED_ZIP

    # 1. Download embeddable Python if not present.
    if not download_with_fallback(EMBED_ZIP, MIRRORS, zip_path):
        return 1

    # 2. Extract if python.exe is missing.
    python_exe = RUNTIME_DIR / "python.exe"
    if not python_exe.exists():
        if not extract_zip(zip_path, RUNTIME_DIR):
            return 1
    else:
        logger.info("python.exe already exists, skipping extraction.")

    # 3. Patch python._pth.
    if PTH_FILE.exists():
        patch_pth_file(PTH_FILE)
    else:
        logger.error("Expected ._pth file not found: %s", PTH_FILE)
        return 1

    # 4. Install requirements using the embedded Python interpreter.
    #    This ensures ABI compatibility (cp311 wheels) even if the build
    #    machine runs a different Python version.
    if REQUIREMENTS.exists():
        installed = False
        if install_pip_into_embedded(SITE_PACKAGES):
            installed = install_requirements_embedded(SITE_PACKAGES, REQUIREMENTS)

        if not installed:
            logger.warning("Trying system pip install as fallback...")
            installed = install_requirements_with_system_pip(SITE_PACKAGES, REQUIREMENTS)

        if not installed:
            logger.error("Could not install requirements.")
            return 1
    else:
        logger.warning("requirements.txt not found at %s", REQUIREMENTS)

    # 5. Cleanup development-only artifacts to reduce bundle size.
    logger.info("Cleaning up development-only artifacts...")
    zip_path.unlink(missing_ok=True)
    get_pip_script = SITE_PACKAGES.parent / "get-pip.py"
    get_pip_script.unlink(missing_ok=True)

    # *.lib files are static import libraries used at compile time; runtime
    # only needs *.pyd / *.dll / *.so.
    removed_libs = 0
    for lib_file in SITE_PACKAGES.rglob("*.lib"):
        try:
            lib_file.unlink()
            removed_libs += 1
        except OSError as exc:
            logger.warning("Could not remove %s: %s", lib_file, exc)
    logger.info("Removed %d .lib files.", removed_libs)

    # 6. Sanity check.
    logger.info("Sanity check: running embedded Python --version")
    try:
        result = subprocess.run(
            [str(python_exe), "--version"],
            capture_output=True,
            text=True,
            check=True,
        )
        logger.info(result.stdout.strip() or result.stderr.strip())
    except subprocess.CalledProcessError as exc:
        logger.error("Embedded Python sanity check failed: %s", exc)
        return 1

    logger.info("Embedded Python runtime ready at: %s", RUNTIME_DIR)
    logger.info("=" * 60)
    return 0


if __name__ == "__main__":
    sys.exit(main())
