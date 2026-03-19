"""MastraAgent — tool registration, session management, AI tool calling.

Requirements: 10.11
"""
from __future__ import annotations
from typing import Any, Callable, Awaitable
from opsevo.utils.logger import get_logger

logger = get_logger(__name__)

ToolFn = Callable[..., Awaitable[Any]]

class MastraAgent:
    def __init__(self) -> None:
        self._tools: dict[str, ToolFn] = {}
        self._stats: dict[str, int] = {}

    def register_tool(self, name: str, fn: ToolFn) -> None:
        self._tools[name] = fn
        self._stats[name] = 0

    async def call_tool(self, name: str, **kwargs: Any) -> Any:
        fn = self._tools.get(name)
        if not fn:
            raise ValueError(f"Unknown tool: {name}")
        self._stats[name] = self._stats.get(name, 0) + 1
        return await fn(**kwargs)

    @property
    def available_tools(self) -> list[str]:
        return list(self._tools.keys())

    def get_stats(self) -> dict[str, int]:
        return dict(self._stats)
