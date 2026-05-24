"""Image generation tool using OpenAI-compatible API."""

from __future__ import annotations

import base64
import json
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
    elif base.endswith('/services/aigc/multimodal-generation/generation'):
        # Qwen-Image-2 / z-image-turbo native endpoint, use as-is
        endpoint = base
        provider = "qwen_image"
    elif base.endswith('/v1'):
        endpoint = f"{base}/images/generations"
    else:
        if provider == "dashscope":
            endpoint = base  # DashScope native endpoint, use as-is
        else:
            endpoint = f"{base}/v1/images/generations"

    logger.info("generate_image calling %s (provider=%s, model=%s)", endpoint, provider, model)

    try:
        async with httpx.AsyncClient(timeout=120) as client:
            if provider in ("dashscope", "qwen_image"):
                # DashScope Wan-Image / Qwen-Image format (messages-based)
                # size: supports "1K", "2K", "4K" or "1024*1024", "2048*2048" etc.
                dashscope_size = size.replace("x", "*") if "x" in size else size
                request_body = {
                    "model": model,
                    "input": {
                        "messages": [
                            {
                                "role": "user",
                                "content": [
                                    {"text": prompt}
                                ]
                            }
                        ]
                    },
                    "parameters": {
                        "size": dashscope_size,
                        "n": 1,
                        "watermark": False,
                        "thinking_mode": True,
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

            # Write debug info to file
            debug_file = Path("image_gen_debug.log")
            with open(debug_file, "w", encoding="utf-8") as df:
                df.write(f"ENDPOINT: {endpoint}\n")
                df.write(f"REQUEST: {json.dumps(request_body, ensure_ascii=False, indent=2)}\n")
                df.write(f"STATUS: {resp.status_code}\n")
                df.write(f"RESPONSE: {resp.text[:2000]}\n")

            if resp.status_code != 200:
                err = resp.text[:300]
                logger.error("Image generation API error %s: %s", resp.status_code, err)
                return f"Error: image gen failed (HTTP {resp.status_code}). Check image_gen_debug.log for details."

            data = resp.json()

            # Check for API-level error
            if data.get("code"):
                err_msg = data.get("message", "Unknown error")
                logger.error("Image generation API error: %s - %s", data["code"], err_msg)
                return f"Error: {data['code']} - {err_msg}"

            image_urls: list[str] = []

            if provider in ("dashscope", "qwen_image"):
                # DashScope format: output.choices[].message.content[].image (URL)
                output = data.get("output", {})
                choices = output.get("choices", [])
                if choices:
                    content = choices[0].get("message", {}).get("content", [])
                    for item in content:
                        if isinstance(item, dict) and item.get("type") == "image" and item.get("image"):
                            image_urls.append(item["image"])
                # Fallback: old format output.results[].url
                if not image_urls:
                    results = output.get("results", [])
                    for r in results:
                        if r.get("url"):
                            image_urls.append(r["url"])
            else:
                # OpenAI format: {"data": [{"b64_json": "...", "url": "..."}]}
                # SiliconFlow format: {"images": [{"url": "..."}]}
                images = data.get("data") or data.get("images", [])
                for img_data in images:
                    b64 = img_data.get("b64_json", "")
                    url = img_data.get("url", "")
                    if b64:
                        UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
                        filename = f"{uuid.uuid4().hex}.png"
                        dest = UPLOAD_DIR / filename
                        dest.write_bytes(base64.b64decode(b64))
                        image_urls.append(f"/uploads/generated/{filename}")
                    elif url:
                        image_urls.append(url)

            if not image_urls:
                return "Error: no image returned by API"

            # Download and save all DashScope URLs (they expire in 24h)
            saved_urls: list[str] = []
            UPLOAD_DIR.mkdir(parents=True, exist_ok=True)

            for url in image_urls:
                if url.startswith("/uploads/generated/"):
                    # Already saved (OpenAI b64 path)
                    saved_urls.append(url)
                    continue

                filename = f"{uuid.uuid4().hex}.png"
                dest = UPLOAD_DIR / filename

                if url.startswith("data:"):
                    # data:image/png;base64,...
                    header, b64_data = url.split(",", 1)
                    dest.write_bytes(base64.b64decode(b64_data))
                    logger.info("Image saved from data URL: %s", dest)
                else:
                    # Download from external URL
                    img_resp = await client.get(url, timeout=60)
                    if img_resp.status_code != 200:
                        logger.error("Failed to download image from %s (HTTP %s)", url, img_resp.status_code)
                        continue
                    dest.write_bytes(img_resp.content)
                    logger.info("Image downloaded from %s -> %s", url, dest)

                saved_urls.append(f"/uploads/generated/{filename}")

            if not saved_urls:
                return "Error: failed to download any images"

            # Return all image references
            return "\n".join(f"[image:{u}]" for u in saved_urls)

    except Exception as exc:
        logger.exception("generate_image failed")
        return f"Error: {exc}"
