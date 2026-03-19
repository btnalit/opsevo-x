"""React intent parse handler."""
from __future__ import annotations
from typing import Any
from ...engine import TransitionResult


async def react_intent_parse(ctx: dict[str, Any]) -> TransitionResult:
    adapter = ctx.get("_adapter")
    if adapter:
        return await adapter.intent_parse(ctx)
    return TransitionResult.SUCCESS
