"""Connection API routes (legacy compatibility).

GET  /api/connection/status
POST /api/connection/connect
POST /api/connection/disconnect
GET  /api/connection/config
POST /api/connection/config

Frontend AppLayout.vue still calls these endpoints.
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, Request

from opsevo.api.deps import get_current_user

router = APIRouter(prefix="/api/connection", tags=["connection"])


@router.get("/status")
async def get_status(request: Request, user: dict = Depends(get_current_user)):
    container = request.app.state.container
    pool = container.device_pool()
    connected = pool.active_count > 0 if hasattr(pool, "active_count") else False
    config_data = {}
    if connected:
        try:
            dm = container.device_manager()
            devices = await dm.list_devices(tenant_id=str(user["id"]))
            if devices:
                d = devices[0]
                config_data = {
                    "host": d.get("host", ""),
                    "port": d.get("port", 0),
                    "username": d.get("username", ""),
                    "name": d.get("name", ""),
                }
        except Exception:
            pass
    return {"success": True, "data": {"connected": connected, "config": config_data}}


@router.post("/connect")
async def connect(request: Request, user: dict = Depends(get_current_user)):
    body = await request.json()
    host = body.get("host", "")
    container = request.app.state.container
    dm = container.device_manager()
    devices = await dm.list_devices(tenant_id=str(user["id"]))
    target = next((d for d in devices if d.get("host") == host), None)
    if not target:
        return {"success": False, "error": "Device not found for host"}
    pool = container.device_pool()
    try:
        driver = await pool.get_driver(target["id"])
        await driver.connect()
        return {"success": True, "data": {"connected": True}}
    except Exception as exc:
        return {"success": False, "error": str(exc)}


@router.post("/disconnect")
async def disconnect(request: Request, user: dict = Depends(get_current_user)):
    return {"success": True, "data": {"connected": False}}


@router.get("/config")
async def get_config(request: Request, user: dict = Depends(get_current_user)):
    return {"success": True, "data": {}}


@router.post("/config")
async def save_config(request: Request, user: dict = Depends(get_current_user)):
    body = await request.json()
    return {"success": True, "data": body}
