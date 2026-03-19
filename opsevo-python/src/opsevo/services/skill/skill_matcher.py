"""SkillMatcher — 基于关键词的技能匹配。"""

from __future__ import annotations
from typing import Any
import structlog

logger = structlog.get_logger(__name__)


class SkillMatcher:
    """基于关键词匹配技能。"""

    def __init__(self, skill_manager: Any = None) -> None:
        self._manager = skill_manager

    async def match(self, query: str, context: dict[str, Any] | None = None) -> str | None:
        if not self._manager:
            return None
        query_lower = query.lower()
        best_name: str | None = None
        best_score = 0.0

        for name in self._manager.list_enabled():
            defn = self._manager.get(name)
            if not defn:
                continue
            keywords = defn.get("keywords", [])
            score = sum(1 for kw in keywords if kw.lower() in query_lower)
            if score > best_score:
                best_score = score
                best_name = name

        return best_name if best_score > 0 else None

    async def match_with_score(self, query: str, context: dict[str, Any] | None = None) -> tuple[str | None, float]:
        name = await self.match(query, context)
        return (name, 1.0) if name else (None, 0.0)
