"""React response handler."""
from __future__ import annotations
from typing import Any
from ...engine import TransitionResult


async def react_response(ctx: dict[str, Any]) -> TransitionResult:
    return TransitionResult.SUCCESS


async def react_error_response(ctx: dict[str, Any]) -> TransitionResult:
    return TransitionResult.FAILURE
