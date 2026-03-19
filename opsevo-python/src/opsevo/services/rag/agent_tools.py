"""Agent tools — tool definitions for AI agent mode.

Requirements: 10.9
"""
from __future__ import annotations
from typing import Any

def get_agent_tool_definitions() -> list[dict[str, Any]]:
    return [
        {
            "type": "function",
            "function": {
                "name": "query_device",
                "description": "Query device data by action type",
                "parameters": {"type": "object", "properties": {"action_type": {"type": "string"}}, "required": ["action_type"]},
            },
        },
        {
            "type": "function",
            "function": {
                "name": "execute_command",
                "description": "Execute a command on the device",
                "parameters": {"type": "object", "properties": {"action_type": {"type": "string"}, "payload": {"type": "object"}}, "required": ["action_type"]},
            },
        },
        {
            "type": "function",
            "function": {
                "name": "search_knowledge",
                "description": "Search the knowledge base",
                "parameters": {"type": "object", "properties": {"query": {"type": "string"}}, "required": ["query"]},
            },
        },
    ]
