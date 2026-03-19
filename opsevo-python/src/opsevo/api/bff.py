"""
BFF API 路由 — 前端视图聚合 REST API 端点
/api/v1/* 聚合端点

接入 DevicePool, DriverManager, EventBus, SyslogReceiver,
SnmpTrapReceiver, DataStore 等真实服务。
"""

from __future__ import annotations

import json
import uuid
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Query, Request

from .deps import get_current_user, get_datastore

router = APIRouter(prefix="/api", tags=["bff"])


def _c(request: Request):
    return request.app.state.container


# ---------------------------------------------------------------------------
# Device Operations — wired to DevicePool
# ---------------------------------------------------------------------------
@router.post("/devices/{device_id}/execute")
async def device_execute(device_id: str, request: Request, ds=Depends(get_datastore), user=Depends(get_current_user)) -> dict:
    body = await request.json()
    pool = _c(request).device_pool()
    try:
        driver = await pool.get_driver(device_id)
        command = body.get("command", "")
        params = body.get("params", {})
        result = await driver.execute(command, params)
        return {"success": True, "data": result.data if hasattr(result, "data") else result}
    except Exception as exc:
        return {"success": False, "error": str(exc)}


@router.get("/devices/{device_id}/metrics")
async def device_metrics(device_id: str, ds=Depends(get_datastore), user=Depends(get_current_user)) -> dict:
    row = await ds.query_one(
        "SELECT * FROM system_metrics WHERE device_id=$1 ORDER BY timestamp DESC LIMIT 1", [device_id]
    )
    return {"success": True, "data": row or {}}


@router.get("/devices/{device_id}/health-detail")
async def device_health_detail(device_id: str, request: Request, ds=Depends(get_datastore), user=Depends(get_current_user)) -> dict:
    hm = _c(request).health_monitor()
    status = hm.get_device_status(device_id)
    return {"success": True, "data": status or {"healthy": True, "message": "No health data"}}


@router.get("/devices/{device_id}/health")
async def device_health(device_id: str, request: Request, ds=Depends(get_datastore), user=Depends(get_current_user)) -> dict:
    """Alias matching frontend deviceApi.getHealth()."""
    hm = _c(request).health_monitor()
    status = hm.get_device_status(device_id)
    return {"success": True, "data": status or {"healthy": True, "message": "No health data"}}


# ---------------------------------------------------------------------------
# Drivers & Profiles — wired to DriverManager + DataStore
# ---------------------------------------------------------------------------
@router.get("/drivers")
async def get_drivers(request: Request, user=Depends(get_current_user)) -> dict:
    dm = _c(request).driver_manager()
    profiles = dm.profiles
    drivers = [
        {"name": name, "driverType": p.driver_type, "vendor": p.vendor, "model": p.model}
        for name, p in profiles.items()
    ]
    return {"success": True, "data": drivers}


@router.get("/drivers/{driver_type}/manifest")
async def get_driver_manifest(driver_type: str, request: Request, user=Depends(get_current_user)) -> dict:
    dm = _c(request).driver_manager()
    profiles = dm.profiles
    profile = profiles.get(driver_type)
    if not profile:
        from fastapi import HTTPException
        raise HTTPException(404, f"Driver type '{driver_type}' not found")
    manifest = {
        "driverType": profile.driver_type,
        "vendor": profile.vendor,
        "model": profile.model,
        "capabilities": getattr(profile, "capabilities", {}),
        "actionTypes": getattr(profile, "action_types", []),
    }
    return {"success": True, "data": manifest}


@router.get("/profiles")
async def get_profiles(ds=Depends(get_datastore), user=Depends(get_current_user)) -> dict:
    rows = await ds.query("SELECT * FROM device_profiles ORDER BY name ASC")
    return {"success": True, "data": rows}


@router.get("/profiles/export")
async def export_profiles(ds=Depends(get_datastore), user=Depends(get_current_user)) -> dict:
    rows = await ds.query("SELECT * FROM device_profiles ORDER BY name ASC")
    return {"success": True, "data": rows}


@router.post("/profiles/import")
async def import_profile(request: Request, ds=Depends(get_datastore), user=Depends(get_current_user)) -> dict:
    body = await request.json()
    imported = []
    profiles = body if isinstance(body, list) else [body]
    for p in profiles:
        pid = str(uuid.uuid4())
        await ds.execute(
            "INSERT INTO device_profiles (id, name, vendor, model, config, created_at) VALUES ($1,$2,$3,$4,$5,NOW())",
            [pid, p.get("name", ""), p.get("vendor", ""), p.get("model", ""), json.dumps(p.get("config", {}))],
        )
        imported.append(pid)
    return {"success": True, "data": {"imported": len(imported), "ids": imported}}


@router.get("/profiles/{profile_id}")
async def get_profile_by_id(profile_id: str, ds=Depends(get_datastore), user=Depends(get_current_user)) -> dict:
    row = await ds.query_one("SELECT * FROM device_profiles WHERE id=$1", [profile_id])
    if not row:
        raise HTTPException(404, "Profile not found")
    return {"success": True, "data": row}


@router.get("/profiles/{profile_id}/export")
async def export_profile_by_id(profile_id: str, ds=Depends(get_datastore), user=Depends(get_current_user)) -> dict:
    row = await ds.query_one("SELECT * FROM device_profiles WHERE id=$1", [profile_id])
    if not row:
        raise HTTPException(404, "Profile not found")
    return {"success": True, "data": row}


@router.post("/profiles")
async def create_profile(request: Request, ds=Depends(get_datastore), user=Depends(get_current_user)) -> dict:
    body = await request.json()
    pid = str(uuid.uuid4())
    await ds.execute(
        "INSERT INTO device_profiles (id, name, vendor, model, config, created_at) VALUES ($1,$2,$3,$4,$5,NOW())",
        [pid, body.get("name", ""), body.get("vendor", ""), body.get("model", ""), json.dumps(body.get("config", {}))],
    )
    row = await ds.query_one("SELECT * FROM device_profiles WHERE id=$1", [pid])
    return {"success": True, "data": row}


@router.put("/profiles/{profile_id}")
async def update_profile(profile_id: str, request: Request, ds=Depends(get_datastore), user=Depends(get_current_user)) -> dict:
    _ALLOWED = {"name", "vendor", "model", "config"}
    body = await request.json()
    sets, params, idx = [], [], 1
    for k, v in body.items():
        if k not in _ALLOWED:
            continue
        if k == "config":
            v = json.dumps(v)
        sets.append(f"{k} = ${idx}")
        params.append(v)
        idx += 1
    if sets:
        params.append(profile_id)
        await ds.execute(f"UPDATE device_profiles SET {', '.join(sets)} WHERE id = ${idx}", tuple(params))
    row = await ds.query_one("SELECT * FROM device_profiles WHERE id=$1", [profile_id])
    return {"success": True, "data": row}


@router.delete("/profiles/{profile_id}")
async def delete_profile(profile_id: str, ds=Depends(get_datastore), user=Depends(get_current_user)) -> dict:
    await ds.execute("DELETE FROM device_profiles WHERE id=$1", [profile_id])
    return {"success": True, "message": "Profile deleted"}


# ---------------------------------------------------------------------------
# Noise Filter — wired to AlertPipeline
# ---------------------------------------------------------------------------
@router.get("/noise-filter/stats")
async def get_noise_filter_stats(request: Request, user=Depends(get_current_user)) -> dict:
    pipeline = _c(request).alert_pipeline()
    stats = pipeline.get_stats()
    return {"success": True, "data": {"filtered": stats.get("filtered", 0), "deduplicated": stats.get("deduplicated", 0)}}


# ---------------------------------------------------------------------------
# Inspections — wired to DataStore + DevicePool
# ---------------------------------------------------------------------------
@router.get("/inspections/tasks")
async def get_inspection_tasks(ds=Depends(get_datastore), user=Depends(get_current_user)) -> dict:
    rows = await ds.query("SELECT * FROM inspection_tasks ORDER BY created_at DESC")
    return {"success": True, "data": rows}


@router.get("/inspections/history")
async def get_inspection_history(ds=Depends(get_datastore), user=Depends(get_current_user)) -> dict:
    rows = await ds.query("SELECT * FROM inspection_history ORDER BY executed_at DESC LIMIT 50")
    return {"success": True, "data": rows}


@router.post("/inspections/trigger")
async def trigger_inspection(request: Request, ds=Depends(get_datastore), user=Depends(get_current_user)) -> dict:
    iid = str(uuid.uuid4())
    await ds.execute(
        "INSERT INTO inspection_history (id, status, executed_at) VALUES ($1, 'running', NOW())", [iid]
    )
    return {"success": True, "message": "Inspection triggered", "data": {"id": iid}}


# ---------------------------------------------------------------------------
# Tools — wired to ToolRegistry
# ---------------------------------------------------------------------------
@router.get("/tools")
async def get_tools(request: Request, user=Depends(get_current_user)) -> dict:
    try:
        tr = _c(request).tool_registry()
        all_tools = tr.get_all_tools()  # returns list[UnifiedTool]
        return {
            "success": True,
            "data": [
                {"name": t.name, "description": t.description, "source": t.source}
                for t in all_tools
            ],
        }
    except Exception:
        return {"success": True, "data": []}


# ---------------------------------------------------------------------------
# Evaluations — wired to DataStore
# ---------------------------------------------------------------------------
@router.get("/evaluations")
async def get_evaluations(
    page: int = Query(1), limit: int = Query(20),
    ds=Depends(get_datastore), user=Depends(get_current_user),
) -> dict:
    rows = await ds.query("SELECT * FROM evaluation_reports ORDER BY created_at DESC")
    total = len(rows)
    start = (page - 1) * limit
    return {"success": True, "data": rows[start:start + limit], "total": total}


@router.get("/evaluations/{eval_id}")
async def get_evaluation_by_id(eval_id: str, ds=Depends(get_datastore), user=Depends(get_current_user)) -> dict:
    row = await ds.query_one("SELECT * FROM evaluation_reports WHERE id=$1", [eval_id])
    if not row:
        raise HTTPException(404, "Evaluation not found")
    return {"success": True, "data": row}


# ---------------------------------------------------------------------------
# Knowledge — wired to KnowledgeBase + DataStore
# ---------------------------------------------------------------------------
@router.get("/knowledge")
async def get_knowledge_entries(
    page: int = Query(1), limit: int = Query(20),
    ds=Depends(get_datastore), user=Depends(get_current_user),
) -> dict:
    rows = await ds.query("SELECT * FROM knowledge_entries ORDER BY created_at DESC")
    total = len(rows)
    start = (page - 1) * limit
    return {"success": True, "data": rows[start:start + limit], "total": total}


@router.post("/knowledge/search")
async def search_knowledge(request: Request, ds=Depends(get_datastore), user=Depends(get_current_user)) -> dict:
    body = await request.json()
    query = body.get("query", "")
    try:
        kb = _c(request).knowledge_base()
        results = await kb.search(query) if hasattr(kb, "search") else []
        return {"success": True, "data": results}
    except Exception:
        # Fallback to simple DB search
        rows = await ds.query(
            "SELECT * FROM knowledge_entries WHERE content ILIKE $1 LIMIT 20", [f"%{query}%"]
        )
        return {"success": True, "data": rows}


# ---------------------------------------------------------------------------
# Knowledge Graph — wired to DataStore
# ---------------------------------------------------------------------------
@router.get("/knowledge-graph/nodes")
async def get_knowledge_graph_nodes(
    type: str = Query(None), limit: int = Query(100),
    ds=Depends(get_datastore), user=Depends(get_current_user),
) -> dict:
    if type:
        rows = await ds.query(
            "SELECT * FROM knowledge_graph_nodes WHERE type=$1 LIMIT $2", [type, limit]
        )
    else:
        rows = await ds.query("SELECT * FROM knowledge_graph_nodes LIMIT $1", [limit])
    return {"success": True, "data": rows}


@router.get("/knowledge-graph/nodes/{node_id}")
async def get_knowledge_graph_node(node_id: str, ds=Depends(get_datastore), user=Depends(get_current_user)) -> dict:
    row = await ds.query_one("SELECT * FROM knowledge_graph_nodes WHERE id=$1", [node_id])
    if not row:
        raise HTTPException(404, "Node not found")
    return {"success": True, "data": row}


@router.get("/knowledge-graph/edges")
async def get_knowledge_graph_edges(
    source: str = Query(None), target: str = Query(None),
    ds=Depends(get_datastore), user=Depends(get_current_user),
) -> dict:
    base = "SELECT * FROM knowledge_graph_edges WHERE 1=1"
    params: list = []
    idx = 1
    if source:
        base += f" AND source_id=${idx}"
        params.append(source)
        idx += 1
    if target:
        base += f" AND target_id=${idx}"
        params.append(target)
        idx += 1
    rows = await ds.query(base, params)
    return {"success": True, "data": rows}
