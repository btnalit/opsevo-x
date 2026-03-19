"""ConcurrencyGuard — 状态机并发保护集成。"""
from __future__ import annotations
import asyncio
from typing import Any
import structlog

logger = structlog.get_logger(__name__)


class ConcurrencyGuard:
    def __init__(self, max_concurrent: int = 10) -> None:
        self._semaphore = asyncio.Semaphore(max_concurrent)
        self._active = 0

    async def acquire(self) -> None:
        await self._semaphore.acquire()
        self._active += 1

    def release(self) -> None:
        self._active -= 1
        self._semaphore.release()

    @property
    def active_count(self) -> int:
        return self._active
