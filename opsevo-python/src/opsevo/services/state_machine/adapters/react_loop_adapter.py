"""ReactLoopAdapter — 将 ReAct 循环服务适配到状态机。"""

from __future__ import annotations
from typing import Any
from ..engine import TransitionResult


class ReactLoopAdapter:
    def __init__(self, react_loop: Any = None, fast_path: Any = None,
                 intent_executor: Any = None, knowledge_base: Any = None) -> None:
        self._react_loop = react_loop
        self._fast_path = fast_path
        self._intent_executor = intent_executor
        self._knowledge_base = knowledge_base

    async def routing_decision(self, ctx: dict[str, Any]) -> TransitionResult:
        query = ctx.get("query", "")
        if self._fast_path and hasattr(self._fast_path, "can_handle"):
            if await self._fast_path.can_handle(query):
                ctx["route"] = "fast_path"
                return TransitionResult.SUCCESS
        if self._intent_executor:
            ctx["route"] = "intent_driven"
            return TransitionResult.SUCCESS
        ctx["route"] = "react"
        return TransitionResult.SUCCESS

    async def fast_path(self, ctx: dict[str, Any]) -> TransitionResult:
        if self._fast_path and hasattr(self._fast_path, "handle"):
            try:
                result = await self._fast_path.handle(ctx.get("query", ""), ctx)
                ctx["response"] = result
                return TransitionResult.SUCCESS
            except Exception:
                return TransitionResult.FAILURE
        return TransitionResult.FAILURE

    async def intent_parse(self, ctx: dict[str, Any]) -> TransitionResult:
        return TransitionResult.SUCCESS

    async def intent_driven_execution(self, ctx: dict[str, Any]) -> TransitionResult:
        if self._intent_executor and hasattr(self._intent_executor, "execute"):
            try:
                result = await self._intent_executor.execute(ctx)
                ctx["response"] = result
                return TransitionResult.SUCCESS
            except Exception:
                return TransitionResult.FAILURE
        return TransitionResult.FAILURE

    async def knowledge_retrieval(self, ctx: dict[str, Any]) -> TransitionResult:
        if self._knowledge_base and hasattr(self._knowledge_base, "search"):
            try:
                results = await self._knowledge_base.search(ctx.get("query", ""))
                ctx["knowledge"] = results
            except Exception:
                ctx["knowledge"] = []
        return TransitionResult.SUCCESS

    async def react_loop(self, ctx: dict[str, Any]) -> TransitionResult:
        if self._react_loop and hasattr(self._react_loop, "run"):
            try:
                result = await self._react_loop.run(ctx)
                ctx["response"] = result
                return TransitionResult.SUCCESS
            except Exception:
                return TransitionResult.FAILURE
        return TransitionResult.FAILURE

    async def post_processing(self, ctx: dict[str, Any]) -> TransitionResult:
        return TransitionResult.SUCCESS

    async def response(self, ctx: dict[str, Any]) -> TransitionResult:
        return TransitionResult.SUCCESS
