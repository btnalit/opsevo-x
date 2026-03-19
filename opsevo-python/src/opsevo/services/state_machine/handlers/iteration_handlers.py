"""Iteration loop state handlers."""

from __future__ import annotations
from typing import Any
from ..engine import TransitionResult


async def iteration_initialize(ctx: dict[str, Any]) -> TransitionResult:
    adapter = ctx.get("_adapter")
    if adapter:
        return await adapter.initialize(ctx)
    return TransitionResult.SUCCESS


async def iteration_execute(ctx: dict[str, Any]) -> TransitionResult:
    adapter = ctx.get("_adapter")
    if adapter:
        return await adapter.execute(ctx)
    return TransitionResult.SUCCESS


async def iteration_evaluate(ctx: dict[str, Any]) -> TransitionResult:
    adapter = ctx.get("_adapter")
    if adapter:
        return await adapter.evaluate(ctx)
    return TransitionResult.SUCCESS


async def iteration_reflect(ctx: dict[str, Any]) -> TransitionResult:
    adapter = ctx.get("_adapter")
    if adapter:
        return await adapter.reflect(ctx)
    return TransitionResult.SUCCESS


async def iteration_retry_or_abort(ctx: dict[str, Any]) -> TransitionResult:
    adapter = ctx.get("_adapter")
    if adapter:
        return await adapter.retry_or_abort(ctx)
    return TransitionResult.FAILURE


async def iteration_handle_error(ctx: dict[str, Any]) -> TransitionResult:
    if ctx.get("iteration_count", 0) >= ctx.get("max_iterations", 5):
        return TransitionResult.FAILURE  # abort
    return TransitionResult.SUCCESS  # retry
