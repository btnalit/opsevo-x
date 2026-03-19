"""IterationLoopAdapter — 将 IterationLoop 服务适配到状态机。"""

from __future__ import annotations
from typing import Any
from ..engine import TransitionResult


class IterationLoopAdapter:
    def __init__(self, iteration_loop: Any = None, critic: Any = None, reflector: Any = None) -> None:
        self._loop = iteration_loop
        self._critic = critic
        self._reflector = reflector

    async def initialize(self, ctx: dict[str, Any]) -> TransitionResult:
        ctx.setdefault("iteration_count", 0)
        ctx.setdefault("max_iterations", 5)
        return TransitionResult.SUCCESS

    async def execute(self, ctx: dict[str, Any]) -> TransitionResult:
        ctx["iteration_count"] = ctx.get("iteration_count", 0) + 1
        if self._loop and hasattr(self._loop, "execute_step"):
            try:
                result = await self._loop.execute_step(ctx)
                ctx["step_result"] = result
                return TransitionResult.SUCCESS
            except Exception:
                return TransitionResult.FAILURE
        return TransitionResult.SUCCESS

    async def evaluate(self, ctx: dict[str, Any]) -> TransitionResult:
        if self._critic and hasattr(self._critic, "evaluate"):
            score = await self._critic.evaluate(ctx.get("step_result"))
            ctx["evaluation_score"] = score
            return TransitionResult.SUCCESS if score >= 0.7 else TransitionResult.FAILURE
        return TransitionResult.SUCCESS

    async def reflect(self, ctx: dict[str, Any]) -> TransitionResult:
        if ctx.get("iteration_count", 0) >= ctx.get("max_iterations", 5):
            return TransitionResult.SUCCESS  # done
        if self._reflector and hasattr(self._reflector, "reflect"):
            await self._reflector.reflect(ctx)
        return TransitionResult.FAILURE  # continue → maps to "continue" transition

    async def retry_or_abort(self, ctx: dict[str, Any]) -> TransitionResult:
        if ctx.get("iteration_count", 0) >= ctx.get("max_iterations", 5):
            return TransitionResult.FAILURE  # abort
        return TransitionResult.SUCCESS  # retry
