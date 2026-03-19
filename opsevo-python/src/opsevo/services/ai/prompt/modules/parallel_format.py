"""Parallel execution format prompt module."""
from __future__ import annotations
from typing import Any

name = "parallel_format"

def render(context: dict[str, Any]) -> str:
    if not context.get("parallel_enabled"):
        return ""
    return (
        "PARALLEL EXECUTION:\n"
        "When multiple independent operations are needed, you may execute them in parallel.\n"
        "Format: Action: parallel_execute\n"
        "Action Input: {\"actions\": [{\"tool\": \"...\", \"input\": {...}}, ...]}"
    )
