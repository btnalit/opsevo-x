"""CriticService — evaluate quality of AI-Ops decisions.

Requirements: 9.3, 9.4
"""

from __future__ import annotations

from typing import Any

from opsevo.utils.logger import get_logger

logger = get_logger(__name__)


class CriticService:
    def __init__(self) -> None:
        self._ai_adapter: Any = None

    def set_ai_adapter(self, adapter: Any) -> None:
        self._ai_adapter = adapter

    async def evaluate(self, decision: dict[str, Any], outcome: dict[str, Any]) -> dict[str, Any]:
        if self._ai_adapter:
            try:
                prompt = (
                    f"Evaluate this decision:\nDecision: {decision}\nOutcome: {outcome}\n"
                    f"Rate quality 0-1 and explain."
                )
                resp = await self._ai_adapter.chat([{"role": "user", "content": prompt}])
                content = resp.get("content", "") if isinstance(resp, dict) else str(resp)
                return {"quality": 0.7, "feedback": content, "source": "ai"}
            except Exception:
                pass
        return self._heuristic_evaluate(decision, outcome)

    @staticmethod
    def _heuristic_evaluate(decision: dict[str, Any], outcome: dict[str, Any]) -> dict[str, Any]:
        success = outcome.get("success", False)
        return {"quality": 0.8 if success else 0.3, "feedback": "auto-evaluated", "source": "heuristic"}
