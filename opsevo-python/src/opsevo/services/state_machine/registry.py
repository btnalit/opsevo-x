"""
StateRegistry — 流程定义注册表

集中管理所有已注册的流程定义和处理器。
"""

from __future__ import annotations

from typing import Any, Awaitable, Callable

import structlog

from .engine import FlowDefinition, StateMachineEngine, TransitionResult

logger = structlog.get_logger(__name__)


class StateRegistry:
    """集中注册流程定义和处理器到引擎。"""

    def __init__(self, engine: StateMachineEngine) -> None:
        self._engine = engine
        self._registered_flows: set[str] = set()

    def register_flow(self, flow: FlowDefinition) -> None:
        self._engine.register_flow(flow)
        self._registered_flows.add(flow.name)

    def register_handler(self, name: str, handler: Callable[..., Awaitable[TransitionResult]]) -> None:
        self._engine.register_handler(name, handler)

    def register_handlers(self, handlers: dict[str, Callable[..., Awaitable[TransitionResult]]]) -> None:
        for name, handler in handlers.items():
            self._engine.register_handler(name, handler)

    @property
    def registered_flows(self) -> set[str]:
        return set(self._registered_flows)
