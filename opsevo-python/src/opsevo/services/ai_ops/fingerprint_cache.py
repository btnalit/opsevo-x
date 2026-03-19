"""FingerprintCache — deduplication cache for alert fingerprints.

Requirements: 9.1
"""

from __future__ import annotations

import time
from typing import Any

from opsevo.utils.logger import get_logger

logger = get_logger(__name__)


class FingerprintCache:
    def __init__(self, window_ms: int = 300_000):
        self._window_ms = window_ms
        self._cache: dict[str, float] = {}

    def is_duplicate(self, fingerprint: str) -> bool:
        now = time.time() * 1000
        ts = self._cache.get(fingerprint)
        if ts and (now - ts) < self._window_ms:
            return True
        return False

    def record(self, fingerprint: str) -> None:
        self._cache[fingerprint] = time.time() * 1000

    def cleanup_expired(self) -> int:
        now = time.time() * 1000
        expired = [fp for fp, ts in self._cache.items() if (now - ts) >= self._window_ms]
        for fp in expired:
            del self._cache[fp]
        return len(expired)
