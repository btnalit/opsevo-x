"""ServiceLifecycle — background task management pattern to prevent CPU spikes.

Requirements: 9.10
"""

from __future__ import annotations

import asyncio
from typing import Any, Callable, Awaitable

from opsevo.utils.logger import get_logger

logger = get_logger(__name__)


class ServiceLifecycle:
    """Manages background asyncio tasks with graceful start/stop."""

    def __init__(self) -> None:
        self._tasks: dict[str, asyncio.Task[Any]] = {}
        self._running = False

    async def start(self) -> None:
        self._running = True
        logger.info("service_lifecycle_started", tasks=len(self._tasks))

    async def stop(self) -> None:
        self._running = False
        for name, task in self._tasks.items():
            task.cancel()
            try:
                await task
            except asyncio.CancelledError:
                pass
            logger.debug("service_lifecycle_task_stopped", name=name)
        self._tasks.clear()
        logger.info("service_lifecycle_stopped")

    def register_periodic(self, name: str, callback: Callable[..., Awaitable[Any]],
                          interval_seconds: float) -> None:
        async def _loop():
            while self._running:
                try:
                    await callback()
                except asyncio.CancelledError:
                    break
                except Exception as exc:
                    logger.error("service_lifecycle_task_error", name=name, error=str(exc))
                await asyncio.sleep(interval_seconds)

        if name in self._tasks:
            self._tasks[name].cancel()
        self._tasks[name] = asyncio.create_task(_loop())

    def is_running(self) -> bool:
        return self._running

    def get_task_names(self) -> list[str]:
        return list(self._tasks.keys())
