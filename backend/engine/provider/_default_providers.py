"""Default provider templates. Exported to llmprovider/ on first run."""
from pathlib import Path
import json

LLMPROVIDER_DIR = Path.home() / ".cloudmind-zome" / "llmprovider"

DEFAULT_PROVIDERS = {
    "deepseek.json": {
        "name": "deepseek",
        "display_name": "DeepSeek",
        "base_url": "https://api.deepseek.com/v1",
        "api_key": "${DEEPSEEK_API_KEY}",
        "default_model": "deepseek-chat",
        "models": ["deepseek-chat", "deepseek-reasoner"],
        "supports_streaming": True,
        "supports_vision": False,
        "supports_reasoning": True,
        "marker_model": "deepseek-chat",
    },
    "siliconflow.json": {
        "name": "siliconflow",
        "display_name": "SiliconFlow",
        "base_url": "https://api.siliconflow.cn/v1",
        "api_key": "${SILICONFLOW_API_KEY}",
        "default_model": "deepseek-ai/DeepSeek-V3",
        "models": ["deepseek-ai/DeepSeek-V3", "deepseek-ai/DeepSeek-R1", "BAAI/bge-m3"],
        "supports_streaming": True,
        "supports_vision": False,
        "supports_reasoning": True,
        "marker_model": "deepseek-ai/DeepSeek-V3",
        "embedding_model": "BAAI/bge-m3",
    },
}


def ensure_default_providers() -> None:
    LLMPROVIDER_DIR.mkdir(parents=True, exist_ok=True)
    for filename, data in DEFAULT_PROVIDERS.items():
        path = LLMPROVIDER_DIR / filename
        if not path.exists():
            path.write_text(
                json.dumps(data, indent=2, ensure_ascii=False),
                encoding="utf-8",
            )
