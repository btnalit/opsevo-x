"""Async device connection pool with idle timeout and auto-cleanup.

Requirements: 8.6
"""

from __future__ import annotations

import asyncio
import time
from typing import Any

from opsevo.drivers.base import DeviceDriver
from opsevo.drivers.manager import DeviceDriverManager
from opsevo.drivers.types import DeviceConnectionConfig
from opsevo.utils.logger import get_logger

logger = get_logger(__name__)


class _CachedDriver:
    __slots__ = ("driver", "last_used")

    def __init__(self, driver: DeviceDriver) -> None:
        self.driver = driver
        self.last_used = time.monotonic()


class DevicePool:
    """Async connection cache for device drivers."""

    def __init__(
        self,
        manager: DeviceDriverManager,
        idle_timeout: float = 300.0,
        cleanup_interval: float = 60.0,
    ) -> None:
        self._manager = manager
        self._idle_timeout = idle_timeout
        self._cleanup_interval = cleanup_interval
        self._cache: dict[str, _CachedDriver] = {}
        self._cleanup_task: asyncio.Task | None = None

    async def start(self) -> None:
        self._cleanup_task = asyncio.create_task(self._cleanup_loop())

    async def stop(self) -> None:
        if self._cleanup_task:
            self._cleanup_task.cancel()
            try:
                await self._cleanup_task
            except asyncio.CancelledError:
                pass
        for key, cached in self._cache.items():
            try:
                await cached.driver.disconnect()
            except Exception:
                pass
        self._cache.clear()

    async def get_driver(
        self,
        device_id: str,
        config: DeviceConnectionConfig | None = None,
        profile_name: str | None = None,
    ) -> DeviceDriver:
        cached = self._cache.get(device_id)
        if cached:
            cached.last_used = time.monotonic()
            return cached.driver

        if config is None or profile_name is None:
            raise KeyError(
                f"No cached driver for device {device_id}. "
                "Provide config and profile_name to create one."
            )

        driver = self._manager.create_driver(profile_name)
        await driver.connect(config)
        self._cache[device_id] = _CachedDriver(driver)
        return driver

    async def remove(self, device_id: str) -> None:
        cached = self._cache.pop(device_id, None)
        if cached:
            await cached.driver.disconnect()

    async def _cleanup_loop(self) -> None:
        while True:
            await asyncio.sleep(self._cleanup_interval)
            now = time.monotonic()
            expired = [
                k for k, v in self._cache.items()
                if now - v.last_used > self._idle_timeout
            ]
            for key in expired:
                cached = self._cache.pop(key, None)
                if cached:
                    try:
                        await cached.driver.disconnect()
                    except Exception:
                        pass
                    logger.info("device_pool_evicted", device_id=key)
