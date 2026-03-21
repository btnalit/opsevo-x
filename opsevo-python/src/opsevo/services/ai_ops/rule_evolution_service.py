"""RuleEvolutionService — evolve alert rules based on feedback.

Requirements: 9.7
"""

from __future__ import annotations

from typing import Any

from opsevo.data.datastore import DataStore
from opsevo.utils.logger import get_logger

logger = get_logger(__name__)


class RuleEvolutionService:
    def __init__(self, datastore: DataStore):
        self._ds = datastore
        self._ai_adapter: Any = None

    def set_ai_adapter(self, adapter: Any) -> None:
        self._ai_adapter = adapter

    async def suggest_rule_updates(self, rule_id: str, feedback: list[dict[str, Any]]) -> dict[str, Any]:
        if not feedback:
            return {"suggestions": []}
        false_positives = sum(1 for f in feedback if f.get("type") == "false_positive")
        missed = sum(1 for f in feedback if f.get("type") == "missed")
        suggestions: list[str] = []
        if false_positives > len(feedback) * 0.3:
            suggestions.append("Consider raising threshold to reduce false positives")
        if missed > len(feedback) * 0.2:
            suggestions.append("Consider lowering threshold to catch more events")
        return {"rule_id": rule_id, "suggestions": suggestions,
                "false_positives": false_positives, "missed": missed}

    async def auto_tune(self, rule_id: str, metrics: list[dict[str, Any]]) -> dict[str, Any]:
        if not metrics:
            return {"tuned": False}
        values = [m.get("value", 0) for m in metrics if m.get("value") is not None]
        if not values:
            return {"tuned": False}

        # Outlier filtering via IQR (interquartile range)
        sorted_vals = sorted(values)
        n = len(sorted_vals)
        if n >= 4:
            q1 = sorted_vals[n // 4]
            q3 = sorted_vals[3 * n // 4]
            iqr = q3 - q1
            lower_fence = q1 - 1.5 * iqr
            upper_fence = q3 + 1.5 * iqr
            filtered = [v for v in values if lower_fence <= v <= upper_fence]
            if filtered:
                values = filtered

        avg = sum(values) / len(values)
        std = (sum((v - avg) ** 2 for v in values) / len(values)) ** 0.5
        raw_threshold = avg + 2 * std

        # Guardrails: clamp to [avg * 0.5, avg * 5] to prevent runaway thresholds
        min_bound = avg * 0.5
        max_bound = avg * 5.0
        suggested_threshold = max(min_bound, min(raw_threshold, max_bound))

        return {
            "tuned": True,
            "suggested_threshold": round(suggested_threshold, 2),
            "avg": round(avg, 2),
            "std": round(std, 2),
            "clamped": raw_threshold != suggested_threshold,
        }
