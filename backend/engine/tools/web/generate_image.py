"""Image generation tool using OpenAI-compatible API."""

from __future__ import annotations

import base64
import logging
import uuid
from pathlib import Path

from ...tool.registry import tool_registry

logger = logging.getLogger(__name__)

UPLOAD_DIR = Path.home() / ".cloudmind-zome" / "uploads" / "generated"


def _detect_provider_type(api_url: str) -> str:
    url_lower = api_url.lower()
    if "dashscope" in url_lower or "aliyun" in url_lower:
        return "dashscope"
    return "openai"


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
    """Generate an image from a text prompt.

    Uses the configured image generation API (DALL-E compatible).
    Returns a local shareable URL in the format [image:/uploads/generated/xxx.png].
    To display the image in chat, pass this path directly to the share_file tool.

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

    provider = _detect_provider_type(api_url)

    # Build endpoint
    base = api_url.rstrip('/')
    if base.endswith('/images/generations'):
        endpoint = base
    elif base.endswith('/v1'):
        if provider == "dashscope":
            endpoint = f"{base}/images/generations"
        else:
            endpoint = f"{base}/images/generations"
    else:
        if provider == "dashscope":
            endpoint = base  # DashScope native endpoint, use as-is
        else:
            endpoint = f"{base}/v1/images/generations"

    logger.info("generate_image calling %s (provider=%s, model=%s)", endpoint, provider, model)

    try:
        async with httpx.AsyncClient(timeout=120) as client:
            if provider == "dashscope":
                # DashScope Qwen-Image format
                dashscope_size = size.replace("x", "*")
                request_body = {
                    "model": model,
                    "input": {
                        "prompt": prompt,
                    },
                    "parameters": {
                        "size": dashscope_size,
                        "n": 1,
                    },
                }
            else:
                # OpenAI format
                request_body = {
                    "model": model or "dall-e-3",
                    "prompt": prompt,
                    "n": 1,
                    "size": size,
                    "response_format": "b64_json",
                }

            resp = await client.post(
                endpoint,
                json=request_body,
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
            b64 = ""
            url = ""

            if provider == "dashscope":
                # DashScope format 1: output.choices[].message.content[].image
                output = data.get("output", {})
                choices = output.get("choices", [])
                if choices:
                    content = choices[0].get("message", {}).get("content", [])
                    for item in content:
                        if isinstance(item, dict) and item.get("image"):
                            b64 = item["image"]
                            break
                # DashScope format 2: output.results[].url
                if not b64 and not url:
                    results = output.get("results", [])
                    if results:
                        url = results[0].get("url", "")
            else:
                # OpenAI format: {"data": [{"b64_json": "...", "url": "..."}]}
                # SiliconFlow format: {"images": [{"url": "..."}]}
                images = data.get("data") or data.get("images", [])
                if images:
                    img_data = images[0]
                    b64 = img_data.get("b64_json", "")
                    url = img_data.get("url", "")

            if not b64 and not url:
                return "Error: no image returned by API"

            # Save to uploads
            UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
            filename = f"{uuid.uuid4().hex}.png"
            dest = UPLOAD_DIR / filename

            if b64:
                dest.write_bytes(base64.b64decode(b64))
                logger.info("Image saved from base64: %s", dest)
            elif url:
                # Download from URL (external or data URL)
                if url.startswith("data:"):
                    # data:image/png;base64,...
                    header, b64_data = url.split(",", 1)
                    dest.write_bytes(base64.b64decode(b64_data))
                    logger.info("Image saved from data URL: %s", dest)
                else:
                    # Download from external URL
                    img_resp = await client.get(url, timeout=60)
                    if img_resp.status_code != 200:
                        return f"Error: failed to download image from {url} (HTTP {img_resp.status_code})"
                    dest.write_bytes(img_resp.content)
                    logger.info("Image downloaded from %s -> %s", url, dest)
            else:
                return "Error: empty image data"

            share_url = f"/uploads/generated/{filename}"
            return f"[image:{share_url}]"

    except Exception as exc:
        logger.exception("generate_image failed")
        return f"Error: {exc}"
