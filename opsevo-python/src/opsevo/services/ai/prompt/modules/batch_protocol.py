"""Batch protocol prompt module."""
from __future__ import annotations
from typing import Any

name = "batch_protocol"

def render(context: dict[str, Any]) -> str:
    if not context.get("batch_mode"):
        return ""
    return (
        "BATCH MODE ACTIVE:\n"
        "Process multiple items sequentially. Report progress after each item.\n"
        "If any item fails, continue with remaining items and report failures at the end."
    )
