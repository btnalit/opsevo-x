"""SkillToolRegistry — 技能本地工具注册。"""

from __future__ import annotations
from typing import Any, Awaitable, Callable
import structlog

logger = structlog.get_logger(__name__)


class SkillToolRegistry:
    """管理技能提供的本地工具。"""

    def __init__(self) -> None:
        self._tools: dict[str, dict[str, Any]] = {}
        self._handlers: dict[str, Callable[..., Awaitable[Any]]] = {}

    def register(self, name: str, definition: dict[str, Any], handler: Callable[..., Awaitable[Any]]) -> None:
        self._tools[name] = definition
        self._handlers[name] = handler

    def get_definition(self, name: str) -> dict[str, Any] | None:
        return self._tools.get(name)

    def get_all_definitions(self) -> list[dict[str, Any]]:
        return [{"name": k, **v} for k, v in self._tools.items()]

    async def execute(self, name: str, params: dict[str, Any]) -> Any:
        handler = self._handlers.get(name)
        if not handler:
            raise ValueError(f"Tool not found: {name}")
        return await handler(params)

    def has(self, name: str) -> bool:
        return name in self._tools
