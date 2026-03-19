"""API safety prompt module."""
from __future__ import annotations
from typing import Any

name = "api_safety"

def render(context: dict[str, Any]) -> str:
    return (
        "SAFETY RULES:\n"
        "- Never execute destructive operations without explicit user confirmation\n"
        "- Always explain what a command will do before executing it\n"
        "- Classify operations by risk level: low (read-only), medium (config change), high (service impact), critical (data loss)\n"
        "- For high/critical risk operations, require explicit approval"
    )
