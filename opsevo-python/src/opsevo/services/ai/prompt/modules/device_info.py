"""Device info prompt module."""
from __future__ import annotations
from typing import Any

name = "device_info"

def render(context: dict[str, Any]) -> str:
    vendor = context.get("vendor", "")
    model = context.get("model", "")
    caps = context.get("capabilities", [])
    if not vendor:
        return ""
    parts = [f"Target device: {vendor} {model}".strip()]
    if caps:
        parts.append(f"Capabilities: {', '.join(caps)}")
    return "\n".join(parts)
