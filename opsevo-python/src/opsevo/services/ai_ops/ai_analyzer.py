"""AIAnalyzer — AI-driven analysis service.

Requirements: 9.9
"""

from __future__ import annotations

import time
from typing import Any

from opsevo.data.datastore import DataStore
from opsevo.utils.logger import get_logger

logger = get_logger(__name__)


class AIAnalyzer:
    def __init__(self, datastore: DataStore):
        self._ds = datastore
        self._ai_adapter: Any = None

    def set_ai_adapter(self, adapter: Any) -> None:
        self._ai_adapter = adapter

    async def analyze(self, device_id: str, data: dict[str, Any], analysis_type: str = "general") -> dict[str, Any]:
        if self._ai_adapter:
            try:
                prompt = self._build_prompt(device_id, data, analysis_type)
                resp = await self._ai_adapter.chat([{"role": "user", "content": prompt}])
                content = resp.get("content", "") if isinstance(resp, dict) else str(resp)
                result = {"device_id": device_id, "type": analysis_type, "result": content,
                          "source": "ai", "timestamp": int(time.time() * 1000)}
                await self._save_analysis(result)
                return result
            except Exception:
                logger.warning("ai_analysis_failed")
        return {"device_id": device_id, "type": analysis_type, "result": "Analysis unavailable",
                "source": "fallback", "timestamp": int(time.time() * 1000)}

    @staticmethod
    def _build_prompt(device_id: str, data: dict[str, Any], analysis_type: str) -> str:
        return (
            f"Perform a {analysis_type} analysis for device {device_id}:\n"
            f"Data: {str(data)[:2000]}\n"
            f"Provide actionable insights."
        )

    async def _save_analysis(self, result: dict[str, Any]) -> None:
        try:
            import json
            await self._ds.execute(
                "INSERT INTO ai_analysis (device_id, type, result, timestamp) VALUES ($1,$2,$3,$4)",
                (result["device_id"], result["type"], json.dumps(result, ensure_ascii=False), result["timestamp"]),
            )
        except Exception:
            pass
