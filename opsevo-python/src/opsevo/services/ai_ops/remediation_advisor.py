"""RemediationAdvisor — suggest remediation plans based on alerts.

Requirements: 9.2
"""

from __future__ import annotations

from typing import Any

from opsevo.utils.logger import get_logger

logger = get_logger(__name__)


class RemediationAdvisor:
    def __init__(self) -> None:
        self._ai_adapter: Any = None

    def set_ai_adapter(self, adapter: Any) -> None:
        self._ai_adapter = adapter

    async def advise(self, event: dict[str, Any], analysis: dict[str, Any]) -> dict[str, Any]:
        if self._ai_adapter:
            try:
                prompt = (
                    f"Suggest a remediation plan for:\n"
                    f"Alert: {event.get('message', '')}\n"
                    f"Root cause: {analysis.get('root_cause', 'unknown')}\n"
                    f"Provide steps as a numbered list."
                )
                resp = await self._ai_adapter.chat([{"role": "user", "content": prompt}])
                content = resp.get("content", "") if isinstance(resp, dict) else str(resp)
                return {"plan": content, "source": "ai", "confidence": 0.7}
            except Exception:
                pass
        return {"plan": "Manual investigation required", "source": "default", "confidence": 0.1}
