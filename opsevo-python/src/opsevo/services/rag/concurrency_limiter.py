"""Concurrency limiter for RAG operations.

Requirements: 10.9
"""
from __future__ import annotations
import asyncio

class ConcurrencyLimiter:
    def __init__(self, max_concurrent: int = 5):
        self._semaphore = asyncio.Semaphore(max_concurrent)

    async def __aenter__(self):
        await self._semaphore.acquire()
        return self

    async def __aexit__(self, *args):
        self._semaphore.release()
