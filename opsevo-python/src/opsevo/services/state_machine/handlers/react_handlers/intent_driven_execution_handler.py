"""React intent-driven execution handler."""
from __future__ import annotations
from typing import Any
from ...engine import TransitionResult


async def react_intent_driven_execution(ctx: dict[str, Any]) -> TransitionResult:
    adapter = ctx.get("_adapter")
    if adapter:
        return await adapter.intent_driven_execution(ctx)
    return TransitionResult.FAILURE
