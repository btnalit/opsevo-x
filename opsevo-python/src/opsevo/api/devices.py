"""Devices API routes.

GET    /api/devices
POST   /api/devices
GET    /api/devices/{device_id}
PUT    /api/devices/{device_id}
DELETE /api/devices/{device_id}
POST   /api/devices/{device_id}/test
POST   /api/devices/{device_id}/connect
POST   /api/devices/{device_id}/disconnect
POST   /api/devices/{device_id}/test-connection
GET    /api/devices/{device_id}/metrics
GET    /api/devices/{device_id}/health
POST   /api/devices/{device_id}/execute

Requirements: 3.1
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Request, status

from opsevo.api.deps import get_current_user
from opsevo.models.common import MessageResponse, SuccessResponse
from opsevo.models.device import DeviceCreate, DeviceResponse, DeviceUpdate

router = APIRouter(prefix="/api/devices", tags=["devices"])


def _get_device_manager(request: Request):
    return request.app.state.container.device_manager()


def _get_device_pool(request: Request):
    return request.app.state.container.device_pool()


@router.get("")
async def list_devices(
    request: Request,
    user: dict = Depends(get_current_user),
):
    dm = _get_device_manager(request)
    devices = await dm.list_devices(tenant_id=str(user["id"]))
    return SuccessResponse(data=devices).model_dump()


@router.post("", status_code=201)
async def create_device(
    body: DeviceCreate,
    request: Request,
    user: dict = Depends(get_current_user),
):
    dm = _get_device_manager(request)
    device = await dm.create_device(
        tenant_id=str(user["id"]),
        data=body.model_dump(),
    )
    return SuccessResponse(data=device).model_dump()


@router.get("/{device_id}")
async def get_device(
    device_id: str,
    request: Request,
    user: dict = Depends(get_current_user),
):
    dm = _get_device_manager(request)
    device = await dm.get_device(device_id)
    if device is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="Device not found")
    return SuccessResponse(data=device).model_dump()


@router.put("/{device_id}")
async def update_device(
    device_id: str,
    body: DeviceUpdate,
    request: Request,
    user: dict = Depends(get_current_user),
):
    dm = _get_device_manager(request)
    updated = await dm.update_device(device_id, body.model_dump(exclude_none=True))
    if updated is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="Device not found")
    return SuccessResponse(data=updated).model_dump()


@router.delete("/{device_id}")
async def delete_device(
    device_id: str,
    request: Request,
    user: dict = Depends(get_current_user),
):
    dm = _get_device_manager(request)
    ok = await dm.delete_device(device_id)
    if not ok:
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="Device not found")
    return MessageResponse(message="Device deleted").model_dump()


@router.post("/{device_id}/connect")
async def connect_device(
    device_id: str,
    request: Request,
    user: dict = Depends(get_current_user),
):
    pool = _get_device_pool(request)
    try:
        driver = await pool.get_driver(device_id)
        await driver.connect()
        dm = _get_device_manager(request)
        await dm.update_device(device_id, {"status": "online"})
        return SuccessResponse(data={"connected": True}).model_dump()
    except Exception as exc:
        return {"success": False, "error": str(exc)}


@router.post("/{device_id}/disconnect")
async def disconnect_device(
    device_id: str,
    request: Request,
    user: dict = Depends(get_current_user),
):
    pool = _get_device_pool(request)
    try:
        driver = await pool.get_driver(device_id)
        await driver.disconnect()
        dm = _get_device_manager(request)
        await dm.update_device(device_id, {"status": "offline"})
        return SuccessResponse(data={"connected": False}).model_dump()
    except Exception as exc:
        return {"success": False, "error": str(exc)}


@router.post("/{device_id}/test-connection")
async def test_device_connection_alias(
    device_id: str,
    request: Request,
    user: dict = Depends(get_current_user),
):
    """Alias for /test to match frontend deviceApi.testConnection()."""
    pool = _get_device_pool(request)
    try:
        driver = await pool.get_driver(device_id)
        result = await driver.health_check()
        return SuccessResponse(data=result.model_dump()).model_dump()
    except Exception as exc:
        return {"success": False, "error": str(exc)}


@router.post("/{device_id}/test")
async def test_device_connection(
    device_id: str,
    request: Request,
    user: dict = Depends(get_current_user),
):
    pool = _get_device_pool(request)
    try:
        driver = await pool.get_driver(device_id)
        result = await driver.health_check()
        return SuccessResponse(data=result.model_dump()).model_dump()
    except Exception as exc:
        return {"success": False, "error": str(exc)}


@router.get("/{device_id}/metrics")
async def get_device_metrics(
    device_id: str,
    request: Request,
    user: dict = Depends(get_current_user),
):
    """GET /api/devices/{device_id}/metrics — frontend deviceApi.getMetrics()."""
    pool = _get_device_pool(request)
    try:
        driver = await pool.get_driver(device_id)
        metrics = await driver.collect_metrics()
        return SuccessResponse(data=metrics.model_dump()).model_dump()
    except Exception as exc:
        return {"success": False, "error": str(exc)}


@router.get("/{device_id}/health")
async def get_device_health(
    device_id: str,
    request: Request,
    user: dict = Depends(get_current_user),
):
    """GET /api/devices/{device_id}/health — frontend deviceApi.getHealth()."""
    pool = _get_device_pool(request)
    try:
        driver = await pool.get_driver(device_id)
        result = await driver.health_check()
        return SuccessResponse(data=result.model_dump()).model_dump()
    except Exception as exc:
        return {"success": False, "error": str(exc)}


@router.post("/{device_id}/execute")
async def execute_device_command(
    device_id: str,
    request: Request,
    user: dict = Depends(get_current_user),
):
    """POST /api/devices/{device_id}/execute — frontend deviceApi.execute()."""
    pool = _get_device_pool(request)
    body = await request.json()
    command = body.get("command", "")
    params = body.get("params", {})
    try:
        driver = await pool.get_driver(device_id)
        result = await driver.execute(command, params)
        return SuccessResponse(data=result.data if hasattr(result, "data") else result).model_dump()
    except Exception as exc:
        return {"success": False, "error": str(exc)}
