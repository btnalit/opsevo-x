"""FastPath metrics tracking.
Requirements: 10.3
"""
from __future__ import annotations
from typing import Any

class FastPathMetrics:
    def __init__(self) -> None:
        self._hits = 0
        self._misses = 0

    def record_hit(self) -> None:
        self._hits += 1
    def record_miss(self) -> None:
        self._misses += 1

    def get_stats(self) -> dict[str, Any]:
        total = self._hits + self._misses
        return {
            "hits": self._hits,
            "misses": self._misses,
            "hitRate": round(self._hits / max(total, 1), 4),
        }
