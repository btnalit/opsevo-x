"""RelevanceScorer — scores content relevance to a query.

Used by UnifiedAgentService and ReactLoopController.
Requirements: 11.4
"""

from __future__ import annotations

from typing import Any


class RelevanceScorer:
    """Simple keyword + overlap relevance scorer."""

    def score(self, query: str, content: str) -> float:
        if not query or not content:
            return 0.0
        q_words = set(query.lower().split())
        c_words = set(content.lower().split())
        if not q_words:
            return 0.0
        overlap = len(q_words & c_words)
        return min(overlap / len(q_words), 1.0)

    def rank(self, query: str, items: list[dict[str, Any]], content_key: str = "content") -> list[dict[str, Any]]:
        scored = [(item, self.score(query, str(item.get(content_key, "")))) for item in items]
        scored.sort(key=lambda x: x[1], reverse=True)
        return [item for item, _ in scored]
