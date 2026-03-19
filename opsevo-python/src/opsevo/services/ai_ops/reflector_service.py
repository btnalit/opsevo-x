"""ReflectorService — reflect on past decisions to improve future ones.

Requirements: 9.3, 9.4
"""

from __future__ import annotations

from typing import Any

from opsevo.utils.logger import get_logger

logger = get_logger(__name__)


class ReflectorService:
    def __init__(self) -> None:
        self._ai_adapter: Any = None
        self._reflections: list[dict[str, Any]] = []

    def set_ai_adapter(self, adapter: Any) -> None:
        self._ai_adapter = adapter

    async def reflect(self, decisions: list[dict[str, Any]]) -> dict[str, Any]:
        if not decisions:
            return {"insights": [], "improvements": []}
        if self._ai_adapter:
            try:
                prompt = f"Reflect on these {len(decisions)} decisions and suggest improvements:\n{decisions[:5]}"
                resp = await self._ai_adapter.chat([{"role": "user", "content": prompt}])
                content = resp.get("content", "") if isinstance(resp, dict) else str(resp)
                reflection = {"insights": [content], "improvements": [], "source": "ai"}
                self._reflections.append(reflection)
                return reflection
            except Exception:
                pass
        return {"insights": [f"Reviewed {len(decisions)} decisions"], "improvements": [], "source": "basic"}

    def get_reflections(self, limit: int = 10) -> list[dict[str, Any]]:
        return self._reflections[-limit:]
