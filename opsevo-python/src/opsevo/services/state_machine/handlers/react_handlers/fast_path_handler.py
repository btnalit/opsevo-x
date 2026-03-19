"""React fast path handler."""
from __future__ import annotations
from typing import Any
from ...engine import TransitionResult


async def react_fast_path(ctx: dict[str, Any]) -> TransitionResult:
    adapter = ctx.get("_adapter")
    if adapter:
        return await adapter.fast_path(ctx)
    return TransitionResult.FAILURE
