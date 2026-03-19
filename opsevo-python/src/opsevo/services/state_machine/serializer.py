"""
StateDefinitionSerializer — 状态定义序列化

将流程定义序列化/反序列化为 JSON 格式。
"""

from __future__ import annotations

import json
from typing import Any

from .engine import FlowDefinition, StateDefinition


class StateDefinitionSerializer:
    """序列化和反序列化状态机流程定义。"""

    @staticmethod
    def serialize(flow: FlowDefinition) -> dict[str, Any]:
        return {
            "name": flow.name,
            "initial_state": flow.initial_state,
            "terminal_states": list(flow.terminal_states),
            "states": {
                name: {
                    "name": sd.name,
                    "handler": sd.handler,
                    "transitions": sd.transitions,
                    "timeout_s": sd.timeout_s,
                    "metadata": sd.metadata,
                }
                for name, sd in flow.states.items()
            },
        }

    @staticmethod
    def deserialize(data: dict[str, Any]) -> FlowDefinition:
        states = {}
        for name, sd in data.get("states", {}).items():
            states[name] = StateDefinition(
                name=sd["name"],
                handler=sd["handler"],
                transitions=sd.get("transitions", {}),
                timeout_s=sd.get("timeout_s", 60.0),
                metadata=sd.get("metadata", {}),
            )
        return FlowDefinition(
            name=data["name"],
            initial_state=data["initial_state"],
            states=states,
            terminal_states=set(data.get("terminal_states", [])),
        )

    @staticmethod
    def to_json(flow: FlowDefinition) -> str:
        return json.dumps(StateDefinitionSerializer.serialize(flow), indent=2)

    @staticmethod
    def from_json(text: str) -> FlowDefinition:
        return StateDefinitionSerializer.deserialize(json.loads(text))
