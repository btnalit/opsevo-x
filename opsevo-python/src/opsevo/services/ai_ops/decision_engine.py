"""DecisionEngine — decide remediation actions based on analysis.

Requirements: 9.1
"""

from __future__ import annotations

from typing import Any

from opsevo.utils.logger import get_logger

logger = get_logger(__name__)


class DecisionEngine:
    def __init__(self) -> None:
        self._rules: list[dict[str, Any]] = []

    def load_rules(self, rules: list[dict[str, Any]]) -> None:
        self._rules = rules

    async def decide(self, event: dict[str, Any], analysis: dict[str, Any]) -> dict[str, Any]:
        severity = event.get("severity", "info")
        if severity == "critical":
            return {"action": "auto_remediate", "priority": "immediate", "notify": True}
        if severity in ("high", "warning"):
            return {"action": "notify", "priority": "normal", "notify": True}
        return {"action": "log", "priority": "low", "notify": False}
