"""IntentAnalyzer — classifies user intent from natural language.

Requirements: 10.7
"""

from __future__ import annotations

from typing import Any

from opsevo.utils.logger import get_logger

logger = get_logger(__name__)

_INTENT_KEYWORDS: dict[str, list[str]] = {
    "query": ["show", "get", "list", "display", "check", "status", "info"],
    "configure": ["set", "configure", "change", "update", "modify", "enable", "disable"],
    "diagnose": ["diagnose", "troubleshoot", "why", "problem", "issue", "error", "fix"],
    "monitor": ["monitor", "watch", "alert", "threshold", "metric"],
    "execute": ["run", "execute", "restart", "reboot", "apply", "script"],
}


class IntentAnalyzer:
    def analyze(self, query: str) -> dict[str, Any]:
        q = query.lower()
        scores: dict[str, float] = {}
        for intent, keywords in _INTENT_KEYWORDS.items():
            score = sum(1 for kw in keywords if kw in q)
            if score > 0:
                scores[intent] = score

        if not scores:
            return {"intent": "query", "confidence": 0.3, "all_scores": {}}

        best = max(scores, key=scores.get)  # type: ignore[arg-type]
        total = sum(scores.values())
        confidence = scores[best] / total if total else 0.5

        return {"intent": best, "confidence": round(confidence, 3), "all_scores": scores}
