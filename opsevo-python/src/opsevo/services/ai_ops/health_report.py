"""HealthReport — generate health reports for devices.

Requirements: 9.5
"""

from __future__ import annotations

import time
from typing import Any

from opsevo.utils.logger import get_logger

logger = get_logger(__name__)


class HealthReportGenerator:
    def __init__(self) -> None:
        self._ai_adapter: Any = None

    def set_ai_adapter(self, adapter: Any) -> None:
        self._ai_adapter = adapter

    async def generate(self, device_id: str, metrics: dict[str, Any], alerts: list[dict[str, Any]]) -> dict[str, Any]:
        summary = self._build_summary(metrics, alerts)
        if self._ai_adapter:
            try:
                resp = await self._ai_adapter.chat([{"role": "user", "content": f"Generate a health report:\n{summary}"}])
                content = resp.get("content", "") if isinstance(resp, dict) else str(resp)
                return {"device_id": device_id, "report": content, "source": "ai", "timestamp": int(time.time() * 1000)}
            except Exception:
                pass
        return {"device_id": device_id, "report": summary, "source": "basic", "timestamp": int(time.time() * 1000)}

    @staticmethod
    def _build_summary(metrics: dict[str, Any], alerts: list[dict[str, Any]]) -> str:
        parts = [f"CPU: {metrics.get('cpu_usage', 'N/A')}%", f"Memory: {metrics.get('memory_usage', 'N/A')}%"]
        if alerts:
            parts.append(f"Active alerts: {len(alerts)}")
        return " | ".join(parts)
