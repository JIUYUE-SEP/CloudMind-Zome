"""Hot-reload configuration using watchfiles.

Design reference: §6.8.4 热更新
"""

from __future__ import annotations

import asyncio
import logging
from pathlib import Path
from typing import Callable

from .loader import load_config
from .models import AppConfig

logger = logging.getLogger(__name__)


class ConfigWatcher:
    """Watches config.yaml for changes and reloads the AppConfig.

    Hot-reloadable fields take effect on the next ReAct loop iteration.
    Non-hot-reloadable fields (e.g. toolsets) require a restart.
    """

    HOT_RELOADABLE_FIELDS = {
        "provider.deepseek.api_key",
        "provider.deepseek.base_url",
        "provider.mimo.api_key",
        "provider.mimo.base_url",
        "provider.kimicode.api_key",
        "provider.kimicode.base_url",
        "provider.glm.api_key",
        "provider.glm.base_url",
        "provider.default",
        "provider.fallback_chain",
        "agent.max_turns",
        "agent.identity",
        "agent.smart_stop",
        "context.compact_threshold",
        "context.keep_recent",
        "context.hot_memory_limit",
        "context.warm_memory_limit",
    }

    NON_HOT_RELOADABLE_FIELDS = {
        "tools.toolsets",  # Tool registration happens at startup
    }

    def __init__(
        self,
        config_path: Path,
        on_reload: Callable[[AppConfig], None] | None = None,
    ):
        self.config_path = config_path
        self.on_reload = on_reload
        self._current_config: AppConfig = load_config(config_path)
        self._watch_task: asyncio.Task | None = None

    @property
    def config(self) -> AppConfig:
        """Current configuration."""
        return self._current_config

    async def start_watching(self) -> None:
        """Start watching config file for changes."""
        try:
            from watchfiles import awatch
        except ImportError:
            logger.warning("watchfiles not installed, hot-reload disabled")
            return

        async def _watch():
            async for changes in awatch(self.config_path):
                logger.info("Config file changed, reloading...")
                try:
                    new_config = load_config(self.config_path)
                    old_config = self._current_config
                    self._current_config = new_config
                    if self.on_reload:
                        self.on_reload(new_config)
                    logger.info("Config reloaded successfully")
                except Exception as e:
                    logger.error("Failed to reload config: %s", e)

        self._watch_task = asyncio.create_task(_watch())

    async def stop_watching(self) -> None:
        """Stop watching config file."""
        if self._watch_task:
            self._watch_task.cancel()
            try:
                await self._watch_task
            except asyncio.CancelledError:
                pass