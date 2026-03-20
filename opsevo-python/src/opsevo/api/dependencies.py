"""FastAPI dependency injection helpers.

Exposes container singletons via Depends() for API routes.
"""

from __future__ import annotations

from typing import TYPE_CHECKING

from fastapi import Request

if TYPE_CHECKING:
    from opsevo.services.device_orchestrator import DeviceOrchestrator


def get_device_orchestrator(request: Request) -> DeviceOrchestrator:
    """FastAPI 依赖项：获取 DeviceOrchestrator 单例。"""
    return request.app.state.container.device_orchestrator()
