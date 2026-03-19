"""Legacy prompt templates — fallback when modular composition fails.

Requirements: 11.5
"""

from __future__ import annotations

from typing import Any

_DEFAULT_TEMPLATE = """You are an intelligent network operations assistant.
You help users manage and monitor network devices.
Always provide clear, actionable responses.
When executing commands, explain what each command does.
Prioritize safety — never execute destructive operations without confirmation."""


def get_legacy_template(context: dict[str, Any] | None = None) -> str:
    if not context:
        return _DEFAULT_TEMPLATE
    vendor = context.get("vendor", "")
    if vendor:
        return f"{_DEFAULT_TEMPLATE}\n\nTarget device vendor: {vendor}"
    return _DEFAULT_TEMPLATE
