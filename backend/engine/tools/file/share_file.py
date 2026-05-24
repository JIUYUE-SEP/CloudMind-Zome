"""Share tool: Agent shares files/images to the chat."""

from __future__ import annotations

import logging
import shutil
import uuid
from pathlib import Path

from ...tool.registry import tool_registry

logger = logging.getLogger(__name__)

UPLOAD_DIR = Path.home() / ".cloudmind-zome" / "uploads" / "shared"

# Allowed extensions
IMAGE_EXTS = {".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".svg"}
TEXT_EXTS = {".txt", ".md", ".json", ".csv", ".log", ".yaml", ".yml", ".py", ".js", ".ts", ".html", ".css"}
ALLOWED_EXTS = IMAGE_EXTS | TEXT_EXTS

# Max file size (10 MB)
MAX_SIZE = 10 * 1024 * 1024


@tool_registry.register(toolset="file", max_result_chars=1000, safe_to_parallel=True)
def share_file(path: str) -> str:
    """Share a file or image to the chat so the user can see it.

    The file is copied to a public uploads directory and a shareable URL
    is returned. Images will display inline; other files can be downloaded.

    Supports: images (png/jpg/gif/webp/bmp/svg) and text files
    (txt/md/json/csv/log/py/js/ts/html/css/yaml).

    Args:
        path: Path to the file you want to share.
              Can be a local path, or a URL like /uploads/generated/xxx.png
              (will be resolved to the local uploads directory).
    """
    src = _resolve_path(path)

    if not src.exists():
        return f"Error: file not found: {path} (resolved to {src})"

    if src.is_dir():
        return f"Error: {src.name} is a directory, not a file"

    if src.stat().st_size > MAX_SIZE:
        return f"Error: file too large ({src.stat().st_size} bytes, max {MAX_SIZE})"

    ext = src.suffix.lower()
    if ext not in ALLOWED_EXTS:
        return f"Error: unsupported file type '{ext}'. Supported: {', '.join(sorted(ALLOWED_EXTS))}"

    try:
        UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
        filename = f"{uuid.uuid4().hex}{ext}"
        dest = UPLOAD_DIR / filename
        shutil.copy2(src, dest)

        url = f"/uploads/shared/{filename}"
        file_type = "image" if ext in IMAGE_EXTS else "file"
        return f"[{file_type}:{url}]"

    except PermissionError:
        return f"Error: permission denied reading {src}"
    except OSError as exc:
        logger.exception("share_file failed for %s", src)
        return f"Error: {exc}"


def _resolve_path(path: str) -> Path:
    """Resolve a path to a local file.

    Handles:
    - Absolute local paths (C:\... or /home/...)
    - /uploads/... URLs -> ~/.cloudmind-zome/uploads/...
    - ~/... home-relative paths
    """
    p = path.strip()

    # URL-style /uploads/... -> local uploads dir
    if p.startswith("/uploads/"):
        local = Path.home() / ".cloudmind-zome" / p.lstrip("/")
        return local

    # Bare home-relative
    if p.startswith("~/"):
        return Path.home() / p[2:]

    # Normal local path
    return Path(p).expanduser()
