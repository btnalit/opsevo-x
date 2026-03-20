"""
StateMachineEngine — 状态机引擎核心

管理状态定义、转换规则、状态执行。
支持多个并发状态机实例。
"""

from __future__ import annotations

import time
import uuid
from dataclasses import dataclass, field
from enum import Enum
from typing import Any, Callable, Awaitable

import structlog

logger = structlog.get_logger(__name__)


class TransitionResult(str, Enum):
    SUCCESS = "success"
    FAILURE = "failure"
    SKIP = "skip"


@dataclass
class StateDefinition:
    name: str
    handler: str  # handler function name
    transitions: dict[str, str] = field(default_factory=dict)  # result -> next_state
    timeout_s: float = 60.0
    metadata: dict[str, Any] = field(default_factory=dict)


@dataclass
class FlowDefinition:
    name: str
    initial_state: str
    states: dict[str, StateDefinition] = field(default_factory=dict)
    terminal_states: set[str] = field(default_factory=set)


@dataclass
class FlowInstance:
    id: str = field(default_factory=lambda: str(uuid.uuid4()))
    flow_name: str = ""
    current_state: str = ""
    context: dict[str, Any] = field(default_factory=dict)
    history: list[dict[str, Any]] = field(default_factory=list)
    created_at: float = field(default_factory=time.time)
    updated_at: float = field(default_factory=time.time)
    status: str = "running"  # running | completed | failed | aborted


class StateMachineEngine:
    """状态机引擎，管理流程定义和实例执行。"""

    def __init__(self) -> None:
        self._flows: dict[str, FlowDefinition] = {}
        self._instances: dict[str, FlowInstance] = {}
        self._handlers: dict[str, Callable[..., Awaitable[TransitionResult]]] = {}

    def register_flow(self, flow: FlowDefinition) -> None:
        self._flows[flow.name] = flow
        logger.info("Flow registered", name=flow.name, states=len(flow.states))

    def register_handler(self, name: str, handler: Callable[..., Awaitable[TransitionResult]]) -> None:
        self._handlers[name] = handler

    async def start_flow(self, flow_name: str, context: dict[str, Any] | None = None) -> str:
        flow = self._flows.get(flow_name)
        if not flow:
            raise ValueError(f"Unknown flow: {flow_name}")

        instance = FlowInstance(
            flow_name=flow_name,
            current_state=flow.initial_state,
            context=context or {},
        )
        self._instances[instance.id] = instance
        logger.info("Flow started", id=instance.id, flow=flow_name)
        return instance.id

    async def step(self, instance_id: str) -> bool:
        """Execute one step. Returns True if flow is still running."""
        instance = self._instances.get(instance_id)
        if not instance or instance.status != "running":
            return False

        flow = self._flows.get(instance.flow_name)
        if not flow:
            instance.status = "failed"
            return False

        state_def = flow.states.get(instance.current_state)
        if not state_def:
            instance.status = "failed"
            return False

        handler = self._handlers.get(state_def.handler)
        if not handler:
            logger.error("Handler not found", handler=state_def.handler)
            instance.status = "failed"
            return False

        try:
            result = await handler(instance.context)
            result_key = result.value if isinstance(result, TransitionResult) else str(result)

            instance.history.append({
                "state": instance.current_state,
                "result": result_key,
                "timestamp": time.time(),
            })
            instance.updated_at = time.time()

            next_state = state_def.transitions.get(result_key)
            if next_state is None:
                next_state = state_def.transitions.get("default")

            if next_state is None or next_state in flow.terminal_states:
                instance.status = "completed"
                if next_state:
                    instance.current_state = next_state
                return False

            instance.current_state = next_state
            return True

        except Exception as exc:
            logger.exception("State handler failed", state=instance.current_state)
            instance.history.append({
                "state": instance.current_state,
                "result": "error",
                "error": str(exc),
                "timestamp": time.time(),
            })
            error_state = state_def.transitions.get("failure")
            if error_state:
                instance.current_state = error_state
                return True
            instance.status = "failed"
            return False

    async def run_to_completion(self, instance_id: str, max_steps: int = 100) -> FlowInstance | None:
        for _ in range(max_steps):
            running = await self.step(instance_id)
            if not running:
                break
        self.cleanup_completed()
        return self._instances.get(instance_id)

    def cleanup_completed(self, max_age_s: float = 3600) -> int:
        """Remove completed/failed/aborted instances older than max_age_s. Returns count removed."""
        now = time.time()
        to_remove = [
            iid for iid, inst in self._instances.items()
            if inst.status in ("completed", "failed", "aborted")
            and (now - inst.updated_at) > max_age_s
        ]
        for iid in to_remove:
            del self._instances[iid]
        if to_remove:
            logger.info("StateMachine cleanup", removed=len(to_remove))
        return len(to_remove)

    def abort(self, instance_id: str) -> bool:
        instance = self._instances.get(instance_id)
        if instance and instance.status == "running":
            instance.status = "aborted"
            return True
        return False

    def get_instance(self, instance_id: str) -> FlowInstance | None:
        return self._instances.get(instance_id)

    def get_active_instances(self, flow_name: str | None = None) -> list[FlowInstance]:
        instances = [i for i in self._instances.values() if i.status == "running"]
        if flow_name:
            instances = [i for i in instances if i.flow_name == flow_name]
        return instances
