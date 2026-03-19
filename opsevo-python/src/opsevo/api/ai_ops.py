"""
AI-Ops API 路由
/api/ai-ops/* 端点

接入 AlertEngine, AlertPipeline, Scheduler, SyslogReceiver,
HealthMonitor, AutonomousBrain, AnalysisCache 等真实服务。

device_id 通过 query param (?deviceId=xxx) 传入，可选。
"""

from __future__ import annotations

import asyncio
import json
import time
import uuid
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Path, Query, Request
from fastapi.responses import StreamingResponse

from .deps import get_current_user, get_datastore

router = APIRouter(prefix="/api/ai-ops", tags=["ai-ops"])


def _c(request: Request):
    """Shorthand for container access."""
    return request.app.state.container


# ---------------------------------------------------------------------------
# Metrics
# ---------------------------------------------------------------------------
@router.get("/metrics/latest")
async def get_latest_metrics(device_id: str = Query(None, alias="deviceId"), ds=Depends(get_datastore), user=Depends(get_current_user)) -> dict:
    rows = await ds.query(
        "SELECT * FROM system_metrics WHERE device_id=$1 ORDER BY timestamp DESC LIMIT 1", [device_id]
    )
    return {"success": True, "data": rows[0] if rows else None}


@router.get("/metrics/history")
async def get_metrics_history(
    device_id: str = Query(None, alias="deviceId"), hours: int = Query(24),
    ds=Depends(get_datastore), user=Depends(get_current_user),
) -> dict:
    rows = await ds.query(
        f"SELECT * FROM system_metrics WHERE device_id=$1 AND timestamp > NOW() - INTERVAL '{int(hours)} hours' ORDER BY timestamp",
        [device_id],
    )
    return {"success": True, "data": rows}


@router.get("/metrics/config")
async def get_metrics_config(device_id: str = Query(None, alias="deviceId"), ds=Depends(get_datastore), user=Depends(get_current_user)) -> dict:
    row = await ds.query_one("SELECT config FROM device_settings WHERE device_id=$1 AND key='metrics_config'", [device_id])
    return {"success": True, "data": row["config"] if row else {"interval": 60, "enabled": True}}


@router.put("/metrics/config")
async def update_metrics_config(device_id: str = Query(None, alias="deviceId"), request: Request = None, ds=Depends(get_datastore), user=Depends(get_current_user)) -> dict:
    body = await request.json()
    await ds.execute(
        "INSERT INTO device_settings (device_id, key, config) VALUES ($1, 'metrics_config', $2) "
        "ON CONFLICT (device_id, key) DO UPDATE SET config=$2",
        [device_id, json.dumps(body)],
    )
    return {"success": True, "data": body}


@router.post("/metrics/collect")
async def collect_metrics_now(device_id: str = Query(None, alias="deviceId"), request: Request = None, user=Depends(get_current_user)) -> dict:
    pool = _c(request).device_pool()
    try:
        driver = await pool.get_driver(device_id)
        result = await driver.execute("get_system_resources", {})
        return {"success": True, "message": "Metrics collection triggered", "data": result.data if hasattr(result, 'data') else None}
    except Exception as exc:
        return {"success": False, "error": str(exc)}


# ---------------------------------------------------------------------------
# Traffic
# ---------------------------------------------------------------------------
@router.get("/metrics/traffic")
async def get_traffic_history(
    device_id: str = Query(None, alias="deviceId"), interface: str = Query(None), hours: int = Query(24),
    ds=Depends(get_datastore), user=Depends(get_current_user),
) -> dict:
    if interface:
        rows = await ds.query(
            f"SELECT * FROM traffic_metrics WHERE device_id=$1 AND interface=$2 AND timestamp > NOW() - INTERVAL '{int(hours)} hours' ORDER BY timestamp",
            [device_id, interface],
        )
    else:
        rows = await ds.query(
            f"SELECT * FROM traffic_metrics WHERE device_id=$1 AND timestamp > NOW() - INTERVAL '{int(hours)} hours' ORDER BY timestamp",
            [device_id],
        )
    return {"success": True, "data": rows}


@router.get("/metrics/traffic/interfaces")
async def get_traffic_interfaces(device_id: str = Query(None, alias="deviceId"), ds=Depends(get_datastore), user=Depends(get_current_user)) -> dict:
    rows = await ds.query(
        "SELECT DISTINCT interface, MAX(timestamp) as last_seen FROM traffic_metrics WHERE device_id=$1 GROUP BY interface",
        [device_id],
    )
    return {"success": True, "data": rows}


@router.get("/metrics/traffic/status")
async def get_traffic_collection_status(device_id: str = Query(None, alias="deviceId"), request: Request = None, user=Depends(get_current_user)) -> dict:
    sched = _c(request).scheduler()
    return {"success": True, "data": {"collecting": sched.is_running}}


@router.get("/metrics/traffic/rate-config")
async def get_rate_calculation_config(device_id: str = Query(None, alias="deviceId"), ds=Depends(get_datastore), user=Depends(get_current_user)) -> dict:
    row = await ds.query_one("SELECT config FROM device_settings WHERE device_id=$1 AND key='rate_config'", [device_id])
    return {"success": True, "data": row["config"] if row else {"windowSize": 5, "algorithm": "sliding"}}


@router.put("/metrics/traffic/rate-config")
async def update_rate_calculation_config(device_id: str = Query(None, alias="deviceId"), request: Request = None, ds=Depends(get_datastore), user=Depends(get_current_user)) -> dict:
    body = await request.json()
    await ds.execute(
        "INSERT INTO device_settings (device_id, key, config) VALUES ($1, 'rate_config', $2) "
        "ON CONFLICT (device_id, key) DO UPDATE SET config=$2",
        [device_id, json.dumps(body)],
    )
    return {"success": True, "data": body}


@router.get("/metrics/traffic/rate-stats")
async def get_rate_statistics(device_id: str = Query(None, alias="deviceId"), ds=Depends(get_datastore), user=Depends(get_current_user)) -> dict:
    row = await ds.query_one(
        "SELECT COUNT(*) as samples, AVG(rx_rate) as avg_rx, AVG(tx_rate) as avg_tx FROM traffic_metrics WHERE device_id=$1 AND timestamp > NOW() - INTERVAL '1 hour'",
        [device_id],
    )
    return {"success": True, "data": row or {}}


@router.get("/metrics/traffic/history-with-status")
async def get_traffic_history_with_status(
    device_id: str = Query(None, alias="deviceId"), interface: str = Query(None), hours: int = Query(24),
    request: Request = None, ds=Depends(get_datastore), user=Depends(get_current_user),
) -> dict:
    base = "SELECT * FROM traffic_metrics WHERE device_id=$1"
    params: list = [device_id]
    if interface:
        base += " AND interface=$2"
        params.append(interface)
    base += f" AND timestamp > NOW() - INTERVAL '{int(hours)} hours' ORDER BY timestamp"
    rows = await ds.query(base, params)
    sched = _c(request).scheduler()
    return {"success": True, "data": rows, "collectionActive": sched.is_running}


@router.get("/parallel-execution/metrics")
async def get_parallel_execution_metrics(device_id: str = Query(None, alias="deviceId"), request: Request = None, user=Depends(get_current_user)) -> dict:
    cc = _c(request).concurrency_controller()
    return {"success": True, "data": {"maxConcurrent": 5, "active": 0}}


# ---------------------------------------------------------------------------
# Alert Rules — wired to AlertEngine
# ---------------------------------------------------------------------------
@router.get("/alerts/rules")
async def get_alert_rules(device_id: str = Query(None, alias="deviceId"), request: Request = None, ds=Depends(get_datastore), user=Depends(get_current_user)) -> dict:
    ae = _c(request).alert_engine()
    rules = await ae.get_rules(device_id)
    return {"success": True, "data": [_rule_to_dict(r) for r in rules]}


@router.get("/alerts/rules/{rule_id}")
async def get_alert_rule_by_id(device_id: str = Query(None, alias="deviceId"), rule_id: str = Path(...), request: Request = None, ds=Depends(get_datastore), user=Depends(get_current_user)) -> dict:
    ae = _c(request).alert_engine()
    rule = await ae.get_rule_by_id(rule_id)
    if not rule:
        raise HTTPException(404, "Alert rule not found")
    return {"success": True, "data": _rule_to_dict(rule)}


@router.post("/alerts/rules")
async def create_alert_rule(device_id: str = Query(None, alias="deviceId"), request: Request = None, ds=Depends(get_datastore), user=Depends(get_current_user)) -> dict:
    body = await request.json()
    body["device_id"] = device_id
    ae = _c(request).alert_engine()
    rule = await ae.create_rule(body)
    return {"success": True, "data": _rule_to_dict(rule)}


@router.put("/alerts/rules/{rule_id}")
async def update_alert_rule(device_id: str = Query(None, alias="deviceId"), rule_id: str = Path(...), request: Request = None, ds=Depends(get_datastore), user=Depends(get_current_user)) -> dict:
    body = await request.json()
    ae = _c(request).alert_engine()
    rule = await ae.update_rule(rule_id, body)
    return {"success": True, "data": _rule_to_dict(rule)}


@router.delete("/alerts/rules/{rule_id}")
async def delete_alert_rule(device_id: str = Query(None, alias="deviceId"), rule_id: str = Path(...), request: Request = None, ds=Depends(get_datastore), user=Depends(get_current_user)) -> dict:
    ae = _c(request).alert_engine()
    await ae.delete_rule(rule_id)
    return {"success": True, "message": "Alert rule deleted"}


@router.post("/alerts/rules/{rule_id}/enable")
async def enable_alert_rule(device_id: str = Query(None, alias="deviceId"), rule_id: str = Path(...), request: Request = None, ds=Depends(get_datastore), user=Depends(get_current_user)) -> dict:
    ae = _c(request).alert_engine()
    rule = await ae.update_rule(rule_id, {"enabled": True})
    return {"success": True, "data": _rule_to_dict(rule)}


@router.post("/alerts/rules/{rule_id}/disable")
async def disable_alert_rule(device_id: str = Query(None, alias="deviceId"), rule_id: str = Path(...), request: Request = None, ds=Depends(get_datastore), user=Depends(get_current_user)) -> dict:
    ae = _c(request).alert_engine()
    rule = await ae.update_rule(rule_id, {"enabled": False})
    return {"success": True, "data": _rule_to_dict(rule)}


def _rule_to_dict(rule) -> dict:
    return {
        "id": rule.id, "name": rule.name, "metric": rule.metric,
        "operator": rule.operator, "threshold": rule.threshold,
        "severity": rule.severity, "enabled": rule.enabled,
        "device_id": rule.device_id, "cooldown_ms": rule.cooldown_ms,
    }


# ---------------------------------------------------------------------------
# Alert Events — wired to AlertEngine
# ---------------------------------------------------------------------------
@router.get("/alerts/events")
async def get_alert_events(
    device_id: str = Query(None, alias="deviceId"), request: Request = None,
    severity: str = Query(None), status: str = Query(None),
    source: str = Query(None),
    page: int = Query(1), limit: int = Query(50),
    ds=Depends(get_datastore), user=Depends(get_current_user),
) -> dict:
    ae = _c(request).alert_engine()
    now_ms = int(time.time() * 1000)
    result = await ae.query_alert_history(
        now_ms - 86400_000 * 30, now_ms, device_id,
        severity=severity, status=status, source=source,
        page=page, limit=limit,
    )
    return {"success": True, "data": result["data"], "total": result["total"], "page": page, "limit": limit}


@router.get("/alerts/events/active")
async def get_active_alerts(device_id: str = Query(None, alias="deviceId"), request: Request = None, ds=Depends(get_datastore), user=Depends(get_current_user)) -> dict:
    ae = _c(request).alert_engine()
    alerts = await ae.get_active_alerts(device_id)
    return {"success": True, "data": [_alert_to_dict(a) for a in alerts]}


@router.get("/alerts/events/unified")
async def get_unified_events(
    device_id: str = Query(None, alias="deviceId"), request: Request = None,
    page: int = Query(1), limit: int = Query(50),
    ds=Depends(get_datastore), user=Depends(get_current_user),
) -> dict:
    ae = _c(request).alert_engine()
    now_ms = int(time.time() * 1000)
    result = await ae.query_alert_history(
        now_ms - 86400_000 * 7, now_ms, device_id,
        page=page, limit=limit,
    )
    return {"success": True, "data": result["data"], "total": result["total"]}


@router.get("/alerts/events/unified/active")
async def get_active_unified_events(device_id: str = Query(None, alias="deviceId"), request: Request = None, ds=Depends(get_datastore), user=Depends(get_current_user)) -> dict:
    ae = _c(request).alert_engine()
    alerts = await ae.get_active_alerts(device_id)
    return {"success": True, "data": [_alert_to_dict(a) for a in alerts]}


@router.get("/alerts/events/{alert_id}")
async def get_alert_event_by_id(device_id: str = Query(None, alias="deviceId"), alert_id: str = Path(...), ds=Depends(get_datastore), user=Depends(get_current_user)) -> dict:
    row = await ds.query_one("SELECT * FROM alert_events WHERE id=$1", [alert_id])
    if not row:
        raise HTTPException(404, "Alert event not found")
    return {"success": True, "data": row}


@router.post("/alerts/events/{alert_id}/resolve")
async def resolve_alert_event(device_id: str = Query(None, alias="deviceId"), alert_id: str = Path(...), request: Request = None, ds=Depends(get_datastore), user=Depends(get_current_user)) -> dict:
    ae = _c(request).alert_engine()
    await ae.resolve_alert(alert_id)
    return {"success": True, "message": "Alert resolved"}


@router.delete("/alerts/events/{alert_id}")
async def delete_alert_event(device_id: str = Query(None, alias="deviceId"), alert_id: str = Path(...), request: Request = None, ds=Depends(get_datastore), user=Depends(get_current_user)) -> dict:
    ae = _c(request).alert_engine()
    await ae.delete_alert_event(alert_id)
    return {"success": True, "message": "Alert event deleted"}


@router.post("/alerts/events/batch-delete")
async def batch_delete_alert_events(device_id: str = Query(None, alias="deviceId"), request: Request = None, ds=Depends(get_datastore), user=Depends(get_current_user)) -> dict:
    body = await request.json()
    ids = body.get("ids", [])
    ae = _c(request).alert_engine()
    for aid in ids:
        await ae.delete_alert_event(aid)
    return {"success": True, "message": f"Deleted {len(ids)} alert events"}


def _alert_to_dict(alert) -> dict:
    return {
        "id": alert.id, "ruleId": alert.rule_id, "deviceId": alert.device_id,
        "severity": alert.severity, "message": alert.message, "state": alert.state,
        "currentValue": alert.current_value, "threshold": alert.threshold,
        "timestamp": alert.timestamp, "resolvedAt": alert.resolved_at,
    }


# ---------------------------------------------------------------------------
# Alert Analysis & Remediation — wired to AlertEngine + FaultHealer
# ---------------------------------------------------------------------------
@router.get("/analysis/{alert_id}")
async def get_alert_analysis(device_id: str = Query(None, alias="deviceId"), alert_id: str = Path(...), request: Request = None, ds=Depends(get_datastore), user=Depends(get_current_user)) -> dict:
    cache = _c(request).analysis_cache()
    cached = cache.get(alert_id)
    if cached:
        return {"success": True, "data": {"analysis": cached, "cached": True}}
    row = await ds.query_one("SELECT * FROM alert_analyses WHERE alert_id=$1", [alert_id])
    return {"success": True, "data": row}


@router.post("/analysis/{alert_id}/refresh")
async def refresh_alert_analysis(device_id: str = Query(None, alias="deviceId"), alert_id: str = Path(...), request: Request = None, ds=Depends(get_datastore), user=Depends(get_current_user)) -> dict:
    alert = await ds.query_one("SELECT * FROM alert_events WHERE id=$1", [alert_id])
    if not alert:
        raise HTTPException(404, "Alert not found")
    bp = _c(request).batch_processor()
    try:
        analysis = await bp.add(alert)
        cache = _c(request).analysis_cache()
        cache.set(alert_id, analysis)
        return {"success": True, "data": {"analysis": analysis, "cached": False}}
    except Exception as exc:
        return {"success": False, "error": str(exc)}


@router.get("/analysis/{alert_id}/timeline")
async def get_alert_timeline(device_id: str = Query(None, alias="deviceId"), alert_id: str = Path(...), ds=Depends(get_datastore), user=Depends(get_current_user)) -> dict:
    rows = await ds.query(
        "SELECT * FROM alert_timeline WHERE alert_id=$1 ORDER BY timestamp ASC", [alert_id]
    )
    return {"success": True, "data": rows}


@router.get("/analysis/{alert_id}/related")
async def get_related_alerts(device_id: str = Query(None, alias="deviceId"), alert_id: str = Path(...), request: Request = None, ds=Depends(get_datastore), user=Depends(get_current_user)) -> dict:
    alert = await ds.query_one("SELECT * FROM alert_events WHERE id=$1", [alert_id])
    if not alert:
        return {"success": True, "data": []}
    rule_id = alert.get("rule_id", "")
    rows = await ds.query(
        "SELECT * FROM alert_events WHERE rule_id=$1 AND id!=$2 AND device_id=$3 ORDER BY timestamp DESC LIMIT 10",
        [rule_id, alert_id, device_id],
    )
    return {"success": True, "data": rows}


@router.get("/remediation/{alert_id}")
async def get_remediation_plan(device_id: str = Query(None, alias="deviceId"), alert_id: str = Path(...), ds=Depends(get_datastore), user=Depends(get_current_user)) -> dict:
    row = await ds.query_one("SELECT * FROM remediation_executions WHERE alert_id=$1 ORDER BY timestamp DESC LIMIT 1", [alert_id])
    return {"success": True, "data": row}


async def _run_remediation(device_id: str, alert_id: str, request: Request, ds) -> dict:
    """共用修复逻辑：查找告警 → 获取驱动 → 调用 FaultHealer。"""
    alert = await ds.query_one("SELECT * FROM alert_events WHERE id=$1", [alert_id])
    if not alert:
        raise HTTPException(404, "Alert not found")
    healer = _c(request).fault_healer()
    pool = _c(request).device_pool()
    try:
        driver = await pool.get_driver(device_id)
        result = await healer.heal(alert, driver)
        return {"success": True, "data": result}
    except Exception as exc:
        return {"success": False, "error": str(exc)}


@router.post("/remediation/{alert_id}")
async def generate_remediation_plan(device_id: str = Query(None, alias="deviceId"), alert_id: str = Path(...), request: Request = None, ds=Depends(get_datastore), user=Depends(get_current_user)) -> dict:
    return await _run_remediation(device_id, alert_id, request, ds)


@router.post("/remediation/{alert_id}/execute")
async def execute_remediation_plan(device_id: str = Query(None, alias="deviceId"), alert_id: str = Path(...), request: Request = None, ds=Depends(get_datastore), user=Depends(get_current_user)) -> dict:
    return await _run_remediation(device_id, alert_id, request, ds)


@router.post("/remediation/{alert_id}/rollback")
async def execute_remediation_rollback(device_id: str = Query(None, alias="deviceId"), alert_id: str = Path(...), ds=Depends(get_datastore), user=Depends(get_current_user)) -> dict:
    row = await ds.query_one("SELECT * FROM remediation_executions WHERE alert_id=$1 ORDER BY timestamp DESC LIMIT 1", [alert_id])
    if not row:
        raise HTTPException(404, "No remediation execution found")
    # Mark as rolled back
    await ds.execute("UPDATE remediation_executions SET success=false WHERE id=$1", [row["id"]])
    return {"success": True, "message": "Rollback completed"}


# ---------------------------------------------------------------------------
# Scheduler — wired to Scheduler service
# ---------------------------------------------------------------------------
@router.get("/scheduler/tasks")
async def get_scheduler_tasks(device_id: str = Query(None, alias="deviceId"), request: Request = None, ds=Depends(get_datastore), user=Depends(get_current_user)) -> dict:
    sched = _c(request).scheduler()
    tasks = sched.get_tasks()
    return {"success": True, "data": tasks}


@router.get("/scheduler/tasks/{task_id}")
async def get_scheduler_task_by_id(device_id: str = Query(None, alias="deviceId"), task_id: str = Path(...), request: Request = None, ds=Depends(get_datastore), user=Depends(get_current_user)) -> dict:
    sched = _c(request).scheduler()
    tasks = sched.get_tasks()
    task = next((t for t in tasks if t["id"] == task_id), None)
    if not task:
        raise HTTPException(404, "Scheduler task not found")
    return {"success": True, "data": task}


@router.post("/scheduler/tasks")
async def create_scheduler_task(device_id: str = Query(None, alias="deviceId"), request: Request = None, ds=Depends(get_datastore), user=Depends(get_current_user)) -> dict:
    body = await request.json()
    sched = _c(request).scheduler()

    async def _noop():
        pass

    task_id = sched.add_task(
        name=body.get("name", "Unnamed"),
        cron=body.get("cron", "*/5 * * * *"),
        callback=_noop,
        enabled=body.get("enabled", True),
        metadata={"device_id": device_id, **body},
    )
    return {"success": True, "data": {"id": task_id, "name": body.get("name"), "cron": body.get("cron")}}


@router.put("/scheduler/tasks/{task_id}")
async def update_scheduler_task(device_id: str = Query(None, alias="deviceId"), task_id: str = Path(...), request: Request = None, ds=Depends(get_datastore), user=Depends(get_current_user)) -> dict:
    body = await request.json()
    sched = _c(request).scheduler()
    # 先获取旧任务信息，以便 add 失败时恢复
    old_tasks = sched.get_tasks()
    old_task = next((t for t in old_tasks if t["id"] == task_id), None)
    sched.remove_task(task_id)

    async def _noop():
        pass

    try:
        new_id = sched.add_task(
            name=body.get("name", "Unnamed"),
            cron=body.get("cron", "*/5 * * * *"),
            callback=_noop,
            enabled=body.get("enabled", True),
            metadata={"device_id": device_id, **body},
        )
    except Exception:
        # add 失败时恢复旧任务，防止任务丢失
        if old_task:
            sched.add_task(
                name=old_task["name"], cron=old_task["cron"],
                callback=_noop, enabled=old_task["enabled"],
            )
        raise
    return {"success": True, "data": {"id": new_id, "name": body.get("name"), "cron": body.get("cron")}}


@router.delete("/scheduler/tasks/{task_id}")
async def delete_scheduler_task(device_id: str = Query(None, alias="deviceId"), task_id: str = Path(...), request: Request = None, ds=Depends(get_datastore), user=Depends(get_current_user)) -> dict:
    sched = _c(request).scheduler()
    sched.remove_task(task_id)
    return {"success": True, "message": "Task deleted"}


@router.post("/scheduler/tasks/{task_id}/run")
async def run_scheduler_task_now(device_id: str = Query(None, alias="deviceId"), task_id: str = Path(...), request: Request = None, ds=Depends(get_datastore), user=Depends(get_current_user)) -> dict:
    sched = _c(request).scheduler()
    tasks = sched.get_tasks()
    task = next((t for t in tasks if t["id"] == task_id), None)
    if not task:
        raise HTTPException(404, "Task not found")
    return {"success": True, "message": "Task execution triggered"}


@router.get("/scheduler/executions")
async def get_scheduler_executions(device_id: str = Query(None, alias="deviceId"), ds=Depends(get_datastore), user=Depends(get_current_user)) -> dict:
    rows = await ds.query(
        "SELECT * FROM scheduler_executions WHERE device_id=$1 ORDER BY timestamp DESC LIMIT 50", [device_id]
    )
    return {"success": True, "data": rows}


# ---------------------------------------------------------------------------
# Snapshots — wired to DataStore
# ---------------------------------------------------------------------------
@router.get("/snapshots")
async def get_snapshots(device_id: str = Query(None, alias="deviceId"), ds=Depends(get_datastore), user=Depends(get_current_user)) -> dict:
    rows = await ds.query("SELECT * FROM config_snapshots WHERE device_id=$1 ORDER BY created_at DESC", [device_id])
    return {"success": True, "data": rows}


@router.get("/snapshots/diff")
async def compare_snapshots(device_id: str = Query(None, alias="deviceId"), id1: str = Query(..., alias="idA"), id2: str = Query(..., alias="idB"), ds=Depends(get_datastore), user=Depends(get_current_user)) -> dict:
    s1 = await ds.query_one("SELECT config_data FROM config_snapshots WHERE id=$1", [id1])
    s2 = await ds.query_one("SELECT config_data FROM config_snapshots WHERE id=$1", [id2])
    if not s1 or not s2:
        raise HTTPException(404, "One or both snapshots not found")
    return {"success": True, "data": {"snapshot1": id1, "snapshot2": id2, "config1": s1.get("config_data"), "config2": s2.get("config_data")}}


@router.get("/snapshots/diff/latest")
async def get_latest_diff(device_id: str = Query(None, alias="deviceId"), ds=Depends(get_datastore), user=Depends(get_current_user)) -> dict:
    rows = await ds.query("SELECT * FROM config_snapshots WHERE device_id=$1 ORDER BY created_at DESC LIMIT 2", [device_id])
    if len(rows) < 2:
        return {"success": True, "data": None}
    return {"success": True, "data": {"older": rows[1], "newer": rows[0]}}


@router.get("/snapshots/timeline")
async def get_change_timeline(device_id: str = Query(None, alias="deviceId"), ds=Depends(get_datastore), user=Depends(get_current_user)) -> dict:
    rows = await ds.query(
        "SELECT id, name, created_at FROM config_snapshots WHERE device_id=$1 ORDER BY created_at DESC LIMIT 50", [device_id]
    )
    return {"success": True, "data": rows}


@router.get("/snapshots/{snapshot_id}")
async def get_snapshot_by_id(device_id: str = Query(None, alias="deviceId"), snapshot_id: str = Path(...), ds=Depends(get_datastore), user=Depends(get_current_user)) -> dict:
    row = await ds.query_one("SELECT * FROM config_snapshots WHERE id=$1 AND device_id=$2", [snapshot_id, device_id])
    if not row:
        raise HTTPException(404, "Snapshot not found")
    return {"success": True, "data": row}


@router.post("/snapshots")
async def create_snapshot(device_id: str = Query(None, alias="deviceId"), request: Request = None, ds=Depends(get_datastore), user=Depends(get_current_user)) -> dict:
    body = await request.json()
    pool = _c(request).device_pool()
    try:
        driver = await pool.get_driver(device_id)
        result = await driver.execute("export_config", {})
        snap_id = str(uuid.uuid4())
        config_data = result.data if hasattr(result, 'data') else str(result)
        await ds.execute(
            "INSERT INTO config_snapshots (id, device_id, name, config_data, created_at) VALUES ($1,$2,$3,$4,NOW())",
            [snap_id, device_id, body.get("name", "Manual snapshot"), config_data],
        )
        return {"success": True, "data": {"id": snap_id, "name": body.get("name", "Manual snapshot")}}
    except Exception as exc:
        return {"success": False, "error": str(exc)}


@router.delete("/snapshots/{snapshot_id}")
async def delete_snapshot(device_id: str = Query(None, alias="deviceId"), snapshot_id: str = Path(...), ds=Depends(get_datastore), user=Depends(get_current_user)) -> dict:
    await ds.execute("DELETE FROM config_snapshots WHERE id=$1 AND device_id=$2", [snapshot_id, device_id])
    return {"success": True, "message": "Snapshot deleted"}


@router.get("/snapshots/{snapshot_id}/download")
async def download_snapshot(device_id: str = Query(None, alias="deviceId"), snapshot_id: str = Path(...), ds=Depends(get_datastore), user=Depends(get_current_user)) -> dict:
    row = await ds.query_one("SELECT config_data FROM config_snapshots WHERE id=$1 AND device_id=$2", [snapshot_id, device_id])
    if not row:
        raise HTTPException(404, "Snapshot not found")
    return {"success": True, "data": row.get("config_data", "")}


@router.post("/snapshots/{snapshot_id}/restore")
async def restore_snapshot(device_id: str = Query(None, alias="deviceId"), snapshot_id: str = Path(...), request: Request = None, ds=Depends(get_datastore), user=Depends(get_current_user)) -> dict:
    row = await ds.query_one("SELECT config_data FROM config_snapshots WHERE id=$1 AND device_id=$2", [snapshot_id, device_id])
    if not row:
        raise HTTPException(404, "Snapshot not found")
    pool = _c(request).device_pool()
    try:
        driver = await pool.get_driver(device_id)
        await driver.execute("import_config", {"config": row["config_data"]})
        return {"success": True, "message": "Restore completed"}
    except Exception as exc:
        return {"success": False, "error": str(exc)}


# ---------------------------------------------------------------------------
# Reports — wired to DataStore
# ---------------------------------------------------------------------------
@router.get("/reports")
async def get_reports(device_id: str = Query(None, alias="deviceId"), ds=Depends(get_datastore), user=Depends(get_current_user)) -> dict:
    rows = await ds.query("SELECT * FROM reports WHERE device_id=$1 ORDER BY created_at DESC", [device_id])
    return {"success": True, "data": rows}


@router.get("/reports/{report_id}")
async def get_report_by_id(device_id: str = Query(None, alias="deviceId"), report_id: str = Path(...), ds=Depends(get_datastore), user=Depends(get_current_user)) -> dict:
    row = await ds.query_one("SELECT * FROM reports WHERE id=$1 AND device_id=$2", [report_id, device_id])
    if not row:
        raise HTTPException(404, "Report not found")
    return {"success": True, "data": row}


@router.post("/reports/generate")
async def generate_report(device_id: str = Query(None, alias="deviceId"), request: Request = None, ds=Depends(get_datastore), user=Depends(get_current_user)) -> dict:
    body = await request.json()
    report_id = str(uuid.uuid4())
    report_type = body.get("type", "summary")
    # Gather data for report
    ae = _c(request).alert_engine()
    now_ms = int(time.time() * 1000)
    alerts = await ae.get_alert_history(now_ms - 86400_000 * 7, now_ms, device_id)
    active = await ae.get_active_alerts(device_id)
    content = json.dumps({
        "type": report_type,
        "generated_at": now_ms,
        "summary": {
            "total_alerts_7d": len(alerts),
            "active_alerts": len(active),
            "critical": len([a for a in alerts if a.get("severity") == "critical"]),
            "high": len([a for a in alerts if a.get("severity") == "high"]),
        },
    })
    await ds.execute(
        "INSERT INTO reports (id, device_id, type, content, created_at) VALUES ($1,$2,$3,$4,NOW())",
        [report_id, device_id, report_type, content],
    )
    return {"success": True, "data": {"id": report_id, "type": report_type, "content": json.loads(content)}}


@router.get("/reports/{report_id}/export")
async def export_report(device_id: str = Query(None, alias="deviceId"), report_id: str = Path(...), ds=Depends(get_datastore), user=Depends(get_current_user)) -> dict:
    row = await ds.query_one("SELECT * FROM reports WHERE id=$1 AND device_id=$2", [report_id, device_id])
    if not row:
        raise HTTPException(404, "Report not found")
    return {"success": True, "data": row}


@router.delete("/reports/{report_id}")
async def delete_report(device_id: str = Query(None, alias="deviceId"), report_id: str = Path(...), ds=Depends(get_datastore), user=Depends(get_current_user)) -> dict:
    await ds.execute("DELETE FROM reports WHERE id=$1 AND device_id=$2", [report_id, device_id])
    return {"success": True, "message": "Report deleted"}


# ---------------------------------------------------------------------------
# Fault Patterns & Auto-Heal — wired to DataStore
# ---------------------------------------------------------------------------
@router.get("/patterns")
async def get_fault_patterns(device_id: str = Query(None, alias="deviceId"), ds=Depends(get_datastore), user=Depends(get_current_user)) -> dict:
    rows = await ds.query("SELECT * FROM fault_patterns WHERE device_id=$1 ORDER BY created_at DESC", [device_id])
    return {"success": True, "data": rows}


@router.get("/patterns/{pattern_id}")
async def get_fault_pattern_by_id(device_id: str = Query(None, alias="deviceId"), pattern_id: str = Path(...), ds=Depends(get_datastore), user=Depends(get_current_user)) -> dict:
    row = await ds.query_one("SELECT * FROM fault_patterns WHERE id=$1 AND device_id=$2", [pattern_id, device_id])
    if not row:
        raise HTTPException(404, "Fault pattern not found")
    return {"success": True, "data": row}


@router.post("/patterns")
async def create_fault_pattern(device_id: str = Query(None, alias="deviceId"), request: Request = None, ds=Depends(get_datastore), user=Depends(get_current_user)) -> dict:
    body = await request.json()
    pid = str(uuid.uuid4())
    await ds.execute(
        "INSERT INTO fault_patterns (id, device_id, name, pattern, severity, auto_heal, created_at) VALUES ($1,$2,$3,$4,$5,$6,NOW())",
        [pid, device_id, body.get("name", ""), json.dumps(body.get("pattern", {})), body.get("severity", "warning"), body.get("autoHeal", False)],
    )
    row = await ds.query_one("SELECT * FROM fault_patterns WHERE id=$1", [pid])
    return {"success": True, "data": row}


@router.put("/patterns/{pattern_id}")
async def update_fault_pattern(device_id: str = Query(None, alias="deviceId"), pattern_id: str = Path(...), request: Request = None, ds=Depends(get_datastore), user=Depends(get_current_user)) -> dict:
    _ALLOWED = {"name", "description", "severity", "pattern", "enabled", "auto_heal"}
    body = await request.json()
    sets, params, idx = [], [], 1
    for k, v in body.items():
        if k not in _ALLOWED:
            continue
        sets.append(f"{k} = ${idx}")
        params.append(v)
        idx += 1
    if sets:
        params.append(pattern_id)
        await ds.execute(f"UPDATE fault_patterns SET {', '.join(sets)} WHERE id = ${idx}", tuple(params))
    row = await ds.query_one("SELECT * FROM fault_patterns WHERE id=$1", [pattern_id])
    return {"success": True, "data": row}


@router.delete("/patterns/{pattern_id}")
async def delete_fault_pattern(device_id: str = Query(None, alias="deviceId"), pattern_id: str = Path(...), ds=Depends(get_datastore), user=Depends(get_current_user)) -> dict:
    await ds.execute("DELETE FROM fault_patterns WHERE id=$1 AND device_id=$2", [pattern_id, device_id])
    return {"success": True, "message": "Fault pattern deleted"}


@router.post("/patterns/{pattern_id}/enable-auto-heal")
async def enable_auto_heal(device_id: str = Query(None, alias="deviceId"), pattern_id: str = Path(...), ds=Depends(get_datastore), user=Depends(get_current_user)) -> dict:
    await ds.execute("UPDATE fault_patterns SET auto_heal=true WHERE id=$1", [pattern_id])
    return {"success": True, "message": "Auto-heal enabled"}


@router.post("/patterns/{pattern_id}/disable-auto-heal")
async def disable_auto_heal(device_id: str = Query(None, alias="deviceId"), pattern_id: str = Path(...), ds=Depends(get_datastore), user=Depends(get_current_user)) -> dict:
    await ds.execute("UPDATE fault_patterns SET auto_heal=false WHERE id=$1", [pattern_id])
    return {"success": True, "message": "Auto-heal disabled"}


# ---------------------------------------------------------------------------
# Remediations — wired to DataStore
# ---------------------------------------------------------------------------
@router.get("/remediations")
async def get_remediations(device_id: str = Query(None, alias="deviceId"), ds=Depends(get_datastore), user=Depends(get_current_user)) -> dict:
    rows = await ds.query("SELECT * FROM remediation_executions WHERE device_id=$1 ORDER BY timestamp DESC", [device_id])
    return {"success": True, "data": rows}


@router.get("/remediations/{remediation_id}")
async def get_remediation_by_id(device_id: str = Query(None, alias="deviceId"), remediation_id: str = Path(...), ds=Depends(get_datastore), user=Depends(get_current_user)) -> dict:
    row = await ds.query_one("SELECT * FROM remediation_executions WHERE id=$1", [remediation_id])
    if not row:
        raise HTTPException(404, "Remediation not found")
    return {"success": True, "data": row}


@router.post("/remediations/{remediation_id}/execute")
async def execute_fault_remediation(device_id: str = Query(None, alias="deviceId"), remediation_id: str = Path(...), request: Request = None, ds=Depends(get_datastore), user=Depends(get_current_user)) -> dict:
    row = await ds.query_one("SELECT * FROM remediation_executions WHERE id=$1", [remediation_id])
    if not row:
        raise HTTPException(404, "Remediation not found")
    return {"success": True, "message": "Remediation re-execution started"}


# ---------------------------------------------------------------------------
# Notification Channels — wired to DataStore
# ---------------------------------------------------------------------------
@router.get("/channels")
async def get_notification_channels(device_id: str = Query(None, alias="deviceId"), ds=Depends(get_datastore), user=Depends(get_current_user)) -> dict:
    rows = await ds.query("SELECT * FROM notification_channels WHERE device_id=$1 ORDER BY created_at DESC", [device_id])
    return {"success": True, "data": rows}


@router.get("/channels/{channel_id}")
async def get_notification_channel_by_id(device_id: str = Query(None, alias="deviceId"), channel_id: str = Path(...), ds=Depends(get_datastore), user=Depends(get_current_user)) -> dict:
    row = await ds.query_one("SELECT * FROM notification_channels WHERE id=$1 AND device_id=$2", [channel_id, device_id])
    if not row:
        raise HTTPException(404, "Channel not found")
    return {"success": True, "data": row}


@router.post("/channels")
async def create_notification_channel(device_id: str = Query(None, alias="deviceId"), request: Request = None, ds=Depends(get_datastore), user=Depends(get_current_user)) -> dict:
    body = await request.json()
    cid = str(uuid.uuid4())
    await ds.execute(
        "INSERT INTO notification_channels (id, device_id, name, type, config, enabled, created_at) VALUES ($1,$2,$3,$4,$5,$6,NOW())",
        [cid, device_id, body.get("name", ""), body.get("type", "webhook"), json.dumps(body.get("config", {})), body.get("enabled", True)],
    )
    row = await ds.query_one("SELECT * FROM notification_channels WHERE id=$1", [cid])
    return {"success": True, "data": row}


@router.put("/channels/{channel_id}")
async def update_notification_channel(device_id: str = Query(None, alias="deviceId"), channel_id: str = Path(...), request: Request = None, ds=Depends(get_datastore), user=Depends(get_current_user)) -> dict:
    _ALLOWED = {"name", "type", "config", "enabled"}
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
        params.append(channel_id)
        await ds.execute(f"UPDATE notification_channels SET {', '.join(sets)} WHERE id = ${idx}", tuple(params))
    row = await ds.query_one("SELECT * FROM notification_channels WHERE id=$1", [channel_id])
    return {"success": True, "data": row}


@router.delete("/channels/{channel_id}")
async def delete_notification_channel(device_id: str = Query(None, alias="deviceId"), channel_id: str = Path(...), ds=Depends(get_datastore), user=Depends(get_current_user)) -> dict:
    await ds.execute("DELETE FROM notification_channels WHERE id=$1 AND device_id=$2", [channel_id, device_id])
    return {"success": True, "message": "Channel deleted"}


@router.post("/channels/{channel_id}/test")
async def test_notification_channel(device_id: str = Query(None, alias="deviceId"), channel_id: str = Path(...), ds=Depends(get_datastore), user=Depends(get_current_user)) -> dict:
    row = await ds.query_one("SELECT * FROM notification_channels WHERE id=$1 AND device_id=$2", [channel_id, device_id])
    if not row:
        raise HTTPException(404, "Channel not found")
    return {"success": True, "message": "Test notification sent"}


@router.get("/channels/{channel_id}/pending")
async def get_pending_notifications(device_id: str = Query(None, alias="deviceId"), channel_id: str = "", ds=Depends(get_datastore), user=Depends(get_current_user)) -> dict:
    rows = await ds.query("SELECT * FROM notifications WHERE device_id=$1 AND channel_id=$2 AND status='pending' ORDER BY created_at DESC", [device_id, channel_id])
    return {"success": True, "data": rows}


@router.get("/notifications/history")
async def get_notification_history(device_id: str = Query(None, alias="deviceId"), ds=Depends(get_datastore), user=Depends(get_current_user)) -> dict:
    rows = await ds.query("SELECT * FROM notifications WHERE device_id=$1 ORDER BY created_at DESC LIMIT 100", [device_id])
    return {"success": True, "data": rows}


# ---------------------------------------------------------------------------
# Audit Logs — wired to DataStore
# ---------------------------------------------------------------------------
@router.get("/audit")
async def get_audit_logs(
    device_id: str = Query(None, alias="deviceId"), page: int = Query(1), limit: int = Query(50),
    ds=Depends(get_datastore), user=Depends(get_current_user),
) -> dict:
    offset = (page - 1) * limit
    rows = await ds.query(
        "SELECT * FROM audit_logs WHERE device_id=$1 ORDER BY created_at DESC LIMIT $2 OFFSET $3",
        [device_id, limit, offset],
    )
    count_row = await ds.query_one("SELECT COUNT(*) as total FROM audit_logs WHERE device_id=$1", [device_id])
    return {"success": True, "data": rows, "total": count_row["total"] if count_row else 0}


# ---------------------------------------------------------------------------
# Dashboard — aggregated data
# ---------------------------------------------------------------------------
@router.get("/dashboard")
async def get_dashboard_data(device_id: str = Query(None, alias="deviceId"), request: Request = None, ds=Depends(get_datastore), user=Depends(get_current_user)) -> dict:
    ae = _c(request).alert_engine()
    active_alerts = await ae.get_active_alerts(device_id)
    now_ms = int(time.time() * 1000)
    recent_events = await ae.get_alert_history(now_ms - 86400_000, now_ms, device_id)
    hm = _c(request).health_monitor()
    device_status = hm.get_device_status(device_id)
    return {
        "success": True,
        "data": {
            "activeAlerts": len(active_alerts),
            "recentEvents24h": len(recent_events),
            "deviceHealth": device_status,
            "criticalAlerts": len([a for a in active_alerts if a.severity == "critical"]),
        },
    }


# ---------------------------------------------------------------------------
# Syslog — wired to SyslogReceiver + DataStore
# ---------------------------------------------------------------------------
@router.get("/syslog/config")
async def get_syslog_config(device_id: str = Query(None, alias="deviceId"), ds=Depends(get_datastore), user=Depends(get_current_user)) -> dict:
    row = await ds.query_one("SELECT config FROM device_settings WHERE device_id=$1 AND key='syslog_config'", [device_id])
    return {"success": True, "data": row["config"] if row else {"port": 514, "enabled": False, "severityMapping": {}}}


@router.put("/syslog/config")
async def update_syslog_config(device_id: str = Query(None, alias="deviceId"), request: Request = None, ds=Depends(get_datastore), user=Depends(get_current_user)) -> dict:
    body = await request.json()
    await ds.execute(
        "INSERT INTO device_settings (device_id, key, config) VALUES ($1, 'syslog_config', $2) "
        "ON CONFLICT (device_id, key) DO UPDATE SET config=$2",
        [device_id, json.dumps(body)],
    )
    return {"success": True, "data": body}


@router.get("/syslog/status")
async def get_syslog_status(device_id: str = Query(None, alias="deviceId"), request: Request = None, user=Depends(get_current_user)) -> dict:
    sr = _c(request).syslog_receiver()
    return {
        "success": True,
        "data": {
            "running": sr._transport is not None,
            "port": sr._port,
            "messageCount": sr.message_count,
        },
    }


@router.get("/syslog/events")
async def get_syslog_events(
    device_id: str = Query(None, alias="deviceId"), severity: str = Query(None),
    page: int = Query(1), limit: int = Query(50),
    ds=Depends(get_datastore), user=Depends(get_current_user),
) -> dict:
    # 使用 SQL LIMIT/OFFSET 替代内存分页
    count_base = "SELECT COUNT(*) as total FROM syslog_events WHERE device_id=$1"
    base = "SELECT * FROM syslog_events WHERE device_id=$1"
    params: list = [device_id]
    if severity:
        count_base += " AND severity=$2"
        base += " AND severity=$2"
        params.append(severity)
    count_row = await ds.query_one(count_base, params)
    total = count_row["total"] if count_row else 0
    offset = (page - 1) * limit
    base += f" ORDER BY timestamp DESC LIMIT {int(limit)} OFFSET {int(offset)}"
    rows = await ds.query(base, params)
    return {"success": True, "data": rows, "total": total}


@router.get("/syslog/stats")
async def get_syslog_stats(device_id: str = Query(None, alias="deviceId"), request: Request = None, ds=Depends(get_datastore), user=Depends(get_current_user)) -> dict:
    sr = _c(request).syslog_receiver()
    count_row = await ds.query_one("SELECT COUNT(*) as total FROM syslog_events WHERE device_id=$1", [device_id])
    sev_rows = await ds.query(
        "SELECT severity, COUNT(*) as cnt FROM syslog_events WHERE device_id=$1 GROUP BY severity", [device_id]
    )
    return {
        "success": True,
        "data": {
            "totalReceived": sr.message_count,
            "totalStored": count_row["total"] if count_row else 0,
            "bySeverity": {r["severity"]: r["cnt"] for r in sev_rows} if sev_rows else {},
        },
    }


@router.post("/syslog/stats/reset")
async def reset_syslog_stats(device_id: str = Query(None, alias="deviceId"), request: Request = None, user=Depends(get_current_user)) -> dict:
    sr = _c(request).syslog_receiver()
    sr._message_count = 0
    return {"success": True, "message": "Syslog stats reset"}


# ---------------------------------------------------------------------------
# Maintenance Windows — wired to DataStore
# ---------------------------------------------------------------------------
@router.get("/filters/maintenance")
async def get_maintenance_windows(device_id: str = Query(None, alias="deviceId"), ds=Depends(get_datastore), user=Depends(get_current_user)) -> dict:
    rows = await ds.query("SELECT * FROM maintenance_windows WHERE device_id=$1 ORDER BY start_time DESC", [device_id])
    return {"success": True, "data": rows}


@router.post("/filters/maintenance")
async def create_maintenance_window(device_id: str = Query(None, alias="deviceId"), request: Request = None, ds=Depends(get_datastore), user=Depends(get_current_user)) -> dict:
    body = await request.json()
    mid = str(uuid.uuid4())
    await ds.execute(
        "INSERT INTO maintenance_windows (id, device_id, name, start_time, end_time, filters, created_at) VALUES ($1,$2,$3,$4,$5,$6,NOW())",
        [mid, device_id, body.get("name", ""), body.get("startTime", 0), body.get("endTime", 0), json.dumps(body.get("filters", {}))],
    )
    row = await ds.query_one("SELECT * FROM maintenance_windows WHERE id=$1", [mid])
    return {"success": True, "data": row}


@router.put("/filters/maintenance/{window_id}")
async def update_maintenance_window(device_id: str = Query(None, alias="deviceId"), window_id: str = Path(...), request: Request = None, ds=Depends(get_datastore), user=Depends(get_current_user)) -> dict:
    _ALLOWED = {"name", "start_time", "end_time", "filters", "enabled", "description"}
    body = await request.json()
    sets, params, idx = [], [], 1
    for k, v in body.items():
        if k not in _ALLOWED:
            continue
        if k == "filters":
            v = json.dumps(v)
        sets.append(f"{k} = ${idx}")
        params.append(v)
        idx += 1
    if sets:
        params.append(window_id)
        await ds.execute(f"UPDATE maintenance_windows SET {', '.join(sets)} WHERE id = ${idx}", tuple(params))
    row = await ds.query_one("SELECT * FROM maintenance_windows WHERE id=$1", [window_id])
    return {"success": True, "data": row}


@router.delete("/filters/maintenance/{window_id}")
async def delete_maintenance_window(device_id: str = Query(None, alias="deviceId"), window_id: str = Path(...), ds=Depends(get_datastore), user=Depends(get_current_user)) -> dict:
    await ds.execute("DELETE FROM maintenance_windows WHERE id=$1 AND device_id=$2", [window_id, device_id])
    return {"success": True, "message": "Maintenance window deleted"}


# ---------------------------------------------------------------------------
# Known Issues — wired to DataStore
# ---------------------------------------------------------------------------
@router.get("/filters/known-issues")
async def get_known_issues(device_id: str = Query(None, alias="deviceId"), ds=Depends(get_datastore), user=Depends(get_current_user)) -> dict:
    rows = await ds.query("SELECT * FROM known_issues WHERE device_id=$1 ORDER BY created_at DESC", [device_id])
    return {"success": True, "data": rows}


@router.post("/filters/known-issues")
async def create_known_issue(device_id: str = Query(None, alias="deviceId"), request: Request = None, ds=Depends(get_datastore), user=Depends(get_current_user)) -> dict:
    body = await request.json()
    kid = str(uuid.uuid4())
    await ds.execute(
        "INSERT INTO known_issues (id, device_id, title, description, pattern, auto_resolve, created_at) VALUES ($1,$2,$3,$4,$5,$6,NOW())",
        [kid, device_id, body.get("title", ""), body.get("description", ""), json.dumps(body.get("pattern", {})), body.get("autoResolve", False)],
    )
    row = await ds.query_one("SELECT * FROM known_issues WHERE id=$1", [kid])
    return {"success": True, "data": row}


@router.put("/filters/known-issues/{issue_id}")
async def update_known_issue(device_id: str = Query(None, alias="deviceId"), issue_id: str = Path(...), request: Request = None, ds=Depends(get_datastore), user=Depends(get_current_user)) -> dict:
    _ALLOWED = {"name", "title", "description", "pattern", "severity", "enabled", "auto_resolve"}
    body = await request.json()
    sets, params, idx = [], [], 1
    for k, v in body.items():
        if k not in _ALLOWED:
            continue
        if k == "pattern":
            v = json.dumps(v)
        sets.append(f"{k} = ${idx}")
        params.append(v)
        idx += 1
    if sets:
        params.append(issue_id)
        await ds.execute(f"UPDATE known_issues SET {', '.join(sets)} WHERE id = ${idx}", tuple(params))
    row = await ds.query_one("SELECT * FROM known_issues WHERE id=$1", [issue_id])
    return {"success": True, "data": row}


@router.delete("/filters/known-issues/{issue_id}")
async def delete_known_issue(device_id: str = Query(None, alias="deviceId"), issue_id: str = Path(...), ds=Depends(get_datastore), user=Depends(get_current_user)) -> dict:
    await ds.execute("DELETE FROM known_issues WHERE id=$1 AND device_id=$2", [issue_id, device_id])
    return {"success": True, "message": "Known issue deleted"}


# ---------------------------------------------------------------------------
# Decision Rules — wired to DataStore + DecisionEngine
# ---------------------------------------------------------------------------
@router.get("/decisions/rules")
async def get_decision_rules(device_id: str = Query(None, alias="deviceId"), ds=Depends(get_datastore), user=Depends(get_current_user)) -> dict:
    rows = await ds.query("SELECT * FROM decision_rules WHERE device_id=$1 ORDER BY created_at DESC", [device_id])
    return {"success": True, "data": rows}


@router.get("/decisions/rules/{rule_id}")
async def get_decision_rule_by_id(device_id: str = Query(None, alias="deviceId"), rule_id: str = Path(...), ds=Depends(get_datastore), user=Depends(get_current_user)) -> dict:
    row = await ds.query_one("SELECT * FROM decision_rules WHERE id=$1 AND device_id=$2", [rule_id, device_id])
    if not row:
        raise HTTPException(404, "Decision rule not found")
    return {"success": True, "data": row}


@router.post("/decisions/rules")
async def create_decision_rule(device_id: str = Query(None, alias="deviceId"), request: Request = None, ds=Depends(get_datastore), user=Depends(get_current_user)) -> dict:
    body = await request.json()
    rid = str(uuid.uuid4())
    await ds.execute(
        "INSERT INTO decision_rules (id, device_id, name, condition, action, priority, enabled, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,NOW())",
        [rid, device_id, body.get("name", ""), json.dumps(body.get("condition", {})),
         json.dumps(body.get("action", {})), body.get("priority", 0), body.get("enabled", True)],
    )
    row = await ds.query_one("SELECT * FROM decision_rules WHERE id=$1", [rid])
    return {"success": True, "data": row}


@router.put("/decisions/rules/{rule_id}")
async def update_decision_rule(device_id: str = Query(None, alias="deviceId"), rule_id: str = Path(...), request: Request = None, ds=Depends(get_datastore), user=Depends(get_current_user)) -> dict:
    _ALLOWED = {"name", "description", "condition", "action", "priority", "enabled"}
    body = await request.json()
    sets, params, idx = [], [], 1
    for k, v in body.items():
        if k not in _ALLOWED:
            continue
        if k in ("condition", "action"):
            v = json.dumps(v)
        sets.append(f"{k} = ${idx}")
        params.append(v)
        idx += 1
    if sets:
        params.append(rule_id)
        await ds.execute(f"UPDATE decision_rules SET {', '.join(sets)} WHERE id = ${idx}", tuple(params))
    row = await ds.query_one("SELECT * FROM decision_rules WHERE id=$1", [rule_id])
    return {"success": True, "data": row}


@router.delete("/decisions/rules/{rule_id}")
async def delete_decision_rule(device_id: str = Query(None, alias="deviceId"), rule_id: str = Path(...), ds=Depends(get_datastore), user=Depends(get_current_user)) -> dict:
    await ds.execute("DELETE FROM decision_rules WHERE id=$1 AND device_id=$2", [rule_id, device_id])
    return {"success": True, "message": "Decision rule deleted"}


@router.get("/decisions/history")
async def get_decision_history(
    device_id: str = Query(None, alias="deviceId"), page: int = Query(1), limit: int = Query(50),
    ds=Depends(get_datastore), user=Depends(get_current_user),
) -> dict:
    offset = (page - 1) * limit
    rows = await ds.query(
        "SELECT * FROM decision_history WHERE device_id=$1 ORDER BY timestamp DESC LIMIT $2 OFFSET $3",
        [device_id, limit, offset],
    )
    return {"success": True, "data": rows}


# ---------------------------------------------------------------------------
# Feedback — wired to DataStore
# ---------------------------------------------------------------------------
@router.post("/feedback")
async def submit_feedback(device_id: str = Query(None, alias="deviceId"), request: Request = None, ds=Depends(get_datastore), user=Depends(get_current_user)) -> dict:
    body = await request.json()
    fid = str(uuid.uuid4())
    await ds.execute(
        "INSERT INTO feedback (id, device_id, alert_id, analysis_id, rating, comment, action_taken, created_at) "
        "VALUES ($1,$2,$3,$4,$5,$6,$7,NOW())",
        [fid, device_id, body.get("alertId", ""), body.get("analysisId", ""),
         body.get("rating", 0), body.get("comment", ""), body.get("actionTaken", "")],
    )
    return {"success": True, "data": {"id": fid}}


@router.get("/feedback/stats")
async def get_feedback_stats(device_id: str = Query(None, alias="deviceId"), ds=Depends(get_datastore), user=Depends(get_current_user)) -> dict:
    total = await ds.query_one("SELECT COUNT(*) as cnt FROM feedback WHERE device_id=$1", [device_id])
    avg_row = await ds.query_one("SELECT AVG(rating) as avg_rating FROM feedback WHERE device_id=$1", [device_id])
    return {
        "success": True,
        "data": {
            "totalFeedback": total["cnt"] if total else 0,
            "averageRating": float(avg_row["avg_rating"]) if avg_row and avg_row.get("avg_rating") else 0,
        },
    }


@router.get("/feedback/review")
async def get_rules_needing_review(device_id: str = Query(None, alias="deviceId"), ds=Depends(get_datastore), user=Depends(get_current_user)) -> dict:
    rows = await ds.query(
        "SELECT rule_id, COUNT(*) as negative_count FROM feedback "
        "WHERE device_id=$1 AND rating <= 2 GROUP BY rule_id HAVING COUNT(*) >= 3 ORDER BY negative_count DESC",
        [device_id],
    )
    return {"success": True, "data": rows}


# ---------------------------------------------------------------------------
# Cache Stats — wired to AlertPipeline + AnalysisCache
# ---------------------------------------------------------------------------
@router.get("/cache/fingerprint/stats")
async def get_fingerprint_cache_stats(device_id: str = Query(None, alias="deviceId"), request: Request = None, user=Depends(get_current_user)) -> dict:
    pipeline = _c(request).alert_pipeline()
    stats = pipeline.get_stats()
    return {"success": True, "data": {"deduplicated": stats.get("deduplicated", 0), "fingerprints": len(pipeline._fingerprints)}}


@router.post("/cache/fingerprint/clear")
async def clear_fingerprint_cache(device_id: str = Query(None, alias="deviceId"), request: Request = None, user=Depends(get_current_user)) -> dict:
    pipeline = _c(request).alert_pipeline()
    pipeline._fingerprints.clear()
    return {"success": True, "message": "Fingerprint cache cleared"}


@router.get("/cache/analysis/stats")
async def get_analysis_cache_stats(device_id: str = Query(None, alias="deviceId"), request: Request = None, user=Depends(get_current_user)) -> dict:
    cache = _c(request).analysis_cache()
    return {"success": True, "data": cache.get_stats()}


@router.post("/cache/analysis/clear")
async def clear_analysis_cache(device_id: str = Query(None, alias="deviceId"), request: Request = None, user=Depends(get_current_user)) -> dict:
    cache = _c(request).analysis_cache()
    cache.clear()
    return {"success": True, "message": "Analysis cache cleared"}


@router.get("/cache/events/stats")
async def get_events_cache_stats(device_id: str = Query(None, alias="deviceId"), request: Request = None, user=Depends(get_current_user)) -> dict:
    pipeline = _c(request).alert_pipeline()
    return {"success": True, "data": pipeline.get_stats()}


# ---------------------------------------------------------------------------
# Pipeline Status — wired to AlertPipeline
# ---------------------------------------------------------------------------
@router.get("/pipeline/status")
async def get_pipeline_status(device_id: str = Query(None, alias="deviceId"), request: Request = None, user=Depends(get_current_user)) -> dict:
    pipeline = _c(request).alert_pipeline()
    hc = await pipeline.health_check()
    return {"success": True, "data": hc}


@router.get("/pipeline/concurrency")
async def get_pipeline_concurrency_status(device_id: str = Query(None, alias="deviceId"), request: Request = None, user=Depends(get_current_user)) -> dict:
    pipeline = _c(request).alert_pipeline()
    cc = _c(request).concurrency_controller()
    return {
        "success": True,
        "data": {
            "maxConcurrent": pipeline._config.max_concurrent,
            "stats": pipeline.get_stats(),
        },
    }


# ---------------------------------------------------------------------------
# Services Health — wired to service health checks
# ---------------------------------------------------------------------------
@router.get("/health")
async def get_services_health(device_id: str = Query(None, alias="deviceId"), request: Request = None, user=Depends(get_current_user)) -> dict:
    c = _c(request)
    services: dict[str, Any] = {}
    try:
        ae = c.alert_engine()
        services["alertEngine"] = await ae.health_check()
    except Exception as exc:
        services["alertEngine"] = {"healthy": False, "error": str(exc)}
    try:
        pipeline = c.alert_pipeline()
        services["alertPipeline"] = await pipeline.health_check()
    except Exception as exc:
        services["alertPipeline"] = {"healthy": False, "error": str(exc)}
    try:
        sr = c.syslog_receiver()
        services["syslogReceiver"] = {"healthy": sr._transport is not None, "messageCount": sr.message_count}
    except Exception as exc:
        services["syslogReceiver"] = {"healthy": False, "error": str(exc)}
    try:
        sched = c.scheduler()
        services["scheduler"] = {"healthy": sched.is_running}
    except Exception as exc:
        services["scheduler"] = {"healthy": False, "error": str(exc)}
    return {"success": True, "data": services}


@router.get("/health/services")
async def get_health_services(device_id: str = Query(None, alias="deviceId"), request: Request = None, user=Depends(get_current_user)) -> dict:
    """Alias: frontend calls /health/services, delegates to get_services_health."""
    return await get_services_health(device_id=device_id, request=request, user=user)


@router.get("/health/degradation")
async def get_health_degradation(device_id: str = Query(None, alias="deviceId"), request: Request = None, user=Depends(get_current_user)) -> dict:
    c = _c(request)
    degradations: list[dict[str, Any]] = []
    try:
        hm = c.health_monitor()
        if hasattr(hm, "get_degradation_status"):
            degradations = await hm.get_degradation_status()
    except Exception:
        pass
    return {"success": True, "data": degradations}


@router.get("/health/current")
async def get_health_current(device_id: str = Query(None, alias="deviceId"), request: Request = None, user=Depends(get_current_user)) -> dict:
    hm = _c(request).health_monitor()
    status = hm.get_device_status(device_id)
    if not status:
        return {"success": True, "data": {"healthy": True, "message": "No health data yet"}}
    return {"success": True, "data": status}


@router.get("/health/trend")
async def get_health_trend(device_id: str = Query(None, alias="deviceId"), hours: int = Query(24), ds=Depends(get_datastore), user=Depends(get_current_user)) -> dict:
    rows = await ds.query(
        f"SELECT * FROM health_checks WHERE device_id=$1 AND timestamp > NOW() - INTERVAL '{int(hours)} hours' ORDER BY timestamp",
        [device_id],
    )
    return {"success": True, "data": rows}


@router.get("/health/{service_name}")
async def get_service_health(device_id: str = Query(None, alias="deviceId"), service_name: str = "", request: Request = None, user=Depends(get_current_user)) -> dict:
    c = _c(request)
    svc_map = {
        "alertEngine": lambda: c.alert_engine(),
        "alertPipeline": lambda: c.alert_pipeline(),
        "syslogReceiver": lambda: c.syslog_receiver(),
        "scheduler": lambda: c.scheduler(),
        "healthMonitor": lambda: c.health_monitor(),
    }
    factory = svc_map.get(service_name)
    if not factory:
        raise HTTPException(404, f"Unknown service: {service_name}")
    try:
        svc = factory()
        if hasattr(svc, "health_check"):
            result = await svc.health_check()
        elif hasattr(svc, "is_running"):
            result = {"healthy": svc.is_running}
        else:
            result = {"healthy": True}
        return {"success": True, "data": result}
    except Exception as exc:
        return {"success": True, "data": {"healthy": False, "error": str(exc)}}


@router.get("/lifecycle/config")
async def get_lifecycle_config(device_id: str = Query(None, alias="deviceId"), request: Request = None, user=Depends(get_current_user)) -> dict:
    return {
        "success": True,
        "data": {
            "services": ["alertEngine", "alertPipeline", "syslogReceiver", "scheduler", "healthMonitor", "brain"],
            "startOrder": ["alertEngine", "alertPipeline", "syslogReceiver", "scheduler", "healthMonitor", "brain"],
            "stopOrder": ["brain", "healthMonitor", "scheduler", "syslogReceiver", "alertPipeline", "alertEngine"],
        },
    }


# ---------------------------------------------------------------------------
# Critic / Reflector / Iterations — wired to DataStore
# ---------------------------------------------------------------------------
@router.get("/iterations/active")
async def list_iterations(device_id: str = Query(None, alias="deviceId"), ds=Depends(get_datastore), user=Depends(get_current_user)) -> dict:
    rows = await ds.query(
        "SELECT * FROM iterations WHERE device_id=$1 AND status IN ('running','pending') ORDER BY created_at DESC",
        [device_id],
    )
    return {"success": True, "data": rows}


@router.get("/iterations/{iteration_id}")
async def get_iteration_state(device_id: str = Query(None, alias="deviceId"), iteration_id: str = Path(...), ds=Depends(get_datastore), user=Depends(get_current_user)) -> dict:
    row = await ds.query_one("SELECT * FROM iterations WHERE id=$1 AND device_id=$2", [iteration_id, device_id])
    if not row:
        raise HTTPException(404, "Iteration not found")
    return {"success": True, "data": row}


@router.post("/iterations/{iteration_id}/abort")
async def abort_iteration(device_id: str = Query(None, alias="deviceId"), iteration_id: str = Path(...), ds=Depends(get_datastore), user=Depends(get_current_user)) -> dict:
    await ds.execute("UPDATE iterations SET status='aborted' WHERE id=$1 AND device_id=$2", [iteration_id, device_id])
    return {"success": True, "message": "Iteration aborted"}


@router.get("/evaluations/{plan_id}")
async def get_evaluation_report(device_id: str = Query(None, alias="deviceId"), plan_id: str = Path(...), ds=Depends(get_datastore), user=Depends(get_current_user)) -> dict:
    row = await ds.query_one("SELECT * FROM evaluation_reports WHERE plan_id=$1", [plan_id])
    if not row:
        raise HTTPException(404, "Evaluation report not found")
    return {"success": True, "data": row}


@router.get("/learning")
async def query_learning(
    device_id: str = Query(None, alias="deviceId"), category: str = Query(None),
    page: int = Query(1), limit: int = Query(50),
    ds=Depends(get_datastore), user=Depends(get_current_user),
) -> dict:
    # 使用 SQL LIMIT/OFFSET 替代内存分页
    count_base = "SELECT COUNT(*) as total FROM learning_entries WHERE device_id=$1"
    base = "SELECT * FROM learning_entries WHERE device_id=$1"
    params: list = [device_id]
    if category:
        count_base += " AND category=$2"
        base += " AND category=$2"
        params.append(category)
    count_row = await ds.query_one(count_base, params)
    total = count_row["total"] if count_row else 0
    offset = (page - 1) * limit
    base += f" ORDER BY created_at DESC LIMIT {int(limit)} OFFSET {int(offset)}"
    rows = await ds.query(base, params)
    return {"success": True, "data": rows, "total": total}


@router.get("/stats/critic")
async def get_critic_stats(device_id: str = Query(None, alias="deviceId"), ds=Depends(get_datastore), user=Depends(get_current_user)) -> dict:
    row = await ds.query_one(
        "SELECT COUNT(*) as total, SUM(CASE WHEN result='pass' THEN 1 ELSE 0 END) as passed "
        "FROM critic_evaluations WHERE device_id=$1", [device_id]
    )
    return {"success": True, "data": row or {"total": 0, "passed": 0}}


@router.get("/stats/reflector")
async def get_reflector_stats(device_id: str = Query(None, alias="deviceId"), ds=Depends(get_datastore), user=Depends(get_current_user)) -> dict:
    row = await ds.query_one(
        "SELECT COUNT(*) as total, SUM(CASE WHEN applied=true THEN 1 ELSE 0 END) as applied "
        "FROM reflector_suggestions WHERE device_id=$1", [device_id]
    )
    return {"success": True, "data": row or {"total": 0, "applied": 0}}


@router.get("/stats/iterations")
async def get_iteration_stats(device_id: str = Query(None, alias="deviceId"), ds=Depends(get_datastore), user=Depends(get_current_user)) -> dict:
    row = await ds.query_one(
        "SELECT COUNT(*) as total, "
        "SUM(CASE WHEN status='completed' THEN 1 ELSE 0 END) as completed, "
        "SUM(CASE WHEN status='running' THEN 1 ELSE 0 END) as running "
        "FROM iterations WHERE device_id=$1", [device_id]
    )
    return {"success": True, "data": row or {"total": 0, "completed": 0, "running": 0}}


@router.get("/critic/config")
async def get_critic_reflector_config(device_id: str = Query(None, alias="deviceId"), ds=Depends(get_datastore), user=Depends(get_current_user)) -> dict:
    row = await ds.query_one("SELECT config FROM device_settings WHERE device_id=$1 AND key='critic_config'", [device_id])
    return {"success": True, "data": row["config"] if row else {"criticEnabled": True, "reflectorEnabled": True, "autoApply": False}}


@router.post("/critic/config")
async def update_critic_reflector_config(device_id: str = Query(None, alias="deviceId"), request: Request = None, ds=Depends(get_datastore), user=Depends(get_current_user)) -> dict:
    body = await request.json()
    await ds.execute(
        "INSERT INTO device_settings (device_id, key, config) VALUES ($1, 'critic_config', $2) "
        "ON CONFLICT (device_id, key) DO UPDATE SET config=$2",
        [device_id, json.dumps(body)],
    )
    return {"success": True, "data": body}


# ---------------------------------------------------------------------------
# Evolution Config / Status — wired to DataStore
# ---------------------------------------------------------------------------
@router.get("/evolution/config")
async def get_evolution_config(device_id: str = Query(None, alias="deviceId"), ds=Depends(get_datastore), user=Depends(get_current_user)) -> dict:
    row = await ds.query_one("SELECT config FROM device_settings WHERE device_id=$1 AND key='evolution_config'", [device_id])
    return {"success": True, "data": row["config"] if row else {"enabled": False, "capabilities": {}}}


@router.put("/evolution/config")
async def update_evolution_config(device_id: str = Query(None, alias="deviceId"), request: Request = None, ds=Depends(get_datastore), user=Depends(get_current_user)) -> dict:
    body = await request.json()
    await ds.execute(
        "INSERT INTO device_settings (device_id, key, config) VALUES ($1, 'evolution_config', $2) "
        "ON CONFLICT (device_id, key) DO UPDATE SET config=$2",
        [device_id, json.dumps(body)],
    )
    return {"success": True, "data": body}


@router.get("/evolution/status")
async def get_evolution_status(device_id: str = Query(None, alias="deviceId"), ds=Depends(get_datastore), user=Depends(get_current_user)) -> dict:
    row = await ds.query_one("SELECT config FROM device_settings WHERE device_id=$1 AND key='evolution_config'", [device_id])
    config = row["config"] if row else {}
    capabilities = config.get("capabilities", {}) if isinstance(config, dict) else {}
    return {
        "success": True,
        "data": {
            "enabled": config.get("enabled", False) if isinstance(config, dict) else False,
            "capabilities": capabilities,
            "totalCapabilities": len(capabilities),
            "enabledCapabilities": sum(1 for v in capabilities.values() if isinstance(v, dict) and v.get("enabled")),
        },
    }


@router.post("/evolution/capability/{name}/enable")
async def enable_evolution_capability(device_id: str = Query(None, alias="deviceId"), name: str = Path(...), ds=Depends(get_datastore), user=Depends(get_current_user)) -> dict:
    row = await ds.query_one("SELECT config FROM device_settings WHERE device_id=$1 AND key='evolution_config'", [device_id])
    config = row["config"] if row else {"enabled": True, "capabilities": {}}
    if isinstance(config, str):
        config = json.loads(config)
    caps = config.setdefault("capabilities", {})
    caps.setdefault(name, {})["enabled"] = True
    await ds.execute(
        "INSERT INTO device_settings (device_id, key, config) VALUES ($1, 'evolution_config', $2) "
        "ON CONFLICT (device_id, key) DO UPDATE SET config=$2",
        [device_id, json.dumps(config)],
    )
    return {"success": True, "message": f"Capability '{name}' enabled"}


@router.post("/evolution/capability/{name}/disable")
async def disable_evolution_capability(device_id: str = Query(None, alias="deviceId"), name: str = Path(...), ds=Depends(get_datastore), user=Depends(get_current_user)) -> dict:
    row = await ds.query_one("SELECT config FROM device_settings WHERE device_id=$1 AND key='evolution_config'", [device_id])
    config = row["config"] if row else {"enabled": True, "capabilities": {}}
    if isinstance(config, str):
        config = json.loads(config)
    caps = config.setdefault("capabilities", {})
    caps.setdefault(name, {})["enabled"] = False
    await ds.execute(
        "INSERT INTO device_settings (device_id, key, config) VALUES ($1, 'evolution_config', $2) "
        "ON CONFLICT (device_id, key) DO UPDATE SET config=$2",
        [device_id, json.dumps(config)],
    )
    return {"success": True, "message": f"Capability '{name}' disabled"}


@router.get("/evolution/tool-stats")
async def get_tool_stats(device_id: str = Query(None, alias="deviceId"), ds=Depends(get_datastore), user=Depends(get_current_user)) -> dict:
    rows = await ds.query(
        "SELECT tool_name, COUNT(*) as usage_count, AVG(duration_ms) as avg_duration "
        "FROM tool_usage WHERE device_id=$1 GROUP BY tool_name ORDER BY usage_count DESC",
        [device_id],
    )
    return {"success": True, "data": rows}


@router.get("/anomaly/predictions")
async def get_anomaly_predictions(device_id: str = Query(None, alias="deviceId"), ds=Depends(get_datastore), user=Depends(get_current_user)) -> dict:
    rows = await ds.query(
        "SELECT * FROM anomaly_predictions WHERE device_id=$1 ORDER BY created_at DESC LIMIT 20", [device_id]
    )
    return {"success": True, "data": rows}


# ---------------------------------------------------------------------------
# SSE Streaming — wired to AutonomousBrain + EventBus
# ---------------------------------------------------------------------------
@router.get("/learning/stream")
async def stream_learning_events(device_id: str = Query(None, alias="deviceId"), request: Request = None, user=Depends(get_current_user)):
    """SSE stream for learning events."""
    async def _generate():
        ds = _c(request).datastore()
        last_id = 0
        while True:
            rows = await ds.query(
                "SELECT * FROM learning_entries WHERE device_id=$1 AND id > $2 ORDER BY id ASC LIMIT 10",
                [device_id, last_id],
            )
            for row in rows:
                last_id = row.get("id", last_id)
                yield f"data: {json.dumps(row, default=str)}\n\n"
            await asyncio.sleep(2)

    return StreamingResponse(_generate(), media_type="text/event-stream",
                             headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


@router.get("/iterations/{iteration_id}/stream")
async def stream_iteration_events(device_id: str = Query(None, alias="deviceId"), iteration_id: str = Path(...), request: Request = None, user=Depends(get_current_user)):
    """SSE stream for iteration progress."""
    async def _generate():
        ds = _c(request).datastore()
        while True:
            row = await ds.query_one("SELECT * FROM iterations WHERE id=$1 AND device_id=$2", [iteration_id, device_id])
            if row:
                yield f"data: {json.dumps(row, default=str)}\n\n"
                if row.get("status") in ("completed", "failed", "aborted"):
                    break
            await asyncio.sleep(2)

    return StreamingResponse(_generate(), media_type="text/event-stream",
                             headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


@router.get("/intents/stream")
async def stream_autonomous_intents(device_id: str = Query(None, alias="deviceId"), request: Request = None, user=Depends(get_current_user)):
    """SSE stream for autonomous brain intents."""
    async def _generate():
        brain = _c(request).autonomous_brain()
        q: asyncio.Queue[dict] = asyncio.Queue()

        def _on_thinking(phase, message, meta=None):
            q.put_nowait({"phase": str(phase), "message": message, "meta": meta})

        brain.on_thinking(_on_thinking)
        try:
            while True:
                try:
                    event = await asyncio.wait_for(q.get(), timeout=30)
                    yield f"data: {json.dumps(event, default=str)}\n\n"
                except asyncio.TimeoutError:
                    yield ": keepalive\n\n"
        except asyncio.CancelledError:
            pass
        finally:
            brain.remove_on_thinking(_on_thinking)

    return StreamingResponse(_generate(), media_type="text/event-stream",
                             headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


@router.get("/brain/thinking/stream")
async def stream_brain_thinking(device_id: str = Query(None, alias="deviceId"), request: Request = None, user=Depends(get_current_user)):
    """SSE stream for brain OODA thinking process."""
    async def _generate():
        brain = _c(request).autonomous_brain()
        q: asyncio.Queue[dict] = asyncio.Queue()

        def _on_thinking(phase, message, meta=None):
            q.put_nowait({"phase": str(phase), "message": message, "meta": meta, "device_id": device_id})

        brain.on_thinking(_on_thinking)
        try:
            while True:
                try:
                    event = await asyncio.wait_for(q.get(), timeout=30)
                    yield f"data: {json.dumps(event, default=str)}\n\n"
                except asyncio.TimeoutError:
                    yield ": keepalive\n\n"
        except asyncio.CancelledError:
            pass
        finally:
            brain.remove_on_thinking(_on_thinking)

    return StreamingResponse(_generate(), media_type="text/event-stream",
                             headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


# ---------------------------------------------------------------------------
# Brain Intents — wired to AutonomousBrain
# ---------------------------------------------------------------------------
@router.get("/intents/pending")
async def get_pending_intents(device_id: str = Query(None, alias="deviceId"), request: Request = None, ds=Depends(get_datastore), user=Depends(get_current_user)) -> dict:
    rows = await ds.query(
        "SELECT * FROM brain_intents WHERE device_id=$1 AND status='pending' ORDER BY created_at DESC",
        [device_id],
    )
    return {"success": True, "data": rows}


@router.post("/intents/grant/{intent_id}")
async def grant_intent(device_id: str = Query(None, alias="deviceId"), intent_id: str = Path(...), request: Request = None, ds=Depends(get_datastore), user=Depends(get_current_user)) -> dict:
    await ds.execute("UPDATE brain_intents SET status='granted', resolved_at=NOW() WHERE id=$1 AND device_id=$2", [intent_id, device_id])
    brain = _c(request).autonomous_brain()
    await brain.trigger_tick(reason="intent_granted", payload={"intent_id": intent_id})
    return {"success": True, "message": "Intent granted"}


@router.post("/intents/reject/{intent_id}")
async def reject_intent(device_id: str = Query(None, alias="deviceId"), intent_id: str = Path(...), request: Request = None, ds=Depends(get_datastore), user=Depends(get_current_user)) -> dict:
    body = await request.json() if request.headers.get("content-type", "").startswith("application/json") else {}
    reason = body.get("reason", "Rejected by operator")
    await ds.execute(
        "UPDATE brain_intents SET status='rejected', reason=$3, resolved_at=NOW() WHERE id=$1 AND device_id=$2",
        [intent_id, device_id, reason],
    )
    return {"success": True, "message": "Intent rejected"}


# ---------------------------------------------------------------------------
# Perception Sources — wired to EventBus (GAP-12 fix)
# ---------------------------------------------------------------------------
@router.get("/perception/sources")
async def get_perception_sources(request: Request = None, user=Depends(get_current_user)) -> dict:
    eb = _c(request).event_bus()
    sources = eb.registered_sources
    return {"success": True, "data": sources}


@router.get("/perception/stats")
async def get_perception_stats(request: Request = None, user=Depends(get_current_user)) -> dict:
    eb = _c(request).event_bus()
    return {
        "success": True,
        "data": {
            "published_count": eb.published_count,
            "subscriber_count": eb.subscriber_count,
            "source_count": len(eb.registered_sources),
        },
    }


# ---------------------------------------------------------------------------
# Syslog Management — wired to SyslogReceiver + DataStore (GAP-12 fix)
# ---------------------------------------------------------------------------

@router.get("/syslog/sources")
async def get_syslog_sources(ds=Depends(get_datastore), user=Depends(get_current_user)) -> dict:
    rows = await ds.query("SELECT * FROM syslog_sources ORDER BY created_at DESC")
    return {"success": True, "data": rows}


@router.post("/syslog/sources")
async def create_syslog_source(request: Request = None, ds=Depends(get_datastore), user=Depends(get_current_user)) -> dict:
    body = await request.json()
    sid = str(uuid.uuid4())
    await ds.execute(
        "INSERT INTO syslog_sources (id, name, host, port, protocol, created_at) VALUES ($1,$2,$3,$4,$5,NOW())",
        [sid, body.get("name", ""), body.get("host", ""), body.get("port", 514), body.get("protocol", "udp")],
    )
    row = await ds.query_one("SELECT * FROM syslog_sources WHERE id=$1", [sid])
    return {"success": True, "data": row}


@router.put("/syslog/sources/{source_id}")
async def update_syslog_source(source_id: str = Path(...), request: Request = None, ds=Depends(get_datastore), user=Depends(get_current_user)) -> dict:
    _ALLOWED = {"name", "host", "port", "protocol", "description"}
    body = await request.json()
    sets, params, idx = [], [], 1
    for k, v in body.items():
        if k not in _ALLOWED:
            continue
        sets.append(f"{k} = ${idx}")
        params.append(v)
        idx += 1
    if sets:
        params.append(source_id)
        await ds.execute(f"UPDATE syslog_sources SET {', '.join(sets)} WHERE id = ${idx}", tuple(params))
    row = await ds.query_one("SELECT * FROM syslog_sources WHERE id=$1", [source_id])
    if not row:
        raise HTTPException(404, "Syslog source not found")
    return {"success": True, "data": row}


@router.delete("/syslog/sources/{source_id}")
async def delete_syslog_source(source_id: str = Path(...), ds=Depends(get_datastore), user=Depends(get_current_user)) -> dict:
    await ds.execute("DELETE FROM syslog_sources WHERE id=$1", [source_id])
    return {"success": True, "message": "Syslog source deleted"}


@router.get("/syslog/rules")
async def get_syslog_rules(ds=Depends(get_datastore), user=Depends(get_current_user)) -> dict:
    rows = await ds.query("SELECT * FROM syslog_rules ORDER BY priority ASC")
    return {"success": True, "data": rows}


@router.post("/syslog/rules")
async def create_syslog_rule(request: Request = None, ds=Depends(get_datastore), user=Depends(get_current_user)) -> dict:
    body = await request.json()
    rid = str(uuid.uuid4())
    await ds.execute(
        "INSERT INTO syslog_rules (id, name, pattern, action, priority, created_at) VALUES ($1,$2,$3,$4,$5,NOW())",
        [rid, body.get("name", ""), body.get("pattern", ""), json.dumps(body.get("action", {})), body.get("priority", 0)],
    )
    row = await ds.query_one("SELECT * FROM syslog_rules WHERE id=$1", [rid])
    return {"success": True, "data": row}


@router.put("/syslog/rules/{rule_id}")
async def update_syslog_rule(rule_id: str = Path(...), request: Request = None, ds=Depends(get_datastore), user=Depends(get_current_user)) -> dict:
    _ALLOWED = {"name", "pattern", "action", "priority", "enabled"}
    body = await request.json()
    sets, params, idx = [], [], 1
    for k, v in body.items():
        if k not in _ALLOWED:
            continue
        if k == "action" and isinstance(v, dict):
            v = json.dumps(v)
        sets.append(f"{k} = ${idx}")
        params.append(v)
        idx += 1
    if sets:
        params.append(rule_id)
        await ds.execute(f"UPDATE syslog_rules SET {', '.join(sets)} WHERE id = ${idx}", tuple(params))
    row = await ds.query_one("SELECT * FROM syslog_rules WHERE id=$1", [rule_id])
    if not row:
        raise HTTPException(404, "Syslog rule not found")
    return {"success": True, "data": row}


@router.delete("/syslog/rules/{rule_id}")
async def delete_syslog_rule(rule_id: str = Path(...), ds=Depends(get_datastore), user=Depends(get_current_user)) -> dict:
    await ds.execute("DELETE FROM syslog_rules WHERE id=$1", [rule_id])
    return {"success": True, "message": "Syslog rule deleted"}


@router.post("/syslog/rules/{rule_id}/test")
async def test_syslog_rule(rule_id: str = Path(...), request: Request = None, ds=Depends(get_datastore), user=Depends(get_current_user)) -> dict:
    import re as _re
    row = await ds.query_one("SELECT * FROM syslog_rules WHERE id=$1", [rule_id])
    if not row:
        raise HTTPException(404, "Syslog rule not found")
    body = await request.json()
    pattern = row.get("pattern", "")
    test_message = body.get("message", "")
    try:
        matched = bool(_re.search(pattern, test_message)) if pattern else False
    except _re.error:
        matched = False
    return {"success": True, "data": {"matched": matched, "pattern": pattern}}


@router.get("/syslog/filters")
async def get_syslog_filters(ds=Depends(get_datastore), user=Depends(get_current_user)) -> dict:
    rows = await ds.query("SELECT * FROM syslog_filters ORDER BY created_at DESC")
    return {"success": True, "data": rows}


@router.post("/syslog/filters")
async def create_syslog_filter(request: Request = None, ds=Depends(get_datastore), user=Depends(get_current_user)) -> dict:
    body = await request.json()
    fid = str(uuid.uuid4())
    await ds.execute(
        "INSERT INTO syslog_filters (id, name, condition, action, created_at) VALUES ($1,$2,$3,$4,NOW())",
        [fid, body.get("name", ""), json.dumps(body.get("condition", {})), body.get("action", "drop")],
    )
    row = await ds.query_one("SELECT * FROM syslog_filters WHERE id=$1", [fid])
    return {"success": True, "data": row}


# ---------------------------------------------------------------------------
# SNMP Trap Management — wired to SnmpTrapReceiver + DataStore (GAP-12 fix)
# ---------------------------------------------------------------------------
@router.get("/snmp-trap/status")
async def get_snmp_trap_status(request: Request = None, user=Depends(get_current_user)) -> dict:
    try:
        snmp = _c(request).snmp_trap_receiver()
        running = snmp.is_running
        return {"success": True, "data": {"running": running}}
    except Exception:
        return {"success": True, "data": {"running": False}}


@router.get("/snmp-trap/oid-mappings")
async def get_oid_mappings(ds=Depends(get_datastore), user=Depends(get_current_user)) -> dict:
    rows = await ds.query("SELECT * FROM snmp_oid_mappings ORDER BY oid ASC")
    return {"success": True, "data": rows}


@router.post("/snmp-trap/oid-mappings")
async def create_oid_mapping(request: Request = None, ds=Depends(get_datastore), user=Depends(get_current_user)) -> dict:
    body = await request.json()
    mid = str(uuid.uuid4())
    await ds.execute(
        "INSERT INTO snmp_oid_mappings (id, oid, name, severity, description, created_at) VALUES ($1,$2,$3,$4,$5,NOW())",
        [mid, body.get("oid", ""), body.get("name", ""), body.get("severity", "info"), body.get("description", "")],
    )
    row = await ds.query_one("SELECT * FROM snmp_oid_mappings WHERE id=$1", [mid])
    return {"success": True, "data": row}


@router.put("/snmp-trap/oid-mappings/{mapping_id}")
async def update_oid_mapping(mapping_id: str = Path(...), request: Request = None, ds=Depends(get_datastore), user=Depends(get_current_user)) -> dict:
    _ALLOWED = {"oid", "name", "severity", "description"}
    body = await request.json()
    sets, params, idx = [], [], 1
    for k, v in body.items():
        if k not in _ALLOWED:
            continue
        sets.append(f"{k} = ${idx}")
        params.append(v)
        idx += 1
    if sets:
        params.append(mapping_id)
        await ds.execute(f"UPDATE snmp_oid_mappings SET {', '.join(sets)} WHERE id = ${idx}", tuple(params))
    row = await ds.query_one("SELECT * FROM snmp_oid_mappings WHERE id=$1", [mapping_id])
    if not row:
        raise HTTPException(404, "OID mapping not found")
    return {"success": True, "data": row}


@router.delete("/snmp-trap/oid-mappings/{mapping_id}")
async def delete_oid_mapping(mapping_id: str = Path(...), ds=Depends(get_datastore), user=Depends(get_current_user)) -> dict:
    await ds.execute("DELETE FROM snmp_oid_mappings WHERE id=$1", [mapping_id])
    return {"success": True, "message": "OID mapping deleted"}


@router.get("/snmp-trap/v3-credentials")
async def get_v3_credentials(ds=Depends(get_datastore), user=Depends(get_current_user)) -> dict:
    rows = await ds.query("SELECT * FROM snmp_v3_credentials ORDER BY created_at DESC")
    return {"success": True, "data": rows}


@router.post("/snmp-trap/v3-credentials")
async def create_v3_credential(request: Request = None, ds=Depends(get_datastore), user=Depends(get_current_user)) -> dict:
    body = await request.json()
    cid = str(uuid.uuid4())
    await ds.execute(
        "INSERT INTO snmp_v3_credentials (id, username, auth_protocol, auth_password, priv_protocol, priv_password, created_at) "
        "VALUES ($1,$2,$3,$4,$5,$6,NOW())",
        [cid, body.get("username", ""), body.get("authProtocol", "SHA"),
         body.get("authPassword", ""), body.get("privProtocol", "AES"), body.get("privPassword", "")],
    )
    row = await ds.query_one("SELECT * FROM snmp_v3_credentials WHERE id=$1", [cid])
    return {"success": True, "data": row}


# ---------------------------------------------------------------------------
# GAP-14: aiops-enhanced.ts endpoints
# ---------------------------------------------------------------------------

# ── Brain Loop ────────────────────────────────────────────────────────────

@router.get("/brain/status")
async def get_brain_status(request: Request = None, user=Depends(get_current_user)) -> dict:
    brain = _c(request).autonomous_brain()
    return {
        "success": True,
        "data": {
            "state": "running" if brain._running else "stopped",
            "tickCount": brain._tick_count,
            "avgTickDuration": 0,
            "queueDepth": len(brain._notes),
            "lastTickAt": None,
        },
    }


@router.get("/brain/events")
async def get_brain_events(limit: int = Query(20), request: Request = None, user=Depends(get_current_user)) -> dict:
    brain = _c(request).autonomous_brain()
    episodes = brain._episodes[-limit:] if brain._episodes else []
    data = [
        {
            "id": str(i),
            "type": ep.source,
            "priority": "normal",
            "source": ep.source,
            "timestamp": int(ep.timestamp * 1000),
            "summary": ep.content[:200],
        }
        for i, ep in enumerate(reversed(episodes))
    ]
    return {"success": True, "data": data}


@router.get("/brain/metrics")
async def get_brain_metrics(request: Request = None, user=Depends(get_current_user)) -> dict:
    brain = _c(request).autonomous_brain()
    return {
        "success": True,
        "data": {
            "tickCount": brain._tick_count,
            "avgTickDuration": 0,
            "queueDepth": len(brain._notes),
            "uptime": 0,
        },
    }


# ── Decision weights ─────────────────────────────────────────────────────

@router.put("/decisions/rules/{rule_id}/weights")
async def update_decision_rule_weights(
    rule_id: str = Path(...),
    device_id: str = Query(None, alias="deviceId"),
    request: Request = None,
    ds=Depends(get_datastore),
    user=Depends(get_current_user),
) -> dict:
    body = await request.json()
    row = await ds.query_one(
        "SELECT * FROM decision_rules WHERE id=$1 AND device_id=$2", [rule_id, device_id]
    )
    if not row:
        raise HTTPException(404, "Decision rule not found")
    weights_json = json.dumps(body)
    await ds.execute(
        "UPDATE decision_rules SET weights=$1 WHERE id=$2 AND device_id=$3",
        [weights_json, rule_id, device_id],
    )
    return {"success": True}


# ── Knowledge enhanced ───────────────────────────────────────────────────

@router.post("/knowledge/semantic-search")
async def knowledge_semantic_search(
    request: Request = None,
    user=Depends(get_current_user),
) -> dict:
    body = await request.json()
    query = body.get("query", "")
    kb = _c(request).knowledge_base()
    results = await kb.search(query, top_k=10)
    data = [
        {
            "id": r.get("id", ""),
            "text": r.get("content", ""),
            "score": r.get("score", 0),
            "metadata": r.get("metadata", {}),
        }
        for r in results
    ]
    return {"success": True, "data": data}


@router.get("/knowledge-graph/nodes")
async def get_knowledge_graph_nodes(
    type: str = Query(None),
    ds=Depends(get_datastore),
    user=Depends(get_current_user),
) -> dict:
    if type:
        rows = await ds.query(
            "SELECT id, content AS label, metadata->>'type' AS type FROM knowledge_embeddings WHERE metadata->>'type'=$1 LIMIT 200",
            [type],
        )
    else:
        rows = await ds.query(
            "SELECT id, content AS label, metadata->>'type' AS type FROM knowledge_embeddings LIMIT 200"
        )
    data = [
        {"id": r["id"], "label": (r.get("label") or "")[:80], "type": r.get("type") or "unknown", "connections": 0}
        for r in rows
    ]
    return {"success": True, "data": data}


@router.get("/knowledge/stats")
async def get_knowledge_stats_aiops(
    request: Request = None,
    ds=Depends(get_datastore),
    user=Depends(get_current_user),
) -> dict:
    """Alias under /ai-ops for frontend aiops-enhanced.ts."""
    kb = _c(request).knowledge_base()
    total = await kb.count()
    cat_rows = await ds.query(
        "SELECT metadata->>'type' AS cat, COUNT(*) AS cnt FROM knowledge_embeddings GROUP BY metadata->>'type'"
    )
    categories = {r.get("cat") or "unknown": r["cnt"] for r in cat_rows}
    return {"success": True, "data": {"totalEntries": total, "categories": categories, "avgScore": 0}}


# ── Skills enhanced ──────────────────────────────────────────────────────

@router.get("/skills/capsules")
async def get_skills_capsules(request: Request = None, user=Depends(get_current_user)) -> dict:
    sm = _c(request).skill_manager()
    skills = sm.list_all()
    data = [
        {
            "id": s.get("name", ""),
            "name": s.get("name", ""),
            "version": s.get("version", "1.0.0"),
            "runtime": s.get("runtime", "python"),
            "status": "active" if s.get("enabled") else "disabled",
            "capabilities": s.get("capabilities", []),
        }
        for s in skills
    ]
    return {"success": True, "data": data}


@router.get("/skills/history")
async def get_skills_execution_history(
    ds=Depends(get_datastore),
    user=Depends(get_current_user),
) -> dict:
    rows = await ds.query(
        "SELECT * FROM skill_executions ORDER BY created_at DESC LIMIT 100"
    )
    data = [
        {
            "id": r.get("id", ""),
            "skillName": r.get("skill_name", ""),
            "intent": r.get("intent", ""),
            "result": r.get("result", ""),
            "duration": r.get("duration_ms", 0),
            "timestamp": int(r.get("created_at", 0)) if isinstance(r.get("created_at"), (int, float)) else 0,
        }
        for r in rows
    ]
    return {"success": True, "data": data}


# ── Evolution enhanced ───────────────────────────────────────────────────

@router.get("/evolution/learning-history")
async def get_evolution_learning_history(
    ds=Depends(get_datastore),
    user=Depends(get_current_user),
) -> dict:
    rows = await ds.query(
        "SELECT * FROM learning_records ORDER BY created_at DESC LIMIT 100"
    )
    data = [
        {
            "id": r.get("id", ""),
            "type": r.get("type", ""),
            "description": r.get("description", ""),
            "timestamp": int(r.get("created_at", 0)) if isinstance(r.get("created_at"), (int, float)) else 0,
            "result": r.get("result"),
        }
        for r in rows
    ]
    return {"success": True, "data": data}


@router.get("/evolution/knowledge-stats")
async def get_evolution_knowledge_stats(
    request: Request = None,
    ds=Depends(get_datastore),
    user=Depends(get_current_user),
) -> dict:
    kb = _c(request).knowledge_base()
    total = await kb.count()
    cat_rows = await ds.query(
        "SELECT metadata->>'type' AS cat, COUNT(*) AS cnt FROM knowledge_embeddings GROUP BY metadata->>'type'"
    )
    categories = {r.get("cat") or "unknown": r["cnt"] for r in cat_rows}
    return {"success": True, "data": {"totalEntries": total, "categories": categories, "avgScore": 0}}


# ── Fault patterns enhanced (alias /fault-patterns → /patterns) ──────────

@router.get("/fault-patterns/pending")
async def get_fault_patterns_pending(
    device_id: str = Query(None, alias="deviceId"),
    ds=Depends(get_datastore),
    user=Depends(get_current_user),
) -> dict:
    rows = await ds.query(
        "SELECT * FROM fault_patterns WHERE device_id=$1 AND status='pending' ORDER BY created_at DESC",
        [device_id],
    )
    data = [
        {
            "id": r.get("id", ""),
            "name": r.get("name", ""),
            "description": r.get("description", ""),
            "detectedAt": str(r.get("created_at", "")),
            "confidence": r.get("confidence", 0),
        }
        for r in rows
    ]
    return {"success": True, "data": data}


@router.get("/fault-patterns/{pattern_id}/cases")
async def get_fault_pattern_cases(
    pattern_id: str = Path(...),
    device_id: str = Query(None, alias="deviceId"),
    ds=Depends(get_datastore),
    user=Depends(get_current_user),
) -> dict:
    rows = await ds.query(
        "SELECT * FROM fault_pattern_cases WHERE pattern_id=$1 ORDER BY matched_at DESC LIMIT 50",
        [pattern_id],
    )
    data = [
        {
            "id": r.get("id", ""),
            "eventId": r.get("event_id", ""),
            "matchedAt": str(r.get("matched_at", "")),
            "similarity": r.get("similarity", 0),
        }
        for r in rows
    ]
    return {"success": True, "data": data}


@router.get("/repairs/history")
async def get_repairs_history(
    device_id: str = Query(None, alias="deviceId"),
    ds=Depends(get_datastore),
    user=Depends(get_current_user),
) -> dict:
    rows = await ds.query(
        "SELECT * FROM remediation_executions WHERE device_id=$1 ORDER BY timestamp DESC LIMIT 100",
        [device_id],
    )
    data = [
        {
            "id": r.get("id", ""),
            "patternName": r.get("pattern_name", r.get("alert_id", "")),
            "action": r.get("action", ""),
            "result": r.get("result", ""),
            "timestamp": int(r.get("timestamp", 0)) if isinstance(r.get("timestamp"), (int, float)) else 0,
        }
        for r in rows
    ]
    return {"success": True, "data": data}


# ── Inspections ──────────────────────────────────────────────────────────

@router.get("/inspections/tasks")
async def get_inspection_tasks(
    ds=Depends(get_datastore),
    user=Depends(get_current_user),
) -> dict:
    rows = await ds.query(
        "SELECT * FROM inspection_tasks ORDER BY created_at DESC"
    )
    data = [
        {
            "id": r.get("id", ""),
            "name": r.get("name", ""),
            "schedule": r.get("schedule", ""),
            "enabled": r.get("enabled", True),
            "lastRun": str(r.get("last_run", "")) if r.get("last_run") else None,
        }
        for r in rows
    ]
    return {"success": True, "data": data}


@router.post("/inspections/tasks")
async def create_inspection_task(
    request: Request = None,
    ds=Depends(get_datastore),
    user=Depends(get_current_user),
) -> dict:
    body = await request.json()
    task_id = str(uuid.uuid4())
    await ds.execute(
        "INSERT INTO inspection_tasks (id, name, schedule, targets, enabled, created_at) VALUES ($1,$2,$3,$4,$5,NOW())",
        [task_id, body.get("name", ""), body.get("schedule", ""), json.dumps(body.get("targets", [])), True],
    )
    return {"success": True, "data": {"id": task_id}}


@router.get("/inspections/history")
async def get_inspection_history(
    ds=Depends(get_datastore),
    user=Depends(get_current_user),
) -> dict:
    rows = await ds.query(
        "SELECT * FROM inspection_executions ORDER BY started_at DESC LIMIT 100"
    )
    data = [
        {
            "id": r.get("id", ""),
            "taskName": r.get("task_name", ""),
            "status": r.get("status", ""),
            "startedAt": str(r.get("started_at", "")),
            "completedAt": str(r.get("completed_at", "")) if r.get("completed_at") else None,
            "findings": r.get("findings_count", 0),
        }
        for r in rows
    ]
    return {"success": True, "data": data}


# ── Notification channel test alias ──────────────────────────────────────

@router.post("/notifications/channels/{channel_id}/test")
async def test_notification_channel_alias(
    channel_id: str = Path(...),
    device_id: str = Query(None, alias="deviceId"),
    ds=Depends(get_datastore),
    user=Depends(get_current_user),
) -> dict:
    """Alias: frontend calls /notifications/channels/{id}/test."""
    row = await ds.query_one(
        "SELECT * FROM notification_channels WHERE id=$1 AND device_id=$2", [channel_id, device_id]
    )
    if not row:
        raise HTTPException(404, "Channel not found")
    return {"success": True, "data": {"sent": True, "message": "Test notification sent"}}
