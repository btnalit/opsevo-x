"""React post-processing handler."""
from __future__ import annotations
from typing import Any
from ...engine import TransitionResult


async def react_post_processing(ctx: dict[str, Any]) -> TransitionResult:
    adapter = ctx.get("_adapter")
    if adapter:
        return await adapter.post_processing(ctx)
    return TransitionResult.SUCCESS
