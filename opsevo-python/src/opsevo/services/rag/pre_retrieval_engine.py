"""Pre-retrieval engine — decides whether to skip retrieval.

Requirements: 10.9
"""
from __future__ import annotations

class PreRetrievalEngine:
    _SKIP_PATTERNS = ["hello", "hi", "thanks", "bye", "ok", "yes", "no"]

    def should_retrieve(self, query: str) -> bool:
        q = query.strip().lower().rstrip("?!.")
        return q not in self._SKIP_PATTERNS and len(q) > 5
