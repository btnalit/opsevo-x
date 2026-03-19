"""Rate limiter for AI API calls.

Requirements: 11.5
"""

from __future__ import annotations

import asyncio
import time


class RateLimiter:
    """Token-bucket rate limiter."""

    def __init__(self, max_requests: int = 60, window_seconds: float = 60.0):
        self._max = max_requests
        self._window = window_seconds
        self._timestamps: list[float] = []
        self._lock = asyncio.Lock()

    async def acquire(self) -> None:
        async with self._lock:
            now = time.monotonic()
            cutoff = now - self._window
            self._timestamps = [t for t in self._timestamps if t > cutoff]
            if len(self._timestamps) >= self._max:
                wait = self._timestamps[0] - cutoff
                await asyncio.sleep(wait)
            self._timestamps.append(time.monotonic())

    @property
    def available(self) -> int:
        now = time.monotonic()
        cutoff = now - self._window
        active = [t for t in self._timestamps if t > cutoff]
        return max(0, self._max - len(active))
