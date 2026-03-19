"""
ContextManager — 状态机上下文管理

管理流程实例的共享上下文数据。
"""

from __future__ import annotations

import copy
from typing import Any

import structlog

logger = structlog.get_logger(__name__)


class ContextManager:
    """管理状态机流程实例的上下文数据。"""

    def __init__(self) -> None:
        self._contexts: dict[str, dict[str, Any]] = {}

    def create(self, instance_id: str, initial: dict[str, Any] | None = None) -> dict[str, Any]:
        ctx = copy.deepcopy(initial) if initial else {}
        self._contexts[instance_id] = ctx
        return ctx

    def get(self, instance_id: str) -> dict[str, Any] | None:
        return self._contexts.get(instance_id)

    def update(self, instance_id: str, data: dict[str, Any]) -> None:
        ctx = self._contexts.get(instance_id)
        if ctx is not None:
            ctx.update(data)

    def delete(self, instance_id: str) -> None:
        self._contexts.pop(instance_id, None)

    def snapshot(self, instance_id: str) -> dict[str, Any] | None:
        ctx = self._contexts.get(instance_id)
        return copy.deepcopy(ctx) if ctx else None
