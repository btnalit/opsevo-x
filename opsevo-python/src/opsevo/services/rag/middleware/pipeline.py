"""MiddlewarePipeline — chains middleware for RAG processing.

Requirements: 10.9
"""

from __future__ import annotations

from typing import Any, Awaitable, Callable

from opsevo.utils.logger import get_logger

logger = get_logger(__name__)

Middleware = Callable[[dict[str, Any], Callable], Awaitable[dict[str, Any]]]


class MiddlewarePipeline:
    def __init__(self) -> None:
        self._middlewares: list[Middleware] = []

    def use(self, mw: Middleware) -> None:
        self._middlewares.append(mw)

    async def execute(self, context: dict[str, Any]) -> dict[str, Any]:
        async def _run(idx: int, ctx: dict[str, Any]) -> dict[str, Any]:
            if idx >= len(self._middlewares):
                return ctx
            return await self._middlewares[idx](ctx, lambda c: _run(idx + 1, c))

        return await _run(0, context)
