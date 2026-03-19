"""Alert pipeline state handlers."""

from __future__ import annotations
from typing import Any
from ..engine import TransitionResult


async def alert_preprocess(ctx: dict[str, Any]) -> TransitionResult:
    adapter = ctx.get("_adapter")
    if adapter:
        return await adapter.preprocess(ctx)
    return TransitionResult.SUCCESS


async def alert_noise_filter(ctx: dict[str, Any]) -> TransitionResult:
    adapter = ctx.get("_adapter")
    if adapter:
        result = await adapter.noise_filter(ctx)
        if result == TransitionResult.SKIP:
            return TransitionResult.SKIP
    return TransitionResult.SUCCESS


async def alert_analyze(ctx: dict[str, Any]) -> TransitionResult:
    adapter = ctx.get("_adapter")
    if adapter:
        return await adapter.analyze(ctx)
    return TransitionResult.SUCCESS


async def alert_decide(ctx: dict[str, Any]) -> TransitionResult:
    adapter = ctx.get("_adapter")
    if adapter:
        return await adapter.decide(ctx)
    return TransitionResult.SUCCESS


async def alert_remediate(ctx: dict[str, Any]) -> TransitionResult:
    return TransitionResult.SUCCESS


async def alert_notify(ctx: dict[str, Any]) -> TransitionResult:
    adapter = ctx.get("_adapter")
    if adapter:
        return await adapter.notify(ctx)
    return TransitionResult.SUCCESS


async def alert_notify_error(ctx: dict[str, Any]) -> TransitionResult:
    return TransitionResult.SUCCESS


async def noop(ctx: dict[str, Any]) -> TransitionResult:
    return TransitionResult.SUCCESS
