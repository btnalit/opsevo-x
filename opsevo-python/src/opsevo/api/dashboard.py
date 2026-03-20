"""Dashboard API routes.

GET /api/devices/{device_id}/dashboard

Requirements: 3.1
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Request

from opsevo.api.deps import get_current_user
from opsevo.api.devices import _resolve_driver

router = APIRouter(tags=["dashboard"])


@router.get("/api/devices/{device_id}/dashboard/resource")
async def dashboard_resource(
    device_id: str,
    request: Request,
    user: dict = Depends(get_current_user),
):
    """Alias matching frontend dashboardApi.getResource()."""
    try:
        driver, _ = await _resolve_driver(request, device_id)
        metrics = await driver.collect_metrics()
        health = await driver.health_check()
        return {
            "success": True,
            "data": {
                "metrics": metrics.model_dump(),
                "health": health.model_dump(),
            },
        }
    except HTTPException:
        raise
    except Exception as exc:
        return {"success": False, "error": str(exc)}


@router.get("/api/devices/{device_id}/dashboard")
async def dashboard_data(
    device_id: str,
    request: Request,
    user: dict = Depends(get_current_user),
):
    try:
        driver, _ = await _resolve_driver(request, device_id)
        metrics = await driver.collect_metrics()
        health = await driver.health_check()
        return {
            "success": True,
            "data": {
                "metrics": metrics.model_dump(),
                "health": health.model_dump(),
            },
        }
    except HTTPException:
        raise
    except Exception as exc:
        return {"success": False, "error": str(exc)}
