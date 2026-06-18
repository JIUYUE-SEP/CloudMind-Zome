"""Generic file upload API."""

from __future__ import annotations

import shutil
import uuid
from pathlib import Path

from fastapi import APIRouter, Depends, File, HTTPException, UploadFile
from pydantic import BaseModel

from ..database import UPLOAD_DIR
from ..dependencies import require_user

router = APIRouter(prefix="/upload", tags=["upload"])

MAX_UPLOAD_SIZE_MB = 50


class UploadResp(BaseModel):
    code: int = 0
    data: dict


@router.post("", response_model=UploadResp)
async def upload_file(
    file: UploadFile = File(...),
    folder: str = "attachments",
    user=Depends(require_user),
):
    # Security: sanitize folder name
    safe_folder = "".join(c for c in folder if c.isalnum() or c in "_-").rstrip("/")
    if not safe_folder:
        safe_folder = "attachments"

    # Size check (read up to limit + 1 bytes)
    file.file.seek(0, 2)
    size = file.file.tell()
    file.file.seek(0)
    if size > MAX_UPLOAD_SIZE_MB * 1024 * 1024:
        raise HTTPException(status_code=413, detail=f"File exceeds {MAX_UPLOAD_SIZE_MB}MB")

    ext = Path(file.filename or "file").suffix
    filename = f"{uuid.uuid4().hex}{ext}"
    dest_dir = UPLOAD_DIR / safe_folder
    dest_dir.mkdir(parents=True, exist_ok=True)
    dest = dest_dir / filename

    with dest.open("wb") as f:
        shutil.copyfileobj(file.file, f)

    url = f"/uploads/{safe_folder}/{filename}"
    return UploadResp(
        data={
            "url": url,
            "filename": filename,
            "size": dest.stat().st_size,
        }
    )
