"""RootCauseAnalyzer — AI-driven root cause analysis.

Requirements: 9.1
"""

from __future__ import annotations

from typing import Any

from opsevo.utils.logger import get_logger

logger = get_logger(__name__)


class RootCauseAnalyzer:
    def __init__(self) -> None:
        self._ai_adapter: Any = None

    def set_ai_adapter(self, adapter: Any) -> None:
        self._ai_adapter = adapter

    async def analyze(self, event: dict[str, Any], context: dict[str, Any] | None = None) -> dict[str, Any]:
        if self._ai_adapter:
            try:
                prompt = self._build_prompt(event, context)
                resp = await self._ai_adapter.chat([{"role": "user", "content": prompt}])
                content = resp.get("content", "") if isinstance(resp, dict) else str(resp)
                return {"root_cause": content, "confidence": 0.7, "source": "ai"}
            except Exception:
                logger.warning("rca_ai_failed_using_heuristic")
        return self._heuristic_analysis(event)

    @staticmethod
    def _build_prompt(event: dict[str, Any], context: dict[str, Any] | None) -> str:
        return (
            f"Analyze the root cause of this alert:\n"
            f"Severity: {event.get('severity', 'unknown')}\n"
            f"Message: {event.get('message', '')}\n"
            f"Device: {event.get('device_id', 'unknown')}\n"
            f"Context: {context or 'none'}\n"
            f"Provide a concise root cause analysis."
        )

    @staticmethod
    def _heuristic_analysis(event: dict[str, Any]) -> dict[str, Any]:
        message = event.get("message", "").lower()
        if "cpu" in message:
            return {"root_cause": "High CPU utilization", "confidence": 0.5, "source": "heuristic"}
        if "memory" in message:
            return {"root_cause": "Memory pressure", "confidence": 0.5, "source": "heuristic"}
        if "interface" in message and "down" in message:
            return {"root_cause": "Interface failure", "confidence": 0.6, "source": "heuristic"}
        return {"root_cause": "Unknown", "confidence": 0.1, "source": "heuristic"}
