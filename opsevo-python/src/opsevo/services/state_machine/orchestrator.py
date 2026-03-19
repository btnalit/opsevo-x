"""
StateOrchestrator — 状态机编排器

协调多个状态机实例的执行，管理并发和优先级。
"""

from __future__ import annotations

import asyncio
from typing import Any

import structlog

from .engine import StateMachineEngine, FlowInstance

logger = structlog.get_logger(__name__)


class StateOrchestrator:
    """编排多个状态机流程的并发执行。"""

    def __init__(self, engine: StateMachineEngine, max_concurrent: int = 10) -> None:
        self._engine = engine
        self._max_concurrent = max_concurrent
        self._semaphore = asyncio.Semaphore(max_concurrent)
        self._running_tasks: dict[str, asyncio.Task[Any]] = {}

    async def start_and_run(self, flow_name: str, context: dict[str, Any] | None = None) -> FlowInstance | None:
        instance_id = await self._engine.start_flow(flow_name, context)
        async with self._semaphore:
            return await self._engine.run_to_completion(instance_id)

    async def start_background(self, flow_name: str, context: dict[str, Any] | None = None) -> str:
        instance_id = await self._engine.start_flow(flow_name, context)
        task = asyncio.create_task(self._run_with_semaphore(instance_id))
        self._running_tasks[instance_id] = task
        return instance_id

    async def _run_with_semaphore(self, instance_id: str) -> None:
        try:
            async with self._semaphore:
                await self._engine.run_to_completion(instance_id)
        except Exception:
            logger.exception("Background flow failed", instance_id=instance_id)
        finally:
            self._running_tasks.pop(instance_id, None)

    def abort(self, instance_id: str) -> bool:
        result = self._engine.abort(instance_id)
        task = self._running_tasks.pop(instance_id, None)
        if task and not task.done():
            task.cancel()
        return result

    def get_status(self) -> dict[str, Any]:
        return {
            "active": len(self._running_tasks),
            "max_concurrent": self._max_concurrent,
            "instances": {
                k: self._engine.get_instance(k)
                for k in self._running_tasks
            },
        }
