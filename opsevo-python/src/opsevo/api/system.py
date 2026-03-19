"""Health & System API routes.

GET  /api/health
GET  /api/devices/{device_id}/system/info
GET  /api/devices/{device_id}/system/scripts
POST /api/devices/{device_id}/system/scripts
PATCH /api/devices/{device_id}/system/scripts/{script_id}
DELETE /api/devices/{device_id}/system/scripts/{script_id}
POST /api/devices/{device_id}/system/scripts/{script_id}/run
POST /api/devices/{device_id}/system/reboot
POST /api/devices/{device_id}/system/shutdown
GET  /api/devices/{device_id}/system/scheduler
POST /api/devices/{device_id}/system/scheduler
PATCH /api/devices/{device_id}/system/scheduler/{task_id}
DELETE /api/devices/{device_id}/system/scheduler/{task_id}
POST /api/devices/{device_id}/system/scheduler/{task_id}/enable
POST /api/devices/{device_id}/system/scheduler/{task_id}/disable

Requirements: 3.4, 3.5
"""

from __future__ import annotations

import json
import time
import uuid

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import JSONResponse

from opsevo.api.deps import get_current_user, get_datastore

router = APIRouter(tags=["system"])


@router.get("/api/health")
async def health(request: Request):
    container = request.app.state.container
    services_ready = 0
    services_total = 0

    # Check datastore
    services_total += 1
    try:
        ok = await container.datastore().health_check()
        if ok:
            services_ready += 1
    except Exception:
        pass

    return JSONResponse(
        content={
            "status": "ok" if services_ready == services_total else "degraded",
            "timestamp": time.time(),
            "services": {"ready": services_ready, "total": services_total},
        },
        headers={"Content-Type": "application/json; charset=utf-8"},
    )


@router.get("/api/devices/{device_id}/system/info")
async def system_info(
    device_id: str,
    request: Request,
    user: dict = Depends(get_current_user),
):
    pool = request.app.state.container.device_pool()
    try:
        driver = await pool.get_driver(device_id)
        data = await driver.query("get_system_resource")
        return {"success": True, "data": data}
    except Exception as exc:
        return {"success": False, "error": str(exc)}


# ---------------------------------------------------------------------------
# Scripts CRUD — wired to DataStore
# ---------------------------------------------------------------------------
@router.get("/api/devices/{device_id}/system/scripts")
async def get_scripts(
    device_id: str,
    request: Request,
    ds=Depends(get_datastore),
    user: dict = Depends(get_current_user),
):
    rows = await ds.query(
        "SELECT * FROM system_scripts WHERE device_id=$1 ORDER BY created_at DESC",
        [device_id],
    )
    return {"success": True, "data": rows}


@router.post("/api/devices/{device_id}/system/scripts")
async def create_script(
    device_id: str,
    request: Request,
    ds=Depends(get_datastore),
    user: dict = Depends(get_current_user),
):
    body = await request.json()
    sid = str(uuid.uuid4())
    await ds.execute(
        "INSERT INTO system_scripts (id, device_id, name, content, language, created_at) "
        "VALUES ($1,$2,$3,$4,$5,NOW())",
        [sid, device_id, body.get("name", ""), body.get("content", ""),
         body.get("language", "cli")],
    )
    row = await ds.query_one("SELECT * FROM system_scripts WHERE id=$1", [sid])
    return {"success": True, "data": row}


@router.patch("/api/devices/{device_id}/system/scripts/{script_id}")
async def update_script(
    device_id: str,
    script_id: str,
    request: Request,
    ds=Depends(get_datastore),
    user: dict = Depends(get_current_user),
):
    _ALLOWED = {"name", "content", "language", "description"}
    body = await request.json()
    sets, params, idx = [], [], 1
    for k, v in body.items():
        if k not in _ALLOWED:
            continue
        sets.append(f"{k} = ${idx}")
        params.append(v)
        idx += 1
    if sets:
        params.append(script_id)
        await ds.execute(
            f"UPDATE system_scripts SET {', '.join(sets)} WHERE id = ${idx}",
            tuple(params),
        )
    row = await ds.query_one("SELECT * FROM system_scripts WHERE id=$1", [script_id])
    if not row:
        raise HTTPException(404, "Script not found")
    return {"success": True, "data": row}


@router.delete("/api/devices/{device_id}/system/scripts/{script_id}")
async def delete_script(
    device_id: str,
    script_id: str,
    ds=Depends(get_datastore),
    user: dict = Depends(get_current_user),
):
    await ds.execute(
        "DELETE FROM system_scripts WHERE id=$1 AND device_id=$2",
        [script_id, device_id],
    )
    return {"success": True, "message": "Script deleted"}


@router.post("/api/devices/{device_id}/system/scripts/{script_id}/run")
async def run_script(
    device_id: str,
    script_id: str,
    request: Request,
    ds=Depends(get_datastore),
    user: dict = Depends(get_current_user),
):
    row = await ds.query_one(
        "SELECT * FROM system_scripts WHERE id=$1 AND device_id=$2",
        [script_id, device_id],
    )
    if not row:
        raise HTTPException(404, "Script not found")
    pool = request.app.state.container.device_pool()
    try:
        driver = await pool.get_driver(device_id)
        result = await driver.execute("run_script", {"content": row.get("content", "")})
        return {"success": True, "data": result.data if hasattr(result, "data") else result}
    except Exception as exc:
        return {"success": False, "error": str(exc)}


# ---------------------------------------------------------------------------
# Power Management — wired to DevicePool
# ---------------------------------------------------------------------------
@router.post("/api/devices/{device_id}/system/reboot")
async def reboot_device(
    device_id: str,
    request: Request,
    user: dict = Depends(get_current_user),
):
    pool = request.app.state.container.device_pool()
    try:
        driver = await pool.get_driver(device_id)
        result = await driver.execute("reboot", {})
        return {"success": True, "message": "Reboot initiated", "data": result.data if hasattr(result, "data") else None}
    except Exception as exc:
        return {"success": False, "error": str(exc)}


@router.post("/api/devices/{device_id}/system/shutdown")
async def shutdown_device(
    device_id: str,
    request: Request,
    user: dict = Depends(get_current_user),
):
    pool = request.app.state.container.device_pool()
    try:
        driver = await pool.get_driver(device_id)
        result = await driver.execute("shutdown", {})
        return {"success": True, "message": "Shutdown initiated", "data": result.data if hasattr(result, "data") else None}
    except Exception as exc:
        return {"success": False, "error": str(exc)}


# ---------------------------------------------------------------------------
# System Scheduler — wired to DataStore
# ---------------------------------------------------------------------------
@router.get("/api/devices/{device_id}/system/scheduler")
async def get_system_schedulers(
    device_id: str,
    ds=Depends(get_datastore),
    user: dict = Depends(get_current_user),
):
    rows = await ds.query(
        "SELECT * FROM system_schedulers WHERE device_id=$1 ORDER BY created_at DESC",
        [device_id],
    )
    return {"success": True, "data": rows}


@router.post("/api/devices/{device_id}/system/scheduler")
async def create_system_scheduler(
    device_id: str,
    request: Request,
    ds=Depends(get_datastore),
    user: dict = Depends(get_current_user),
):
    body = await request.json()
    tid = str(uuid.uuid4())
    await ds.execute(
        "INSERT INTO system_schedulers (id, device_id, name, cron, script_id, enabled, created_at) "
        "VALUES ($1,$2,$3,$4,$5,$6,NOW())",
        [tid, device_id, body.get("name", ""), body.get("cron", ""),
         body.get("scriptId", ""), body.get("enabled", True)],
    )
    row = await ds.query_one("SELECT * FROM system_schedulers WHERE id=$1", [tid])
    return {"success": True, "data": row}


@router.patch("/api/devices/{device_id}/system/scheduler/{task_id}")
async def update_system_scheduler(
    device_id: str,
    task_id: str,
    request: Request,
    ds=Depends(get_datastore),
    user: dict = Depends(get_current_user),
):
    _ALLOWED = {"name", "cron", "script_id", "enabled", "description"}
    body = await request.json()
    sets, params, idx = [], [], 1
    for k, v in body.items():
        if k not in _ALLOWED:
            continue
        sets.append(f"{k} = ${idx}")
        params.append(v)
        idx += 1
    if sets:
        params.append(task_id)
        await ds.execute(
            f"UPDATE system_schedulers SET {', '.join(sets)} WHERE id = ${idx}",
            tuple(params),
        )
    row = await ds.query_one("SELECT * FROM system_schedulers WHERE id=$1", [task_id])
    if not row:
        raise HTTPException(404, "Scheduler task not found")
    return {"success": True, "data": row}


@router.delete("/api/devices/{device_id}/system/scheduler/{task_id}")
async def delete_system_scheduler(
    device_id: str,
    task_id: str,
    ds=Depends(get_datastore),
    user: dict = Depends(get_current_user),
):
    await ds.execute(
        "DELETE FROM system_schedulers WHERE id=$1 AND device_id=$2",
        [task_id, device_id],
    )
    return {"success": True, "message": "Scheduler task deleted"}


@router.post("/api/devices/{device_id}/system/scheduler/{task_id}/enable")
async def enable_system_scheduler(
    device_id: str,
    task_id: str,
    ds=Depends(get_datastore),
    user: dict = Depends(get_current_user),
):
    await ds.execute(
        "UPDATE system_schedulers SET enabled=true WHERE id=$1 AND device_id=$2",
        [task_id, device_id],
    )
    return {"success": True, "message": "Scheduler task enabled"}


@router.post("/api/devices/{device_id}/system/scheduler/{task_id}/disable")
async def disable_system_scheduler(
    device_id: str,
    task_id: str,
    ds=Depends(get_datastore),
    user: dict = Depends(get_current_user),
):
    await ds.execute(
        "UPDATE system_schedulers SET enabled=false WHERE id=$1 AND device_id=$2",
        [task_id, device_id],
    )
    return {"success": True, "message": "Scheduler task disabled"}
