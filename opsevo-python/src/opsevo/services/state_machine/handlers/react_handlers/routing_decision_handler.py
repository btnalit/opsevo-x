"""React routing decision handler."""
from __future__ import annotations
from typing import Any
from ...engine import TransitionResult


async def react_routing_decision(ctx: dict[str, Any]) -> TransitionResult:
    adapter = ctx.get("_adapter")
    if adapter:
        return await adapter.routing_decision(ctx)
    return TransitionResult.SUCCESS
