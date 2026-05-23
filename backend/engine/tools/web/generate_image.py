"""Image generation tool using OpenAI-compatible API."""

from __future__ import annotations

import base64
import logging
import uuid
from pathlib import Path

from ...tool.registry import tool_registry

logger = logging.getLogger(__name__)

UPLOAD_DIR = Path.home() / ".cloudmind-zome" / "uploads" / "generated"


def _get_image_config() -> dict:
    """Read image_gen config from the engine config."""
    try:
        from ...config.loader import load_config
        from pathlib import Path as P

        cfg_path = P(__file__).parent.parent.parent / "config.yaml"
        cfg = load_config(str(cfg_path))
        return getattr(cfg, "image_gen", {}) or {}
    except Exception:
        return {}


@tool_registry.register(toolset="web", max_result_chars=500, safe_to_parallel=False, timeout=120)
async def generate_image(prompt: str, size: str = "1024x1024") -> str:
    """Generate an image from a text prompt and share it to the chat.

    Uses the configured image generation API (DALL-E compatible).
    The generated image will be displayed directly in the chat.

    Args:
        prompt: A detailed description of the image to generate.
        size: Image size. Options: "1024x1024", "1792x1024", "1024x1792".
              Default is "1024x1024".
    """
    cfg = _get_image_config()
    api_url = (cfg.get("api_url") or "").strip()
    model = (cfg.get("model") or "").strip()
    api_key = (cfg.get("api_key") or "").strip()

    if not api_url or not api_key:
        return "Error: image generation not configured. Please set api_url, model, and api_key in system settings."

    import httpx

    # Build endpoint: handle both "https://host" and "https://host/v1"
    base = api_url.rstrip('/')
    if base.endswith('/v1'):
        endpoint = f"{base}/images/generations"
    else:
        endpoint = f"{base}/v1/images/generations"

    logger.info("generate_image calling %s with model %s", endpoint, model)

    try:
        async with httpx.AsyncClient(timeout=120) as client:
            resp = await client.post(
                endpoint,
                json={
                    "model": model or "dall-e-3",
                    "prompt": prompt,
                    "n": 1,
                    "size": size,
                    "response_format": "b64_json",
                },
                headers={
                    "Authorization": f"Bearer {api_key}",
                    "Content-Type": "application/json",
                },
            )

            if resp.status_code != 200:
                err = resp.text[:300]
                logger.error("Image generation API error %s: %s", resp.status_code, err)
                return f"Error: image generation failed (HTTP {resp.status_code} | {endpoint})"

            data = resp.json()
            images = data.get("data", [])
            if not images:
                return "Error: no image returned by API"

            b64 = images[0].get("b64_json", "")
            if not b64:
                url = images[0].get("url", "")
                if url:
                    return f"[image:{url}]"
                return "Error: empty image data"

            # Save to uploads
            UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
            filename = f"{uuid.uuid4().hex}.png"
            dest = UPLOAD_DIR / filename
            dest.write_bytes(base64.b64decode(b64))

            share_url = f"/uploads/generated/{filename}"
            return f"[image:{share_url}]"

    except Exception as exc:
        logger.exception("generate_image failed")
        return f"Error: {exc}"
