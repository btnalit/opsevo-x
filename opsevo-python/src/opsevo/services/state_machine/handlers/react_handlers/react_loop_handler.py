"""React loop handler."""
from __future__ import annotations
from typing import Any
from ...engine import TransitionResult


async def react_react_loop(ctx: dict[str, Any]) -> TransitionResult:
    adapter = ctx.get("_adapter")
    if adapter:
        return await adapter.react_loop(ctx)
    return TransitionResult.FAILURE
