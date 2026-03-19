"""SkillRouter — 根据用户意图路由到合适的技能。"""

from __future__ import annotations
from typing import Any
import structlog

logger = structlog.get_logger(__name__)


class SkillRouter:
    """根据查询意图路由到最匹配的技能。"""

    def __init__(self, skill_manager: Any = None, skill_matcher: Any = None) -> None:
        self._manager = skill_manager
        self._matcher = skill_matcher

    async def route(self, query: str, context: dict[str, Any] | None = None) -> str | None:
        if self._matcher:
            match = await self._matcher.match(query, context)
            if match:
                return match
        return None

    async def route_with_score(self, query: str, context: dict[str, Any] | None = None) -> tuple[str | None, float]:
        if self._matcher and hasattr(self._matcher, "match_with_score"):
            return await self._matcher.match_with_score(query, context)
        name = await self.route(query, context)
        return (name, 1.0) if name else (None, 0.0)
