"""Chain-of-thought prompt module."""
from __future__ import annotations
from typing import Any

name = "chain_of_thought"

def render(context: dict[str, Any]) -> str:
    return (
        "When solving complex problems, think step by step:\n"
        "1. Understand the user's intent\n"
        "2. Gather relevant information\n"
        "3. Analyze the situation\n"
        "4. Propose a solution\n"
        "5. Verify the solution is safe and correct"
    )
