"""ReAct format prompt module."""
from __future__ import annotations
from typing import Any

name = "react_format"

def render(context: dict[str, Any]) -> str:
    if context.get("mode") != "agent":
        return ""
    return (
        "Use the ReAct (Reasoning + Acting) pattern:\n"
        "Thought: <your reasoning>\n"
        "Action: <tool_name>\n"
        "Action Input: <json parameters>\n"
        "Observation: <tool result>\n"
        "... (repeat as needed)\n"
        "Final Answer: <your response to the user>"
    )
