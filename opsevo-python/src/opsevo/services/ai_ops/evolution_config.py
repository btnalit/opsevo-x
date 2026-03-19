"""EvolutionConfigManager — hot-reload config using watchfiles (replaces chokidar).

Requirements: 9.3, 9.4
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Callable

from opsevo.utils.logger import get_logger

logger = get_logger(__name__)


class EvolutionConfigManager:
    def __init__(self, config_path: str = "data/ai-ops/evolution-config.json"):
        self._path = Path(config_path)
        self._config: dict[str, Any] = {}
        self._watchers: list[Callable[[dict[str, Any]], None]] = []
        self._watch_task: Any = None

    def load(self) -> dict[str, Any]:
        if self._path.exists():
            self._config = json.loads(self._path.read_text(encoding="utf-8"))
        else:
            self._config = self._defaults()
        logger.info("evolution_config_loaded", keys=len(self._config))
        return self._config

    def get(self, key: str, default: Any = None) -> Any:
        return self._config.get(key, default)

    def set(self, key: str, value: Any) -> None:
        self._config[key] = value
        self._save()

    def on_change(self, callback: Callable[[dict[str, Any]], None]) -> None:
        self._watchers.append(callback)

    async def start_watching(self) -> None:
        try:
            import asyncio
            from watchfiles import awatch
            async def _watch():
                async for _ in awatch(str(self._path.parent)):
                    if self._path.exists():
                        old = dict(self._config)
                        self.load()
                        if old != self._config:
                            for cb in self._watchers:
                                try:
                                    cb(self._config)
                                except Exception:
                                    pass
            self._watch_task = asyncio.create_task(_watch())
            logger.info("evolution_config_watching_started")
        except ImportError:
            logger.warning("watchfiles_not_installed")

    async def stop_watching(self) -> None:
        if self._watch_task:
            self._watch_task.cancel()
            self._watch_task = None

    def _save(self) -> None:
        self._path.parent.mkdir(parents=True, exist_ok=True)
        self._path.write_text(json.dumps(self._config, ensure_ascii=False, indent=2), encoding="utf-8")

    @staticmethod
    def _defaults() -> dict[str, Any]:
        return {
            "evolution_enabled": True,
            "learning_rate": 0.1,
            "max_iterations": 100,
            "quality_threshold": 0.7,
        }
