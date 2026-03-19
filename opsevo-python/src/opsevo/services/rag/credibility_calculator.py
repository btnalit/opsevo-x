"""CredibilityCalculator — scores source credibility.

Requirements: 10.1, 10.6
"""

from __future__ import annotations

from typing import Any


class CredibilityCalculator:
    def calculate(self, result: dict[str, Any]) -> float:
        score = result.get("score", 0.5)
        meta = result.get("metadata", {})
        # Boost for verified sources
        if meta.get("verified"):
            score = min(score * 1.2, 1.0)
        # Boost for recent entries
        if meta.get("recent"):
            score = min(score * 1.1, 1.0)
        return round(score, 4)
