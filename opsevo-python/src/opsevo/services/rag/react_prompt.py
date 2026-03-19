"""ReAct prompt construction helpers.

Requirements: 10.2
"""

from __future__ import annotations

from typing import Any


def build_react_system_prompt(tools: list[dict], script_language: str = "", context: str = "") -> str:
    tools_desc = "\n".join(f"- {t['name']}: {t['description']}" for t in tools)
    prompt = (
        "You are a ReAct agent for network device management.\n"
        f"Available tools:\n{tools_desc}\n\n"
        "Pattern: Thought → Action → Action Input → Observation → ... → Final Answer\n"
    )
    if script_language:
        prompt += f"\nDevice script language: {script_language}"
    if context:
        prompt += f"\n\nContext:\n{context}"
    return prompt
