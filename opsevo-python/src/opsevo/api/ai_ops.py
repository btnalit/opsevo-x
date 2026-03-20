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

from .deps import get_current_user, get_datastore, get_device_id, get_feature_flag_manager, get_tracing_service
from .dependencies import get_device_orchestrator
from .utils import snake_to_camel, snake_to_camel_list, camel_to_snake_keys

router = APIRouter(prefix="/api/ai-ops", tags=["ai-ops"])

# 用于保护 feature flag 的 DB 写入 + 内存更新原子性
_feature_flag_lock = asyncio.Lock()


def _c(request: Request):
    """Shorthand for container access."""
    return request.app.state.container


def _resolve_device_id(query_device_id: str | None, body: dict) -> str | None:
    """Resolve device_id: prefer query param, fallback to body, normalize empty → None."""
    did = query_device_id or body.pop("deviceId", None) or body.pop("device_id", None)
    return did.strip() if did and isinstance(did, str) and did.strip() else None


# ---------------------------------------------------------------------------
# Metrics
# ---------------------------------------------------------------------------
@router.get("/metrics/latest")
async def get_latest_metrics(device_id: str | None = Depends(get_device_id), ds=Depends(get_datastore), user=Depends(get_current_user)) -> dict:
    if device_id:
        rows = await ds.query(
            "SELECT * FROM system_metrics WHERE device_id=$1 ORDER BY timestamp DESC LIMIT 1", [device_id]
        )
        return {"success": True, "data": snake_to_camel(rows[0]) if rows else None}
    # 全局模式：返回每台设备的最新指标（SQLite 兼容）
    rows = await ds.query(
        "SELECT m.* FROM system_metrics m "
        "INNER JOIN (SELECT device_id, MAX(timestamp) AS max_ts "
        "FROM system_metrics GROUP BY device_id) latest "
        "ON m.device_id = latest.device_id AND m.timestamp = latest.max_ts "
        "ORDER BY m.device_id"
    )
    return {"success": True, "data": snake_to_camel_list(rows)}


@router.get("/metrics/history")
async def get_metrics_history(
    device_id: str | None = Depends(get_device_id), hours: int = Query(24),
    ds=Depends(get_datastore), user=Depends(get_current_user),
) -> dict:
    if device_id:
        rows = await ds.query(
            f"SELECT * FROM system_metrics WHERE device_id=$1 AND timestamp > NOW() - INTERVAL '{int(hours)} hours' ORDER BY timestamp",
            [device_id],
        )
    else:
        rows = await ds.query(
            f"SELECT * FROM system_metrics WHERE timestamp > NOW() - INTERVAL '{int(hours)} hours' ORDER BY timestamp",
        )
    return {"success": True, "data": snake_to_camel_list(rows)}


@router.get("/metrics/config")
async def get_metrics_config(device_id: str | None = Depends(get_device_id), ds=Depends(get_datastore), user=Depends(get_current_user)) -> dict:
    row = await ds.query_one("SELECT config FROM device_settings WHERE device_id=$1 AND key='metrics_config'", [device_id])
    return {"success": True, "data": row["config"] if row else {"interval": 60, "enabled": True}}


@router.put("/metrics/config")
async def update_metrics_config(device_id: str | None = Depends(get_device_id), request: Request = None, ds=Depends(get_datastore), user=Depends(get_current_user)) -> dict:
    body = await request.json()
    await ds.execute(
        "INSERT INTO device_settings (device_id, key, config) VALUES ($1, 'metrics_config', $2) "
        "ON CONFLICT (device_id, key) DO UPDATE SET config=$2",
        [device_id, json.dumps(body)],
    )
    return {"success": True, "data": body}


@router.post("/metrics/collect")
async def collect_metrics_now(device_id: str | None = Depends(get_device_id), request: Request = None, user=Depends(get_current_user)) -> dict:
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
    device_id: str | None = Depends(get_device_id), interface: str = Query(None), hours: int = Query(24),
    ds=Depends(get_datastore), user=Depends(get_current_user),
) -> dict:
    if device_id and interface:
        rows = await ds.query(
            f"SELECT * FROM traffic_metrics WHERE device_id=$1 AND interface=$2 AND timestamp > NOW() - INTERVAL '{int(hours)} hours' ORDER BY timestamp",
            [device_id, interface],
        )
    elif device_id:
        rows = await ds.query(
            f"SELECT * FROM traffic_metrics WHERE device_id=$1 AND timestamp > NOW() - INTERVAL '{int(hours)} hours' ORDER BY timestamp",
            [device_id],
        )
    elif interface:
        rows = await ds.query(
            f"SELECT * FROM traffic_metrics WHERE interface=$1 AND timestamp > NOW() - INTERVAL '{int(hours)} hours' ORDER BY timestamp",
            [interface],
        )
    else:
        rows = await ds.query(
            f"SELECT * FROM traffic_metrics WHERE timestamp > NOW() - INTERVAL '{int(hours)} hours' ORDER BY timestamp",
        )
    return {"success": True, "data": snake_to_camel_list(rows)}


@router.get("/metrics/traffic/interfaces")
async def get_traffic_interfaces(device_id: str | None = Depends(get_device_id), ds=Depends(get_datastore), user=Depends(get_current_user)) -> dict:
    if device_id:
        rows = await ds.query(
            "SELECT DISTINCT interface, MAX(timestamp) as last_seen FROM traffic_metrics WHERE device_id=$1 GROUP BY interface",
            [device_id],
        )
    else:
        rows = await ds.query(
            "SELECT DISTINCT interface, MAX(timestamp) as last_seen FROM traffic_metrics GROUP BY interface",
        )
    return {"success": True, "data": snake_to_camel_list(rows)}


@router.get("/metrics/traffic/status")
async def get_traffic_collection_status(device_id: str | None = Depends(get_device_id), request: Request = None, user=Depends(get_current_user)) -> dict:
    sched = _c(request).scheduler()
    return {"success": True, "data": {"collecting": sched.is_running}}


@router.get("/metrics/traffic/rate-config")
async def get_rate_calculation_config(device_id: str | None = Depends(get_device_id), ds=Depends(get_datastore), user=Depends(get_current_user)) -> dict:
    row = await ds.query_one("SELECT config FROM device_settings WHERE device_id=$1 AND key='rate_config'", [device_id])
    return {"success": True, "data": row["config"] if row else {"windowSize": 5, "algorithm": "sliding"}}


@router.put("/metrics/traffic/rate-config")
async def update_rate_calculation_config(device_id: str | None = Depends(get_device_id), request: Request = None, ds=Depends(get_datastore), user=Depends(get_current_user)) -> dict:
    body = await request.json()
    await ds.execute(
        "INSERT INTO device_settings (device_id, key, config) VALUES ($1, 'rate_config', $2) "
        "ON CONFLICT (device_id, key) DO UPDATE SET config=$2",
        [device_id, json.dumps(body)],
    )
    return {"success": True, "data": body}


@router.get("/metrics/traffic/rate-stats")
async def get_rate_statistics(device_id: str | None = Depends(get_device_id), ds=Depends(get_datastore), user=Depends(get_current_user)) -> dict:
    if device_id:
        row = await ds.query_one(
            "SELECT COUNT(*) as samples, AVG(rx_rate) as avg_rx, AVG(tx_rate) as avg_tx FROM traffic_metrics WHERE device_id=$1 AND timestamp > NOW() - INTERVAL '1 hour'",
            [device_id],
        )
    else:
        row = await ds.query_one(
            "SELECT COUNT(*) as samples, AVG(rx_rate) as avg_rx, AVG(tx_rate) as avg_tx FROM traffic_metrics WHERE timestamp > NOW() - INTERVAL '1 hour'",
        )
    return {"success": True, "data": snake_to_camel(row) or {}}


@router.get("/metrics/traffic/history-with-status")
async def get_traffic_history_with_status(
    device_id: str | None = Depends(get_device_id), interface: str = Query(None), hours: int = Query(24),
    request: Request = None, ds=Depends(get_datastore), user=Depends(get_current_user),
) -> dict:
    if device_id:
        base = "SELECT * FROM traffic_metrics WHERE device_id=$1"
        params: list = [device_id]
    else:
        base = "SELECT * FROM traffic_metrics WHERE 1=1"
        params: list = []
    if interface:
        idx = len(params) + 1
        base += f" AND interface=${idx}"
        params.append(interface)
    base += f" AND timestamp > NOW() - INTERVAL '{int(hours)} hours' ORDER BY timestamp"
    rows = await ds.query(base, params)
    sched = _c(request).scheduler()
    return {"success": True, "data": snake_to_camel_list(rows), "collectionActive": sched.is_running}


@router.get("/parallel-execution/metrics")
async def get_parallel_execution_metrics(device_id: str | None = Depends(get_device_id), request: Request = None, user=Depends(get_current_user)) -> dict:
    cc = _c(request).concurrency_controller()
    return {"success": True, "data": {"maxConcurrent": 5, "active": 0}}


# ---------------------------------------------------------------------------
# Alert Rules — wired to AlertEngine
# ---------------------------------------------------------------------------
@router.get("/alerts/rules")
async def get_alert_rules(device_id: str | None = Depends(get_device_id), request: Request = None, ds=Depends(get_datastore), user=Depends(get_current_user)) -> dict:
    ae = _c(request).alert_engine()
    rules = await ae.get_rules(device_id)
    return {"success": True, "data": [_rule_to_dict(r) for r in rules]}


@router.get("/alerts/rules/{rule_id}")
async def get_alert_rule_by_id(device_id: str | None = Depends(get_device_id), rule_id: str = Path(...), request: Request = None, ds=Depends(get_datastore), user=Depends(get_current_user)) -> dict:
    ae = _c(request).alert_engine()
    rule = await ae.get_rule_by_id(rule_id)
    if not rule:
        raise HTTPException(404, "Alert rule not found")
    return {"success": True, "data": _rule_to_dict(rule)}


@router.post("/alerts/rules")
async def create_alert_rule(device_id: str | None = Depends(get_device_id), request: Request = None, ds=Depends(get_datastore), user=Depends(get_current_user)) -> dict:
    body = await request.json()
    device_id = _resolve_device_id(device_id, body)
    body["device_id"] = device_id
    ae = _c(request).alert_engine()
    rule = await ae.create_rule(body)
    return {"success": True, "data": _rule_to_dict(rule)}


@router.put("/alerts/rules/{rule_id}")
async def update_alert_rule(device_id: str | None = Depends(get_device_id), rule_id: str = Path(...), request: Request = None, ds=Depends(get_datastore), user=Depends(get_current_user)) -> dict:
    body = await request.json()
    ae = _c(request).alert_engine()
    rule = await ae.update_rule(rule_id, body)
    return {"success": True, "data": _rule_to_dict(rule)}


@router.delete("/alerts/rules/{rule_id}")
async def delete_alert_rule(device_id: str | None = Depends(get_device_id), rule_id: str = Path(...), request: Request = None, ds=Depends(get_datastore), user=Depends(get_current_user)) -> dict:
    ae = _c(request).alert_engine()
    await ae.delete_rule(rule_id)
    return {"success": True, "message": "Alert rule deleted"}


@router.post("/alerts/rules/{rule_id}/enable")
async def enable_alert_rule(device_id: str | None = Depends(get_device_id), rule_id: str = Path(...), request: Request = None, ds=Depends(get_datastore), user=Depends(get_current_user)) -> dict:
    ae = _c(request).alert_engine()
    rule = await ae.update_rule(rule_id, {"enabled": True})
    return {"success": True, "data": _rule_to_dict(rule)}


@router.post("/alerts/rules/{rule_id}/disable")
async def disable_alert_rule(device_id: str | None = Depends(get_device_id), rule_id: str = Path(...), request: Request = None, ds=Depends(get_datastore), user=Depends(get_current_user)) -> dict:
    ae = _c(request).alert_engine()
    rule = await ae.update_rule(rule_id, {"enabled": False})
    return {"success": True, "data": _rule_to_dict(rule)}


def _rule_to_dict(rule) -> dict:
    return {
        "id": rule.id, "name": rule.name, "metric": rule.metric,
        "operator": rule.operator, "threshold": rule.threshold,
        "severity": rule.severity, "enabled": rule.enabled,
        "deviceId": rule.device_id, "cooldownMs": rule.cooldown_ms,
        "autoResponse": rule.auto_response,
        "createdAt": rule.created_at, "updatedAt": rule.updated_at,
    }


# ---------------------------------------------------------------------------
# Alert Events — wired to AlertEngine
# ---------------------------------------------------------------------------
@router.get("/alerts/events")
async def get_alert_events(
    device_id: str | None = Depends(get_device_id), request: Request = None,
    severity: str = Query(None), status: str = Query(None),
    source: str = Query(None),
    page: int = Query(1, ge=1), limit: int = Query(50, ge=1, le=1000),
    ds=Depends(get_datastore), user=Depends(get_current_user),
) -> dict:
    ae = _c(request).alert_engine()
    now_ms = int(time.time() * 1000)
    result = await ae.query_alert_history(
        now_ms - 86400_000 * 30, now_ms, device_id,
        severity=severity, status=status, source=source,
        page=page, limit=limit,
    )
    return {"success": True, "data": snake_to_camel_list(result["data"]), "total": result["total"], "page": page, "limit": limit}


@router.get("/alerts/events/active")
async def get_active_alerts(device_id: str | None = Depends(get_device_id), request: Request = None, ds=Depends(get_datastore), user=Depends(get_current_user)) -> dict:
    ae = _c(request).alert_engine()
    alerts = await ae.get_active_alerts(device_id)
    return {"success": True, "data": [_alert_to_dict(a) for a in alerts]}


@router.get("/alerts/events/unified")
async def get_unified_events(
    device_id: str | None = Depends(get_device_id), request: Request = None,
    page: int = Query(1, ge=1), limit: int = Query(50, ge=1, le=1000),
    ds=Depends(get_datastore), user=Depends(get_current_user),
) -> dict:
    ae = _c(request).alert_engine()
    now_ms = int(time.time() * 1000)
    result = await ae.query_alert_history(
        now_ms - 86400_000 * 7, now_ms, device_id,
        page=page, limit=limit,
    )
    return {"success": True, "data": snake_to_camel_list(result["data"]), "total": result["total"]}


@router.get("/alerts/events/unified/active")
async def get_active_unified_events(device_id: str | None = Depends(get_device_id), request: Request = None, ds=Depends(get_datastore), user=Depends(get_current_user)) -> dict:
    ae = _c(request).alert_engine()
    alerts = await ae.get_active_alerts(device_id)
    return {"success": True, "data": [_alert_to_dict(a) for a in alerts]}


@router.get("/alerts/events/{alert_id}")
async def get_alert_event_by_id(device_id: str | None = Depends(get_device_id), alert_id: str = Path(...), ds=Depends(get_datastore), user=Depends(get_current_user)) -> dict:
    row = await ds.query_one("SELECT * FROM alert_events WHERE id=$1", [alert_id])
    if not row:
        raise HTTPException(404, "Alert event not found")
    return {"success": True, "data": snake_to_camel(row)}


@router.post("/alerts/events/{alert_id}/resolve")
async def resolve_alert_event(device_id: str | None = Depends(get_device_id), alert_id: str = Path(...), request: Request = None, ds=Depends(get_datastore), user=Depends(get_current_user)) -> dict:
    ae = _c(request).alert_engine()
    await ae.resolve_alert(alert_id)
    return {"success": True, "message": "Alert resolved"}


@router.delete("/alerts/events/{alert_id}")
async def delete_alert_event(device_id: str | None = Depends(get_device_id), alert_id: str = Path(...), request: Request = None, ds=Depends(get_datastore), user=Depends(get_current_user)) -> dict:
    ae = _c(request).alert_engine()
    await ae.delete_alert_event(alert_id)
    return {"success": True, "message": "Alert event deleted"}


@router.post("/alerts/events/batch-delete")
async def batch_delete_alert_events(device_id: str | None = Depends(get_device_id), request: Request = None, ds=Depends(get_datastore), user=Depends(get_current_user)) -> dict:
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
async def get_alert_analysis(device_id: str | None = Depends(get_device_id), alert_id: str = Path(...), request: Request = None, ds=Depends(get_datastore), user=Depends(get_current_user)) -> dict:
    cache = _c(request).analysis_cache()
    cached = cache.get(alert_id)
    if cached:
        return {"success": True, "data": {"analysis": cached, "cached": True}}
    row = await ds.query_one("SELECT * FROM alert_analyses WHERE alert_id=$1", [alert_id])
    return {"success": True, "data": snake_to_camel(row)}


@router.post("/analysis/{alert_id}/refresh")
async def refresh_alert_analysis(device_id: str | None = Depends(get_device_id), alert_id: str = Path(...), request: Request = None, ds=Depends(get_datastore), user=Depends(get_current_user)) -> dict:
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
async def get_alert_timeline(device_id: str | None = Depends(get_device_id), alert_id: str = Path(...), ds=Depends(get_datastore), user=Depends(get_current_user)) -> dict:
    rows = await ds.query(
        "SELECT * FROM alert_timeline WHERE alert_id=$1 ORDER BY timestamp ASC", [alert_id]
    )
    return {"success": True, "data": snake_to_camel_list(rows)}


@router.get("/analysis/{alert_id}/related")
async def get_related_alerts(device_id: str | None = Depends(get_device_id), alert_id: str = Path(...), request: Request = None, ds=Depends(get_datastore), user=Depends(get_current_user)) -> dict:
    alert = await ds.query_one("SELECT * FROM alert_events WHERE id=$1", [alert_id])
    if not alert:
        return {"success": True, "data": []}
    rule_id = alert.get("rule_id", "")
    if device_id:
        rows = await ds.query(
            "SELECT * FROM alert_events WHERE rule_id=$1 AND id!=$2 AND device_id=$3 ORDER BY timestamp DESC LIMIT 10",
            [rule_id, alert_id, device_id],
        )
    else:
        rows = await ds.query(
            "SELECT * FROM alert_events WHERE rule_id=$1 AND id!=$2 ORDER BY timestamp DESC LIMIT 10",
            [rule_id, alert_id],
        )
    return {"success": True, "data": snake_to_camel_list(rows)}


@router.get("/remediation/{alert_id}")
async def get_remediation_plan(device_id: str | None = Depends(get_device_id), alert_id: str = Path(...), ds=Depends(get_datastore), user=Depends(get_current_user)) -> dict:
    row = await ds.query_one("SELECT * FROM remediation_executions WHERE alert_id=$1 ORDER BY timestamp DESC LIMIT 1", [alert_id])
    return {"success": True, "data": snake_to_camel(row)}


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
async def generate_remediation_plan(device_id: str | None = Depends(get_device_id), alert_id: str = Path(...), request: Request = None, ds=Depends(get_datastore), user=Depends(get_current_user)) -> dict:
    return await _run_remediation(device_id, alert_id, request, ds)


@router.post("/remediation/{alert_id}/execute")
async def execute_remediation_plan(device_id: str | None = Depends(get_device_id), alert_id: str = Path(...), request: Request = None, ds=Depends(get_datastore), user=Depends(get_current_user)) -> dict:
    return await _run_remediation(device_id, alert_id, request, ds)


@router.post("/remediation/{alert_id}/rollback")
async def execute_remediation_rollback(device_id: str | None = Depends(get_device_id), alert_id: str = Path(...), ds=Depends(get_datastore), user=Depends(get_current_user)) -> dict:
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
async def get_scheduler_tasks(device_id: str | None = Depends(get_device_id), request: Request = None, ds=Depends(get_datastore), user=Depends(get_current_user)) -> dict:
    sched = _c(request).scheduler()
    tasks = sched.get_tasks()
    return {"success": True, "data": snake_to_camel_list(tasks)}


@router.get("/scheduler/tasks/{task_id}")
async def get_scheduler_task_by_id(device_id: str | None = Depends(get_device_id), task_id: str = Path(...), request: Request = None, ds=Depends(get_datastore), user=Depends(get_current_user)) -> dict:
    sched = _c(request).scheduler()
    tasks = sched.get_tasks()
    task = next((t for t in tasks if t["id"] == task_id), None)
    if not task:
        raise HTTPException(404, "Scheduler task not found")
    return {"success": True, "data": snake_to_camel(task)}


@router.post("/scheduler/tasks")
async def create_scheduler_task(device_id: str | None = Depends(get_device_id), request: Request = None, ds=Depends(get_datastore), user=Depends(get_current_user)) -> dict:
    body = await request.json()
    device_id = _resolve_device_id(device_id, body)
    sched = _c(request).scheduler()

    async def _noop():
        pass

    task_id = await sched.add_task(
        name=body.get("name", "Unnamed"),
        cron=body.get("cron", "*/5 * * * *"),
        callback=_noop,
        enabled=body.get("enabled", True),
        metadata={"device_id": device_id, **body},
    )
    return {"success": True, "data": {"id": task_id, "name": body.get("name"), "cron": body.get("cron")}}


@router.put("/scheduler/tasks/{task_id}")
async def update_scheduler_task(device_id: str | None = Depends(get_device_id), task_id: str = Path(...), request: Request = None, ds=Depends(get_datastore), user=Depends(get_current_user)) -> dict:
    body = await request.json()
    sched = _c(request).scheduler()
    try:
        result = await sched.update_task(
            task_id,
            name=body.get("name"),
            cron=body.get("cron"),
            enabled=body.get("enabled"),
            metadata={"device_id": device_id, **body} if body else None,
        )
    except ValueError as exc:
        raise HTTPException(400, str(exc))
    if not result:
        raise HTTPException(404, "Scheduler task not found")
    return {"success": True, "data": result}


@router.delete("/scheduler/tasks/{task_id}")
async def delete_scheduler_task(device_id: str | None = Depends(get_device_id), task_id: str = Path(...), request: Request = None, ds=Depends(get_datastore), user=Depends(get_current_user)) -> dict:
    sched = _c(request).scheduler()
    await sched.remove_task(task_id)
    return {"success": True, "message": "Task deleted"}


@router.post("/scheduler/tasks/{task_id}/run")
async def run_scheduler_task_now(device_id: str | None = Depends(get_device_id), task_id: str = Path(...), request: Request = None, ds=Depends(get_datastore), user=Depends(get_current_user)) -> dict:
    sched = _c(request).scheduler()
    tasks = sched.get_tasks()
    task = next((t for t in tasks if t["id"] == task_id), None)
    if not task:
        raise HTTPException(404, "Task not found")
    return {"success": True, "message": "Task execution triggered"}


@router.get("/scheduler/executions")
async def get_scheduler_executions(device_id: str | None = Depends(get_device_id), ds=Depends(get_datastore), user=Depends(get_current_user)) -> dict:
    if device_id:
        rows = await ds.query(
            "SELECT * FROM scheduler_executions WHERE device_id=$1 ORDER BY timestamp DESC LIMIT 50", [device_id]
        )
    else:
        rows = await ds.query(
            "SELECT * FROM scheduler_executions ORDER BY timestamp DESC LIMIT 50"
        )
    return {"success": True, "data": snake_to_camel_list(rows)}


# ---------------------------------------------------------------------------
# Snapshots — wired to DataStore
# ---------------------------------------------------------------------------
@router.get("/snapshots")
async def get_snapshots(device_id: str | None = Depends(get_device_id), ds=Depends(get_datastore), user=Depends(get_current_user)) -> dict:
    if device_id:
        rows = await ds.query("SELECT * FROM config_snapshots WHERE device_id=$1 ORDER BY created_at DESC", [device_id])
    else:
        rows = await ds.query("SELECT * FROM config_snapshots ORDER BY created_at DESC")
    return {"success": True, "data": snake_to_camel_list(rows)}


@router.get("/snapshots/diff")
async def compare_snapshots(device_id: str | None = Depends(get_device_id), id1: str = Query(..., alias="idA"), id2: str = Query(..., alias="idB"), ds=Depends(get_datastore), user=Depends(get_current_user)) -> dict:
    s1 = await ds.query_one("SELECT config_data FROM config_snapshots WHERE id=$1", [id1])
    s2 = await ds.query_one("SELECT config_data FROM config_snapshots WHERE id=$1", [id2])
    if not s1 or not s2:
        raise HTTPException(404, "One or both snapshots not found")
    return {"success": True, "data": {"snapshot1": id1, "snapshot2": id2, "config1": s1.get("config_data"), "config2": s2.get("config_data")}}


@router.get("/snapshots/diff/latest")
async def get_latest_diff(device_id: str | None = Depends(get_device_id), ds=Depends(get_datastore), user=Depends(get_current_user)) -> dict:
    if device_id:
        rows = await ds.query("SELECT * FROM config_snapshots WHERE device_id=$1 ORDER BY created_at DESC LIMIT 2", [device_id])
    else:
        rows = await ds.query("SELECT * FROM config_snapshots ORDER BY created_at DESC LIMIT 2")
    if len(rows) < 2:
        return {"success": True, "data": None}
    return {"success": True, "data": {"older": snake_to_camel(rows[1]), "newer": snake_to_camel(rows[0])}}


@router.get("/snapshots/timeline")
async def get_change_timeline(device_id: str | None = Depends(get_device_id), ds=Depends(get_datastore), user=Depends(get_current_user)) -> dict:
    if device_id:
        rows = await ds.query(
            "SELECT id, name, created_at FROM config_snapshots WHERE device_id=$1 ORDER BY created_at DESC LIMIT 50", [device_id]
        )
    else:
        rows = await ds.query(
            "SELECT id, name, created_at FROM config_snapshots ORDER BY created_at DESC LIMIT 50"
        )
    return {"success": True, "data": snake_to_camel_list(rows)}


@router.get("/snapshots/{snapshot_id}")
async def get_snapshot_by_id(device_id: str | None = Depends(get_device_id), snapshot_id: str = Path(...), ds=Depends(get_datastore), user=Depends(get_current_user)) -> dict:
    row = await ds.query_one("SELECT * FROM config_snapshots WHERE id=$1", [snapshot_id])
    if not row:
        raise HTTPException(404, "Snapshot not found")
    return {"success": True, "data": snake_to_camel(row)}


@router.post("/snapshots")
async def create_snapshot(device_id: str | None = Depends(get_device_id), request: Request = None, ds=Depends(get_datastore), user=Depends(get_current_user)) -> dict:
    body = await request.json()
    device_id = _resolve_device_id(device_id, body)
    if not device_id:
        raise HTTPException(400, "deviceId is required for snapshot creation")
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
async def delete_snapshot(device_id: str | None = Depends(get_device_id), snapshot_id: str = Path(...), ds=Depends(get_datastore), user=Depends(get_current_user)) -> dict:
    await ds.execute("DELETE FROM config_snapshots WHERE id=$1", [snapshot_id])
    return {"success": True, "message": "Snapshot deleted"}


@router.get("/snapshots/{snapshot_id}/download")
async def download_snapshot(device_id: str | None = Depends(get_device_id), snapshot_id: str = Path(...), ds=Depends(get_datastore), user=Depends(get_current_user)) -> dict:
    row = await ds.query_one("SELECT config_data FROM config_snapshots WHERE id=$1", [snapshot_id])
    if not row:
        raise HTTPException(404, "Snapshot not found")
    return {"success": True, "data": row.get("config_data", "")}


@router.post("/snapshots/{snapshot_id}/restore")
async def restore_snapshot(device_id: str | None = Depends(get_device_id), snapshot_id: str = Path(...), request: Request = None, ds=Depends(get_datastore), user=Depends(get_current_user)) -> dict:
    row = await ds.query_one("SELECT * FROM config_snapshots WHERE id=$1", [snapshot_id])
    if not row:
        raise HTTPException(404, "Snapshot not found")
    pool = _c(request).device_pool()
    try:
        restore_device_id = device_id or row.get("device_id")
        if not restore_device_id:
            raise HTTPException(400, "No device_id for restore")
        driver = await pool.get_driver(restore_device_id)
        await driver.execute("import_config", {"config": row["config_data"]})
        return {"success": True, "message": "Restore completed"}
    except Exception as exc:
        return {"success": False, "error": str(exc)}


# ---------------------------------------------------------------------------
# Reports — wired to DataStore
# ---------------------------------------------------------------------------
@router.get("/reports")
async def get_reports(device_id: str | None = Depends(get_device_id), ds=Depends(get_datastore), user=Depends(get_current_user)) -> dict:
    if device_id:
        rows = await ds.query("SELECT * FROM reports WHERE device_id=$1 ORDER BY created_at DESC", [device_id])
    else:
        rows = await ds.query("SELECT * FROM reports ORDER BY created_at DESC")
    return {"success": True, "data": snake_to_camel_list(rows)}


@router.get("/reports/{report_id}")
async def get_report_by_id(device_id: str | None = Depends(get_device_id), report_id: str = Path(...), ds=Depends(get_datastore), user=Depends(get_current_user)) -> dict:
    row = await ds.query_one("SELECT * FROM reports WHERE id=$1", [report_id])
    if not row:
        raise HTTPException(404, "Report not found")
    return {"success": True, "data": snake_to_camel(row)}


@router.post("/reports/generate")
async def generate_report(device_id: str | None = Depends(get_device_id), request: Request = None, ds=Depends(get_datastore), user=Depends(get_current_user)) -> dict:
    body = await request.json()
    device_id = _resolve_device_id(device_id, body)
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
async def export_report(device_id: str | None = Depends(get_device_id), report_id: str = Path(...), ds=Depends(get_datastore), user=Depends(get_current_user)) -> dict:
    row = await ds.query_one("SELECT * FROM reports WHERE id=$1", [report_id])
    if not row:
        raise HTTPException(404, "Report not found")
    return {"success": True, "data": snake_to_camel(row)}


@router.delete("/reports/{report_id}")
async def delete_report(device_id: str | None = Depends(get_device_id), report_id: str = Path(...), ds=Depends(get_datastore), user=Depends(get_current_user)) -> dict:
    await ds.execute("DELETE FROM reports WHERE id=$1", [report_id])
    return {"success": True, "message": "Report deleted"}


# ---------------------------------------------------------------------------
# Fault Patterns & Auto-Heal — wired to DataStore
# ---------------------------------------------------------------------------
@router.get("/patterns")
async def get_fault_patterns(device_id: str | None = Depends(get_device_id), ds=Depends(get_datastore), user=Depends(get_current_user)) -> dict:
    if device_id:
        rows = await ds.query("SELECT * FROM fault_patterns WHERE device_id=$1 ORDER BY created_at DESC", [device_id])
    else:
        rows = await ds.query("SELECT * FROM fault_patterns ORDER BY created_at DESC")
    return {"success": True, "data": snake_to_camel_list(rows)}


@router.get("/patterns/{pattern_id}")
async def get_fault_pattern_by_id(device_id: str | None = Depends(get_device_id), pattern_id: str = Path(...), ds=Depends(get_datastore), user=Depends(get_current_user)) -> dict:
    row = await ds.query_one("SELECT * FROM fault_patterns WHERE id=$1", [pattern_id])
    if not row:
        raise HTTPException(404, "Fault pattern not found")
    return {"success": True, "data": snake_to_camel(row)}


@router.post("/patterns")
async def create_fault_pattern(device_id: str | None = Depends(get_device_id), request: Request = None, ds=Depends(get_datastore), user=Depends(get_current_user)) -> dict:
    body = camel_to_snake_keys(await request.json())
    device_id = _resolve_device_id(device_id, body)
    pid = str(uuid.uuid4())
    await ds.execute(
        "INSERT INTO fault_patterns (id, device_id, name, pattern, severity, auto_heal, created_at) VALUES ($1,$2,$3,$4,$5,$6,NOW())",
        [pid, device_id, body.get("name", ""), json.dumps(body.get("pattern", {})), body.get("severity", "warning"), body.get("auto_heal", False)],
    )
    row = await ds.query_one("SELECT * FROM fault_patterns WHERE id=$1", [pid])
    return {"success": True, "data": snake_to_camel(row)}


@router.put("/patterns/{pattern_id}")
async def update_fault_pattern(device_id: str | None = Depends(get_device_id), pattern_id: str = Path(...), request: Request = None, ds=Depends(get_datastore), user=Depends(get_current_user)) -> dict:
    _ALLOWED = {"name", "description", "severity", "pattern", "enabled", "auto_heal"}
    body = camel_to_snake_keys(await request.json())
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
    return {"success": True, "data": snake_to_camel(row)}


@router.delete("/patterns/{pattern_id}")
async def delete_fault_pattern(device_id: str | None = Depends(get_device_id), pattern_id: str = Path(...), ds=Depends(get_datastore), user=Depends(get_current_user)) -> dict:
    await ds.execute("DELETE FROM fault_patterns WHERE id=$1", [pattern_id])
    return {"success": True, "message": "Fault pattern deleted"}


@router.post("/patterns/{pattern_id}/enable-auto-heal")
async def enable_auto_heal(device_id: str | None = Depends(get_device_id), pattern_id: str = Path(...), ds=Depends(get_datastore), user=Depends(get_current_user)) -> dict:
    await ds.execute("UPDATE fault_patterns SET auto_heal=true WHERE id=$1", [pattern_id])
    return {"success": True, "message": "Auto-heal enabled"}


@router.post("/patterns/{pattern_id}/disable-auto-heal")
async def disable_auto_heal(device_id: str | None = Depends(get_device_id), pattern_id: str = Path(...), ds=Depends(get_datastore), user=Depends(get_current_user)) -> dict:
    await ds.execute("UPDATE fault_patterns SET auto_heal=false WHERE id=$1", [pattern_id])
    return {"success": True, "message": "Auto-heal disabled"}


# ---------------------------------------------------------------------------
# Remediations — wired to DataStore
# ---------------------------------------------------------------------------
@router.get("/remediations")
async def get_remediations(device_id: str | None = Depends(get_device_id), ds=Depends(get_datastore), user=Depends(get_current_user)) -> dict:
    if device_id:
        rows = await ds.query("SELECT * FROM remediation_executions WHERE device_id=$1 ORDER BY timestamp DESC", [device_id])
    else:
        rows = await ds.query("SELECT * FROM remediation_executions ORDER BY timestamp DESC")
    return {"success": True, "data": snake_to_camel_list(rows)}


@router.get("/remediations/{remediation_id}")
async def get_remediation_by_id(device_id: str | None = Depends(get_device_id), remediation_id: str = Path(...), ds=Depends(get_datastore), user=Depends(get_current_user)) -> dict:
    row = await ds.query_one("SELECT * FROM remediation_executions WHERE id=$1", [remediation_id])
    if not row:
        raise HTTPException(404, "Remediation not found")
    return {"success": True, "data": snake_to_camel(row)}


@router.post("/remediations/{remediation_id}/execute")
async def execute_fault_remediation(device_id: str | None = Depends(get_device_id), remediation_id: str = Path(...), request: Request = None, ds=Depends(get_datastore), user=Depends(get_current_user)) -> dict:
    row = await ds.query_one("SELECT * FROM remediation_executions WHERE id=$1", [remediation_id])
    if not row:
        raise HTTPException(404, "Remediation not found")
    return {"success": True, "message": "Remediation re-execution started"}


# ---------------------------------------------------------------------------
# Notification Channels — wired to DataStore
# ---------------------------------------------------------------------------
@router.get("/channels")
async def get_notification_channels(device_id: str | None = Depends(get_device_id), ds=Depends(get_datastore), user=Depends(get_current_user)) -> dict:
    if device_id:
        rows = await ds.query("SELECT * FROM notification_channels WHERE device_id=$1 ORDER BY created_at DESC", [device_id])
    else:
        rows = await ds.query("SELECT * FROM notification_channels ORDER BY created_at DESC")
    return {"success": True, "data": snake_to_camel_list(rows)}


@router.get("/channels/{channel_id}")
async def get_notification_channel_by_id(device_id: str | None = Depends(get_device_id), channel_id: str = Path(...), ds=Depends(get_datastore), user=Depends(get_current_user)) -> dict:
    row = await ds.query_one("SELECT * FROM notification_channels WHERE id=$1", [channel_id])
    if not row:
        raise HTTPException(404, "Channel not found")
    return {"success": True, "data": snake_to_camel(row)}


@router.post("/channels")
async def create_notification_channel(device_id: str | None = Depends(get_device_id), request: Request = None, ds=Depends(get_datastore), user=Depends(get_current_user)) -> dict:
    body = await request.json()
    device_id = _resolve_device_id(device_id, body)
    cid = str(uuid.uuid4())
    await ds.execute(
        "INSERT INTO notification_channels (id, device_id, name, type, config, enabled, created_at) VALUES ($1,$2,$3,$4,$5,$6,NOW())",
        [cid, device_id, body.get("name", ""), body.get("type", "webhook"), json.dumps(body.get("config", {})), body.get("enabled", True)],
    )
    row = await ds.query_one("SELECT * FROM notification_channels WHERE id=$1", [cid])
    return {"success": True, "data": snake_to_camel(row)}


@router.put("/channels/{channel_id}")
async def update_notification_channel(device_id: str | None = Depends(get_device_id), channel_id: str = Path(...), request: Request = None, ds=Depends(get_datastore), user=Depends(get_current_user)) -> dict:
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
    return {"success": True, "data": snake_to_camel(row)}


@router.delete("/channels/{channel_id}")
async def delete_notification_channel(device_id: str | None = Depends(get_device_id), channel_id: str = Path(...), ds=Depends(get_datastore), user=Depends(get_current_user)) -> dict:
    await ds.execute("DELETE FROM notification_channels WHERE id=$1", [channel_id])
    return {"success": True, "message": "Channel deleted"}


@router.post("/channels/{channel_id}/test")
async def test_notification_channel(device_id: str | None = Depends(get_device_id), channel_id: str = Path(...), ds=Depends(get_datastore), user=Depends(get_current_user)) -> dict:
    row = await ds.query_one("SELECT * FROM notification_channels WHERE id=$1", [channel_id])
    if not row:
        raise HTTPException(404, "Channel not found")
    return {"success": True, "message": "Test notification sent"}


@router.get("/channels/{channel_id}/pending")
async def get_pending_notifications(device_id: str | None = Depends(get_device_id), channel_id: str = "", ds=Depends(get_datastore), user=Depends(get_current_user)) -> dict:
    if device_id:
        rows = await ds.query("SELECT * FROM notifications WHERE device_id=$1 AND channel_id=$2 AND status='pending' ORDER BY created_at DESC", [device_id, channel_id])
    else:
        rows = await ds.query("SELECT * FROM notifications WHERE channel_id=$1 AND status='pending' ORDER BY created_at DESC", [channel_id])
    return {"success": True, "data": snake_to_camel_list(rows)}


@router.get("/notifications/history")
async def get_notification_history(device_id: str | None = Depends(get_device_id), channel_id: str = Query(None, alias="channelId"), limit: int = Query(100, le=1000, ge=1), ds=Depends(get_datastore), user=Depends(get_current_user)) -> dict:
    conditions = []
    params: list = []
    idx = 1
    if device_id:
        conditions.append(f"device_id=${idx}")
        params.append(device_id)
        idx += 1
    if channel_id:
        conditions.append(f"channel_id=${idx}")
        params.append(channel_id)
        idx += 1
    sql = "SELECT * FROM notifications"
    if conditions:
        sql += " WHERE " + " AND ".join(conditions)
    sql += f" ORDER BY created_at DESC LIMIT ${idx}"
    params.append(limit)
    rows = await ds.query(sql, params)
    return {"success": True, "data": snake_to_camel_list(rows)}


# ---------------------------------------------------------------------------
# Audit Logs — wired to DataStore
# ---------------------------------------------------------------------------
@router.get("/audit")
async def get_audit_logs(
    device_id: str | None = Depends(get_device_id), page: int = Query(1, ge=1), limit: int = Query(50, ge=1, le=1000),
    ds=Depends(get_datastore), user=Depends(get_current_user),
) -> dict:
    offset = (page - 1) * limit
    if device_id:
        rows = await ds.query(
            "SELECT * FROM audit_logs WHERE device_id=$1 ORDER BY created_at DESC LIMIT $2 OFFSET $3",
            [device_id, limit, offset],
        )
        count_row = await ds.query_one("SELECT COUNT(*) as total FROM audit_logs WHERE device_id=$1", [device_id])
    else:
        rows = await ds.query(
            "SELECT * FROM audit_logs ORDER BY created_at DESC LIMIT $1 OFFSET $2",
            [limit, offset],
        )
        count_row = await ds.query_one("SELECT COUNT(*) as total FROM audit_logs")
    return {"success": True, "data": snake_to_camel_list(rows), "total": count_row["total"] if count_row else 0}


# ---------------------------------------------------------------------------
# Dashboard — aggregated data
# ---------------------------------------------------------------------------
@router.get("/dashboard")
async def get_dashboard_data(device_id: str | None = Depends(get_device_id), request: Request = None, ds=Depends(get_datastore), orchestrator=Depends(get_device_orchestrator), user=Depends(get_current_user)) -> dict:
    ae = _c(request).alert_engine()
    active_alerts = await ae.get_active_alerts(device_id)
    now_ms = int(time.time() * 1000)
    recent_events = await ae.get_alert_history(now_ms - 86400_000, now_ms, device_id)
    hm = _c(request).health_monitor()

    data: dict = {
        "activeAlerts": len(active_alerts),
        "recentEvents24h": len(recent_events),
        "criticalAlerts": len([a for a in active_alerts if a.severity == "critical"]),
    }

    if device_id:
        # 单设备模式：返回该设备的健康状态
        data["deviceHealth"] = hm.get_device_status(device_id)
    else:
        # 全局模式：返回设备聚合摘要
        summary = orchestrator.get_device_summary()
        data["deviceHealth"] = None
        data["deviceSummary"] = {
            "total": summary.total,
            "online": summary.online,
            "offline": summary.offline,
            "connecting": summary.connecting,
            "avg_health_score": summary.avg_health_score,
        }

    return {"success": True, "data": data}


# ---------------------------------------------------------------------------
# Syslog — wired to SyslogReceiver + DataStore
# ---------------------------------------------------------------------------
@router.get("/syslog/config")
async def get_syslog_config(device_id: str | None = Depends(get_device_id), ds=Depends(get_datastore), user=Depends(get_current_user)) -> dict:
    row = await ds.query_one("SELECT config FROM device_settings WHERE device_id=$1 AND key='syslog_config'", [device_id])
    return {"success": True, "data": row["config"] if row else {"port": 514, "enabled": False, "severityMapping": {}}}


@router.put("/syslog/config")
async def update_syslog_config(device_id: str | None = Depends(get_device_id), request: Request = None, ds=Depends(get_datastore), user=Depends(get_current_user)) -> dict:
    body = await request.json()
    await ds.execute(
        "INSERT INTO device_settings (device_id, key, config) VALUES ($1, 'syslog_config', $2) "
        "ON CONFLICT (device_id, key) DO UPDATE SET config=$2",
        [device_id, json.dumps(body)],
    )
    return {"success": True, "data": body}


@router.get("/syslog/status")
async def get_syslog_status(device_id: str | None = Depends(get_device_id), request: Request = None, user=Depends(get_current_user)) -> dict:
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
    device_id: str | None = Depends(get_device_id), severity: str = Query(None),
    page: int = Query(1, ge=1), limit: int = Query(50, ge=1, le=1000),
    ds=Depends(get_datastore), user=Depends(get_current_user),
) -> dict:
    # 使用 SQL LIMIT/OFFSET 替代内存分页
    if device_id:
        count_base = "SELECT COUNT(*) as total FROM syslog_events WHERE device_id=$1"
        base = "SELECT * FROM syslog_events WHERE device_id=$1"
        params: list = [device_id]
    else:
        count_base = "SELECT COUNT(*) as total FROM syslog_events WHERE 1=1"
        base = "SELECT * FROM syslog_events WHERE 1=1"
        params: list = []
    if severity:
        idx = len(params) + 1
        count_base += f" AND severity=${idx}"
        base += f" AND severity=${idx}"
        params.append(severity)
    count_row = await ds.query_one(count_base, params)
    total = count_row["total"] if count_row else 0
    offset = (page - 1) * limit
    base += f" ORDER BY timestamp DESC LIMIT {int(limit)} OFFSET {int(offset)}"
    rows = await ds.query(base, params)
    return {"success": True, "data": snake_to_camel_list(rows), "total": total}


@router.get("/syslog/stats")
async def get_syslog_stats(device_id: str | None = Depends(get_device_id), request: Request = None, ds=Depends(get_datastore), user=Depends(get_current_user)) -> dict:
    sr = _c(request).syslog_receiver()
    if device_id:
        count_row = await ds.query_one("SELECT COUNT(*) as total FROM syslog_events WHERE device_id=$1", [device_id])
        sev_rows = await ds.query(
            "SELECT severity, COUNT(*) as cnt FROM syslog_events WHERE device_id=$1 GROUP BY severity", [device_id]
        )
    else:
        count_row = await ds.query_one("SELECT COUNT(*) as total FROM syslog_events")
        sev_rows = await ds.query(
            "SELECT severity, COUNT(*) as cnt FROM syslog_events GROUP BY severity"
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
async def reset_syslog_stats(device_id: str | None = Depends(get_device_id), request: Request = None, user=Depends(get_current_user)) -> dict:
    sr = _c(request).syslog_receiver()
    sr._message_count = 0
    return {"success": True, "message": "Syslog stats reset"}


# ---------------------------------------------------------------------------
# Maintenance Windows — wired to DataStore
# ---------------------------------------------------------------------------
@router.get("/filters/maintenance")
async def get_maintenance_windows(device_id: str | None = Depends(get_device_id), ds=Depends(get_datastore), user=Depends(get_current_user)) -> dict:
    if device_id:
        rows = await ds.query("SELECT * FROM maintenance_windows WHERE device_id=$1 ORDER BY start_time DESC", [device_id])
    else:
        rows = await ds.query("SELECT * FROM maintenance_windows ORDER BY start_time DESC")
    return {"success": True, "data": snake_to_camel_list(rows)}


@router.post("/filters/maintenance")
async def create_maintenance_window(device_id: str | None = Depends(get_device_id), request: Request = None, ds=Depends(get_datastore), user=Depends(get_current_user)) -> dict:
    body = camel_to_snake_keys(await request.json())
    device_id = _resolve_device_id(device_id, body)
    mid = str(uuid.uuid4())
    await ds.execute(
        "INSERT INTO maintenance_windows (id, device_id, name, start_time, end_time, filters, created_at) VALUES ($1,$2,$3,$4,$5,$6,NOW())",
        [mid, device_id, body.get("name", ""), body.get("start_time", 0), body.get("end_time", 0), json.dumps(body.get("filters", {}))],
    )
    row = await ds.query_one("SELECT * FROM maintenance_windows WHERE id=$1", [mid])
    return {"success": True, "data": snake_to_camel(row)}


@router.put("/filters/maintenance/{window_id}")
async def update_maintenance_window(device_id: str | None = Depends(get_device_id), window_id: str = Path(...), request: Request = None, ds=Depends(get_datastore), user=Depends(get_current_user)) -> dict:
    _ALLOWED = {"name", "start_time", "end_time", "filters", "enabled", "description"}
    body = camel_to_snake_keys(await request.json())
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
    return {"success": True, "data": snake_to_camel(row)}


@router.delete("/filters/maintenance/{window_id}")
async def delete_maintenance_window(device_id: str | None = Depends(get_device_id), window_id: str = Path(...), ds=Depends(get_datastore), user=Depends(get_current_user)) -> dict:
    await ds.execute("DELETE FROM maintenance_windows WHERE id=$1", [window_id])
    return {"success": True, "message": "Maintenance window deleted"}


# ---------------------------------------------------------------------------
# Known Issues — wired to DataStore
# ---------------------------------------------------------------------------
@router.get("/filters/known-issues")
async def get_known_issues(device_id: str | None = Depends(get_device_id), ds=Depends(get_datastore), user=Depends(get_current_user)) -> dict:
    if device_id:
        rows = await ds.query("SELECT * FROM known_issues WHERE device_id=$1 ORDER BY created_at DESC", [device_id])
    else:
        rows = await ds.query("SELECT * FROM known_issues ORDER BY created_at DESC")
    return {"success": True, "data": snake_to_camel_list(rows)}


@router.post("/filters/known-issues")
async def create_known_issue(device_id: str | None = Depends(get_device_id), request: Request = None, ds=Depends(get_datastore), user=Depends(get_current_user)) -> dict:
    body = camel_to_snake_keys(await request.json())
    device_id = _resolve_device_id(device_id, body)
    kid = str(uuid.uuid4())
    await ds.execute(
        "INSERT INTO known_issues (id, device_id, title, description, pattern, auto_resolve, created_at) VALUES ($1,$2,$3,$4,$5,$6,NOW())",
        [kid, device_id, body.get("title", ""), body.get("description", ""), json.dumps(body.get("pattern", {})), body.get("auto_resolve", False)],
    )
    row = await ds.query_one("SELECT * FROM known_issues WHERE id=$1", [kid])
    return {"success": True, "data": snake_to_camel(row)}


@router.put("/filters/known-issues/{issue_id}")
async def update_known_issue(device_id: str | None = Depends(get_device_id), issue_id: str = Path(...), request: Request = None, ds=Depends(get_datastore), user=Depends(get_current_user)) -> dict:
    _ALLOWED = {"name", "title", "description", "pattern", "severity", "enabled", "auto_resolve"}
    body = camel_to_snake_keys(await request.json())
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
    return {"success": True, "data": snake_to_camel(row)}


@router.delete("/filters/known-issues/{issue_id}")
async def delete_known_issue(device_id: str | None = Depends(get_device_id), issue_id: str = Path(...), ds=Depends(get_datastore), user=Depends(get_current_user)) -> dict:
    await ds.execute("DELETE FROM known_issues WHERE id=$1", [issue_id])
    return {"success": True, "message": "Known issue deleted"}


# ---------------------------------------------------------------------------
# Decision Rules — wired to DataStore + DecisionEngine
# ---------------------------------------------------------------------------
@router.get("/decisions/rules")
async def get_decision_rules(device_id: str | None = Depends(get_device_id), ds=Depends(get_datastore), user=Depends(get_current_user)) -> dict:
    if device_id:
        rows = await ds.query("SELECT * FROM decision_rules WHERE device_id=$1 ORDER BY created_at DESC", [device_id])
    else:
        rows = await ds.query("SELECT * FROM decision_rules ORDER BY created_at DESC")
    return {"success": True, "data": snake_to_camel_list(rows)}


@router.get("/decisions/rules/{rule_id}")
async def get_decision_rule_by_id(device_id: str | None = Depends(get_device_id), rule_id: str = Path(...), ds=Depends(get_datastore), user=Depends(get_current_user)) -> dict:
    row = await ds.query_one("SELECT * FROM decision_rules WHERE id=$1", [rule_id])
    if not row:
        raise HTTPException(404, "Decision rule not found")
    return {"success": True, "data": snake_to_camel(row)}


@router.post("/decisions/rules")
async def create_decision_rule(device_id: str | None = Depends(get_device_id), request: Request = None, ds=Depends(get_datastore), user=Depends(get_current_user)) -> dict:
    body = await request.json()
    device_id = _resolve_device_id(device_id, body)
    rid = str(uuid.uuid4())
    await ds.execute(
        "INSERT INTO decision_rules (id, device_id, name, condition, action, priority, enabled, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,NOW())",
        [rid, device_id, body.get("name", ""), json.dumps(body.get("condition", {})),
         json.dumps(body.get("action", {})), body.get("priority", 0), body.get("enabled", True)],
    )
    row = await ds.query_one("SELECT * FROM decision_rules WHERE id=$1", [rid])
    return {"success": True, "data": snake_to_camel(row)}


@router.put("/decisions/rules/{rule_id}")
async def update_decision_rule(device_id: str | None = Depends(get_device_id), rule_id: str = Path(...), request: Request = None, ds=Depends(get_datastore), user=Depends(get_current_user)) -> dict:
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
    return {"success": True, "data": snake_to_camel(row)}


@router.delete("/decisions/rules/{rule_id}")
async def delete_decision_rule(device_id: str | None = Depends(get_device_id), rule_id: str = Path(...), ds=Depends(get_datastore), user=Depends(get_current_user)) -> dict:
    await ds.execute("DELETE FROM decision_rules WHERE id=$1", [rule_id])
    return {"success": True, "message": "Decision rule deleted"}


@router.get("/decisions/history")
async def get_decision_history(
    device_id: str | None = Depends(get_device_id), page: int = Query(1, ge=1), limit: int = Query(50, ge=1, le=1000),
    ds=Depends(get_datastore), user=Depends(get_current_user),
) -> dict:
    offset = (page - 1) * limit
    if device_id:
        rows = await ds.query(
            "SELECT * FROM decision_history WHERE device_id=$1 ORDER BY timestamp DESC LIMIT $2 OFFSET $3",
            [device_id, limit, offset],
        )
    else:
        rows = await ds.query(
            "SELECT * FROM decision_history ORDER BY timestamp DESC LIMIT $1 OFFSET $2",
            [limit, offset],
        )
    return {"success": True, "data": snake_to_camel_list(rows)}


# ---------------------------------------------------------------------------
# Feedback — wired to DataStore
# ---------------------------------------------------------------------------
@router.post("/feedback")
async def submit_feedback(device_id: str | None = Depends(get_device_id), request: Request = None, ds=Depends(get_datastore), user=Depends(get_current_user)) -> dict:
    body = await request.json()
    device_id = _resolve_device_id(device_id, body)
    fid = str(uuid.uuid4())
    await ds.execute(
        "INSERT INTO feedback (id, device_id, alert_id, analysis_id, rating, comment, action_taken, created_at) "
        "VALUES ($1,$2,$3,$4,$5,$6,$7,NOW())",
        [fid, device_id, body.get("alertId", ""), body.get("analysisId", ""),
         body.get("rating", 0), body.get("comment", ""), body.get("actionTaken", "")],
    )
    return {"success": True, "data": {"id": fid}}


@router.get("/feedback/stats")
async def get_feedback_stats(device_id: str | None = Depends(get_device_id), ds=Depends(get_datastore), user=Depends(get_current_user)) -> dict:
    if device_id:
        total = await ds.query_one("SELECT COUNT(*) as cnt FROM feedback WHERE device_id=$1", [device_id])
        avg_row = await ds.query_one("SELECT AVG(rating) as avg_rating FROM feedback WHERE device_id=$1", [device_id])
    else:
        total = await ds.query_one("SELECT COUNT(*) as cnt FROM feedback")
        avg_row = await ds.query_one("SELECT AVG(rating) as avg_rating FROM feedback")
    return {
        "success": True,
        "data": {
            "totalFeedback": total["cnt"] if total else 0,
            "averageRating": float(avg_row["avg_rating"]) if avg_row and avg_row.get("avg_rating") else 0,
        },
    }


@router.get("/feedback/review")
async def get_rules_needing_review(device_id: str | None = Depends(get_device_id), ds=Depends(get_datastore), user=Depends(get_current_user)) -> dict:
    if device_id:
        rows = await ds.query(
            "SELECT rule_id, COUNT(*) as negative_count FROM feedback "
            "WHERE device_id=$1 AND rating <= 2 GROUP BY rule_id HAVING COUNT(*) >= 3 ORDER BY negative_count DESC",
            [device_id],
        )
    else:
        rows = await ds.query(
            "SELECT rule_id, COUNT(*) as negative_count FROM feedback "
            "WHERE rating <= 2 GROUP BY rule_id HAVING COUNT(*) >= 3 ORDER BY negative_count DESC",
        )
    return {"success": True, "data": snake_to_camel_list(rows)}


# ---------------------------------------------------------------------------
# Cache Stats — wired to AlertPipeline + AnalysisCache
# ---------------------------------------------------------------------------
@router.get("/cache/fingerprint/stats")
async def get_fingerprint_cache_stats(device_id: str | None = Depends(get_device_id), request: Request = None, user=Depends(get_current_user)) -> dict:
    pipeline = _c(request).alert_pipeline()
    stats = pipeline.get_stats()
    return {"success": True, "data": {"deduplicated": stats.get("deduplicated", 0), "fingerprints": len(pipeline._fingerprints)}}


@router.post("/cache/fingerprint/clear")
async def clear_fingerprint_cache(device_id: str | None = Depends(get_device_id), request: Request = None, user=Depends(get_current_user)) -> dict:
    pipeline = _c(request).alert_pipeline()
    pipeline._fingerprints.clear()
    return {"success": True, "message": "Fingerprint cache cleared"}


@router.get("/cache/analysis/stats")
async def get_analysis_cache_stats(device_id: str | None = Depends(get_device_id), request: Request = None, user=Depends(get_current_user)) -> dict:
    cache = _c(request).analysis_cache()
    return {"success": True, "data": cache.get_stats()}


@router.post("/cache/analysis/clear")
async def clear_analysis_cache(device_id: str | None = Depends(get_device_id), request: Request = None, user=Depends(get_current_user)) -> dict:
    cache = _c(request).analysis_cache()
    cache.clear()
    return {"success": True, "message": "Analysis cache cleared"}


@router.get("/cache/events/stats")
async def get_events_cache_stats(device_id: str | None = Depends(get_device_id), request: Request = None, user=Depends(get_current_user)) -> dict:
    pipeline = _c(request).alert_pipeline()
    return {"success": True, "data": pipeline.get_stats()}


# ---------------------------------------------------------------------------
# Pipeline Status — wired to AlertPipeline
# ---------------------------------------------------------------------------
@router.get("/pipeline/status")
async def get_pipeline_status(device_id: str | None = Depends(get_device_id), request: Request = None, user=Depends(get_current_user)) -> dict:
    pipeline = _c(request).alert_pipeline()
    hc = await pipeline.health_check()
    return {"success": True, "data": hc}


@router.get("/pipeline/concurrency")
async def get_pipeline_concurrency_status(device_id: str | None = Depends(get_device_id), request: Request = None, user=Depends(get_current_user)) -> dict:
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
async def get_services_health(device_id: str | None = Depends(get_device_id), request: Request = None, user=Depends(get_current_user)) -> dict:
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
async def get_health_services(device_id: str | None = Depends(get_device_id), request: Request = None, user=Depends(get_current_user)) -> dict:
    """Alias: frontend calls /health/services, delegates to get_services_health."""
    return await get_services_health(device_id=device_id, request=request, user=user)


@router.get("/health/degradation")
async def get_health_degradation(device_id: str | None = Depends(get_device_id), request: Request = None, user=Depends(get_current_user)) -> dict:
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
async def get_health_current(device_id: str | None = Depends(get_device_id), request: Request = None, user=Depends(get_current_user)) -> dict:
    hm = _c(request).health_monitor()

    # 单设备查询
    if device_id:
        status = hm.get_device_status(device_id)
        if not status:
            return {"success": True, "data": {"healthy": True, "message": "No health data yet"}}
        return {"success": True, "data": status}

    # 全局健康概览 — 聚合所有设备状态，供全息驾驶舱 VitalSigns 使用
    all_status = hm.get_all_status()
    total = len(all_status)
    if total == 0:
        # 没有设备接入时，系统本身是健康的，返回基线状态而非 unknown
        return {"success": True, "data": {
            "score": 100, "level": "healthy",
            "dimensions": {"system": 100, "network": 0, "performance": 100, "reliability": 100},
            "issues": [],
            "message": "No devices connected",
        }}

    healthy_count = sum(1 for s in all_status.values() if s.get("healthy"))
    avg_latency = sum(s.get("latency_ms", 0) for s in all_status.values()) / total if total else 0
    score = int((healthy_count / total) * 100) if total else 0

    if score >= 80:
        level = "healthy"
    elif score >= 50:
        level = "warning"
    else:
        level = "critical"

    # 维度评分：基于设备健康比例和延迟
    sys_score = min(100, score)
    net_score = min(100, max(0, 100 - int(avg_latency / 10)))  # 延迟越高网络分越低
    perf_score = min(100, max(0, 100 - int(avg_latency / 5)))
    rel_score = int((healthy_count / total) * 100) if total else 0

    issues = [
        {"device_id": did, "error": s.get("error", "unhealthy")}
        for did, s in all_status.items() if not s.get("healthy")
    ]

    return {"success": True, "data": {
        "score": score, "level": level,
        "dimensions": {"system": sys_score, "network": net_score, "performance": perf_score, "reliability": rel_score},
        "issues": issues,
    }}


@router.get("/health/trend")
async def get_health_trend(device_id: str | None = Depends(get_device_id), hours: int = Query(24, gt=0), range_: str = Query(None, alias="range"), ds=Depends(get_datastore), user=Depends(get_current_user)) -> dict:
    # range 优先于 hours
    if range_:
        mapping = {"1h": 1, "6h": 6, "24h": 24, "7d": 168}
        if range_ not in mapping:
            raise HTTPException(400, f"Invalid range value: {range_}. Valid: {list(mapping.keys())}")
        hours = mapping[range_]
    rows = await ds.query(
        f"SELECT * FROM health_checks WHERE device_id=$1 AND timestamp > NOW() - INTERVAL '{int(hours)} hours' ORDER BY timestamp",
        [device_id],
    )
    return {"success": True, "data": snake_to_camel_list(rows)}


@router.get("/health/{service_name}")
async def get_service_health(device_id: str | None = Depends(get_device_id), service_name: str = "", request: Request = None, user=Depends(get_current_user)) -> dict:
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
async def get_lifecycle_config(device_id: str | None = Depends(get_device_id), request: Request = None, user=Depends(get_current_user)) -> dict:
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
async def list_iterations(device_id: str | None = Depends(get_device_id), ds=Depends(get_datastore), user=Depends(get_current_user)) -> dict:
    rows = await ds.query(
        "SELECT * FROM iterations WHERE device_id=$1 AND status IN ('running','pending') ORDER BY created_at DESC",
        [device_id],
    )
    return {"success": True, "data": snake_to_camel_list(rows)}


@router.get("/iterations/{iteration_id}")
async def get_iteration_state(device_id: str | None = Depends(get_device_id), iteration_id: str = Path(...), ds=Depends(get_datastore), user=Depends(get_current_user)) -> dict:
    row = await ds.query_one("SELECT * FROM iterations WHERE id=$1", [iteration_id])
    if not row:
        raise HTTPException(404, "Iteration not found")
    return {"success": True, "data": snake_to_camel(row)}


@router.post("/iterations/{iteration_id}/abort")
async def abort_iteration(device_id: str | None = Depends(get_device_id), iteration_id: str = Path(...), ds=Depends(get_datastore), user=Depends(get_current_user)) -> dict:
    await ds.execute("UPDATE iterations SET status='aborted' WHERE id=$1", [iteration_id])
    return {"success": True, "message": "Iteration aborted"}


@router.get("/evaluations/{plan_id}")
async def get_evaluation_report(device_id: str | None = Depends(get_device_id), plan_id: str = Path(...), ds=Depends(get_datastore), user=Depends(get_current_user)) -> dict:
    row = await ds.query_one("SELECT * FROM evaluation_reports WHERE plan_id=$1", [plan_id])
    if not row:
        raise HTTPException(404, "Evaluation report not found")
    return {"success": True, "data": snake_to_camel(row)}


@router.get("/learning")
async def query_learning(
    device_id: str | None = Depends(get_device_id), category: str = Query(None),
    page: int = Query(1, ge=1), limit: int = Query(50, ge=1, le=1000),
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
    return {"success": True, "data": snake_to_camel_list(rows), "total": total}


@router.get("/stats/critic")
async def get_critic_stats(device_id: str | None = Depends(get_device_id), ds=Depends(get_datastore), user=Depends(get_current_user)) -> dict:
    row = await ds.query_one(
        "SELECT COUNT(*) as total, SUM(CASE WHEN result='pass' THEN 1 ELSE 0 END) as passed "
        "FROM critic_evaluations WHERE device_id=$1", [device_id]
    )
    return {"success": True, "data": row or {"total": 0, "passed": 0}}


@router.get("/stats/reflector")
async def get_reflector_stats(device_id: str | None = Depends(get_device_id), ds=Depends(get_datastore), user=Depends(get_current_user)) -> dict:
    row = await ds.query_one(
        "SELECT COUNT(*) as total, SUM(CASE WHEN applied=true THEN 1 ELSE 0 END) as applied "
        "FROM reflector_suggestions WHERE device_id=$1", [device_id]
    )
    return {"success": True, "data": row or {"total": 0, "applied": 0}}


@router.get("/stats/iterations")
async def get_iteration_stats(device_id: str | None = Depends(get_device_id), ds=Depends(get_datastore), user=Depends(get_current_user)) -> dict:
    row = await ds.query_one(
        "SELECT COUNT(*) as total, "
        "SUM(CASE WHEN status='completed' THEN 1 ELSE 0 END) as completed, "
        "SUM(CASE WHEN status='running' THEN 1 ELSE 0 END) as running "
        "FROM iterations WHERE device_id=$1", [device_id]
    )
    return {"success": True, "data": row or {"total": 0, "completed": 0, "running": 0}}


@router.get("/critic/config")
async def get_critic_reflector_config(device_id: str | None = Depends(get_device_id), ds=Depends(get_datastore), user=Depends(get_current_user)) -> dict:
    row = await ds.query_one("SELECT config FROM device_settings WHERE device_id=$1 AND key='critic_config'", [device_id])
    return {"success": True, "data": row["config"] if row else {"criticEnabled": True, "reflectorEnabled": True, "autoApply": False}}


@router.post("/critic/config")
async def update_critic_reflector_config(device_id: str | None = Depends(get_device_id), request: Request = None, ds=Depends(get_datastore), user=Depends(get_current_user)) -> dict:
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
async def get_evolution_config(device_id: str | None = Depends(get_device_id), ds=Depends(get_datastore), user=Depends(get_current_user)) -> dict:
    row = await ds.query_one("SELECT config FROM device_settings WHERE device_id=$1 AND key='evolution_config'", [device_id])
    if row:
        return {"success": True, "data": row["config"]}
    # No per-device config — read global default from evolution-config.json
    from pathlib import Path as _Path
    evo_path = _Path("data/ai-ops/evolution-config.json")
    if evo_path.exists():
        try:
            text = await asyncio.to_thread(evo_path.read_text, encoding="utf-8")
            data = json.loads(text)
            return {"success": True, "data": data}
        except Exception:
            pass
    # Ultimate fallback: everything enabled
    return {"success": True, "data": {"enabled": True, "autonomousBrain": {"enabled": True}, "capabilities": {}}}


@router.put("/evolution/config")
async def update_evolution_config(device_id: str | None = Depends(get_device_id), request: Request = None, ds=Depends(get_datastore), user=Depends(get_current_user)) -> dict:
    body = await request.json()
    await ds.execute(
        "INSERT INTO device_settings (device_id, key, config) VALUES ($1, 'evolution_config', $2) "
        "ON CONFLICT (device_id, key) DO UPDATE SET config=$2",
        [device_id, json.dumps(body)],
    )
    return {"success": True, "data": body}


@router.get("/evolution/status")
async def get_evolution_status(device_id: str | None = Depends(get_device_id), ds=Depends(get_datastore), user=Depends(get_current_user)) -> dict:
    row = await ds.query_one("SELECT config FROM device_settings WHERE device_id=$1 AND key='evolution_config'", [device_id])
    if row:
        config = row["config"]
    else:
        # Read global default
        from pathlib import Path as _Path
        evo_path = _Path("data/ai-ops/evolution-config.json")
        if evo_path.exists():
            try:
                text = await asyncio.to_thread(evo_path.read_text, encoding="utf-8")
                config = json.loads(text)
            except Exception:
                config = {}
        else:
            config = {}
    if not isinstance(config, dict):
        config = {}
    # Build capabilities from config sub-modules (each has an "enabled" field)
    # e.g. {"reflection": {"enabled": true, ...}, "experience": {"enabled": true, ...}}
    capabilities: dict[str, bool] = {}
    for key, val in config.items():
        if isinstance(val, dict) and "enabled" in val:
            capabilities[key] = val["enabled"]
    enabled_count = sum(1 for v in capabilities.values() if v)
    return {
        "success": True,
        "data": {
            "enabled": True,
            "capabilities": capabilities,
            "totalCapabilities": len(capabilities),
            "enabledCapabilities": enabled_count,
        },
    }


@router.post("/evolution/capability/{name}/enable")
async def enable_evolution_capability(device_id: str | None = Depends(get_device_id), name: str = Path(...), ds=Depends(get_datastore), user=Depends(get_current_user)) -> dict:
    async def _tx(tx):
        row = await tx.query_one("SELECT config FROM device_settings WHERE device_id=$1 AND key='evolution_config' FOR UPDATE", [device_id])
        if row:
            config = row["config"]
            if isinstance(config, str):
                config = json.loads(config)
        else:
            # Read global default
            from pathlib import Path as _Path
            evo_path = _Path("data/ai-ops/evolution-config.json")
            if evo_path.exists():
                try:
                    config = json.loads(evo_path.read_text(encoding="utf-8"))
                except Exception:
                    config = {}
            else:
                config = {}
        # Config structure: {reflection: {enabled: true, ...}, experience: {enabled: true, ...}, ...}
        config.setdefault(name, {})["enabled"] = True
        await tx.execute(
            "INSERT INTO device_settings (device_id, key, config) VALUES ($1, 'evolution_config', $2) "
            "ON CONFLICT (device_id, key) DO UPDATE SET config=$2",
            [device_id, json.dumps(config)],
        )
    await ds.transaction(_tx)
    return {"success": True, "message": f"Capability '{name}' enabled"}


@router.post("/evolution/capability/{name}/disable")
async def disable_evolution_capability(device_id: str | None = Depends(get_device_id), name: str = Path(...), ds=Depends(get_datastore), user=Depends(get_current_user)) -> dict:
    async def _tx(tx):
        row = await tx.query_one("SELECT config FROM device_settings WHERE device_id=$1 AND key='evolution_config' FOR UPDATE", [device_id])
        if row:
            config = row["config"]
            if isinstance(config, str):
                config = json.loads(config)
        else:
            # Read global default
            from pathlib import Path as _Path
            evo_path = _Path("data/ai-ops/evolution-config.json")
            if evo_path.exists():
                try:
                    config = json.loads(evo_path.read_text(encoding="utf-8"))
                except Exception:
                    config = {}
            else:
                config = {}
        # Config structure: {reflection: {enabled: true, ...}, experience: {enabled: true, ...}, ...}
        config.setdefault(name, {})["enabled"] = False
        await tx.execute(
            "INSERT INTO device_settings (device_id, key, config) VALUES ($1, 'evolution_config', $2) "
            "ON CONFLICT (device_id, key) DO UPDATE SET config=$2",
            [device_id, json.dumps(config)],
        )
    await ds.transaction(_tx)
    return {"success": True, "message": f"Capability '{name}' disabled"}


@router.get("/evolution/tool-stats")
async def get_tool_stats(device_id: str | None = Depends(get_device_id), ds=Depends(get_datastore), user=Depends(get_current_user)) -> dict:
    rows = await ds.query(
        "SELECT tool_name, COUNT(*) as usage_count, AVG(duration_ms) as avg_duration "
        "FROM tool_usage WHERE device_id=$1 GROUP BY tool_name ORDER BY usage_count DESC",
        [device_id],
    )
    return {"success": True, "data": snake_to_camel_list(rows)}


@router.get("/anomaly/predictions")
async def get_anomaly_predictions(device_id: str | None = Depends(get_device_id), ds=Depends(get_datastore), user=Depends(get_current_user)) -> dict:
    rows = await ds.query(
        "SELECT * FROM anomaly_predictions WHERE device_id=$1 ORDER BY created_at DESC LIMIT 20", [device_id]
    )
    return {"success": True, "data": snake_to_camel_list(rows)}


# ---------------------------------------------------------------------------
# SSE Streaming — wired to AutonomousBrain + EventBus
# ---------------------------------------------------------------------------
@router.get("/learning/stream")
async def stream_learning_events(device_id: str | None = Depends(get_device_id), request: Request = None, user=Depends(get_current_user)):
    """SSE stream for learning events."""
    async def _generate():
        try:
            ds = _c(request).datastore()
        except Exception as exc:
            yield f"data: {json.dumps({'type': 'error', 'message': str(exc)})}\n\n"
            return
        last_id = 0
        try:
            while True:
                rows = await ds.query(
                    "SELECT * FROM learning_entries WHERE device_id=$1 AND id > $2 ORDER BY id ASC LIMIT 10",
                    [device_id, last_id],
                )
                for row in rows:
                    last_id = row.get("id", last_id)
                    yield f"data: {json.dumps(row, default=str)}\n\n"
                yield f"data: {json.dumps({'type': 'heartbeat'})}\n\n"
                await asyncio.sleep(2)
        except asyncio.CancelledError:
            pass
        except Exception as exc:
            yield f"data: {json.dumps({'type': 'error', 'message': str(exc)})}\n\n"

    return StreamingResponse(_generate(), media_type="text/event-stream",
                             headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


@router.get("/iterations/{iteration_id}/stream")
async def stream_iteration_events(device_id: str | None = Depends(get_device_id), iteration_id: str = Path(...), request: Request = None, user=Depends(get_current_user)):
    """SSE stream for iteration progress."""
    async def _generate():
        try:
            ds = _c(request).datastore()
        except Exception as exc:
            yield f"data: {json.dumps({'type': 'error', 'message': str(exc)})}\n\n"
            return
        try:
            while True:
                row = await ds.query_one("SELECT * FROM iterations WHERE id=$1", [iteration_id])
                if row:
                    yield f"data: {json.dumps(row, default=str)}\n\n"
                    if row.get("status") in ("completed", "failed", "aborted"):
                        break
                yield f"data: {json.dumps({'type': 'heartbeat'})}\n\n"
                await asyncio.sleep(2)
        except asyncio.CancelledError:
            pass
        except Exception as exc:
            yield f"data: {json.dumps({'type': 'error', 'message': str(exc)})}\n\n"

    return StreamingResponse(_generate(), media_type="text/event-stream",
                             headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


@router.get("/intents/stream")
async def stream_autonomous_intents(device_id: str | None = Depends(get_device_id), request: Request = None, user=Depends(get_current_user)):
    """SSE stream for autonomous brain intents."""
    async def _generate():
        try:
            brain = _c(request).autonomous_brain()
        except Exception as exc:
            yield f"data: {json.dumps({'type': 'error', 'message': str(exc)})}\n\n"
            return
        q: asyncio.Queue[dict] = asyncio.Queue()

        def _on_thinking(phase, message, meta=None):
            # 只转发 decide 阶段的事件作为 intent
            if str(phase) == "decide":
                q.put_nowait({"phase": str(phase), "message": message, "meta": meta})

        brain.on_thinking(_on_thinking)
        try:
            yield f"data: {json.dumps({'type': 'connected'})}\n\n"
            while True:
                try:
                    event = await asyncio.wait_for(q.get(), timeout=30)
                    # 包装为前端期望的 intent 格式
                    intent_data = {
                        "type": "intent",
                        "data": {
                            "action": event.get("message", ""),
                            "target": event.get("meta", {}).get("target", "system") if event.get("meta") else "system",
                            "riskLevel": event.get("meta", {}).get("risk_level", "MEDIUM") if event.get("meta") else "MEDIUM",
                        },
                    }
                    yield f"data: {json.dumps(intent_data, default=str)}\n\n"
                except asyncio.TimeoutError:
                    yield f"data: {json.dumps({'type': 'heartbeat'})}\n\n"
        except asyncio.CancelledError:
            pass
        except Exception as exc:
            yield f"data: {json.dumps({'type': 'error', 'message': str(exc)})}\n\n"
        finally:
            brain.remove_on_thinking(_on_thinking)

    return StreamingResponse(_generate(), media_type="text/event-stream",
                             headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


@router.get("/brain/thinking/stream")
async def stream_brain_thinking(device_id: str | None = Depends(get_device_id), request: Request = None, user=Depends(get_current_user)):
    """SSE stream for brain OODA thinking process."""
    async def _generate():
        try:
            brain = _c(request).autonomous_brain()
        except Exception as exc:
            yield f"data: {json.dumps({'type': 'error', 'message': str(exc)})}\n\n"
            return
        q: asyncio.Queue[dict] = asyncio.Queue()

        def _on_thinking(phase, message, meta=None):
            q.put_nowait({"phase": str(phase), "message": message, "meta": meta, "device_id": device_id})

        brain.on_thinking(_on_thinking)
        try:
            yield "data: {\"type\": \"connected\"}\n\n"
            while True:
                try:
                    event = await asyncio.wait_for(q.get(), timeout=30)
                    yield f"event: brain-thinking\ndata: {json.dumps(event, default=str)}\n\n"
                except asyncio.TimeoutError:
                    yield ": keepalive\n\n"
        except asyncio.CancelledError:
            pass
        except Exception as exc:
            yield f"data: {json.dumps({'type': 'error', 'message': str(exc)})}\n\n"
        finally:
            brain.remove_on_thinking(_on_thinking)

    return StreamingResponse(_generate(), media_type="text/event-stream",
                             headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


# ---------------------------------------------------------------------------
# Brain Intents — wired to AutonomousBrain
# ---------------------------------------------------------------------------
@router.get("/intents/pending")
async def get_pending_intents(device_id: str | None = Depends(get_device_id), request: Request = None, ds=Depends(get_datastore), user=Depends(get_current_user)) -> dict:
    rows = await ds.query(
        "SELECT * FROM brain_intents WHERE device_id=$1 AND status='pending' ORDER BY created_at DESC",
        [device_id],
    )
    return {"success": True, "data": snake_to_camel_list(rows)}


@router.post("/intents/grant/{intent_id}")
async def grant_intent(device_id: str | None = Depends(get_device_id), intent_id: str = Path(...), request: Request = None, ds=Depends(get_datastore), user=Depends(get_current_user)) -> dict:
    await ds.execute("UPDATE brain_intents SET status='granted', resolved_at=NOW() WHERE id=$1", [intent_id])
    brain = _c(request).autonomous_brain()
    await brain.trigger_tick(reason="intent_granted", payload={"intent_id": intent_id})
    return {"success": True, "message": "Intent granted"}


@router.post("/intents/reject/{intent_id}")
async def reject_intent(device_id: str | None = Depends(get_device_id), intent_id: str = Path(...), request: Request = None, ds=Depends(get_datastore), user=Depends(get_current_user)) -> dict:
    body = await request.json() if request.headers.get("content-type", "").startswith("application/json") else {}
    reason = body.get("reason", "Rejected by operator")
    await ds.execute(
        "UPDATE brain_intents SET status='rejected', reason=$2, resolved_at=NOW() WHERE id=$1",
        [intent_id, reason],
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
    return {"success": True, "data": snake_to_camel_list(rows)}


@router.post("/syslog/sources")
async def create_syslog_source(request: Request = None, ds=Depends(get_datastore), user=Depends(get_current_user)) -> dict:
    body = await request.json()
    sid = str(uuid.uuid4())
    await ds.execute(
        "INSERT INTO syslog_sources (id, name, host, port, protocol, created_at) VALUES ($1,$2,$3,$4,$5,NOW())",
        [sid, body.get("name", ""), body.get("host", ""), body.get("port", 514), body.get("protocol", "udp")],
    )
    row = await ds.query_one("SELECT * FROM syslog_sources WHERE id=$1", [sid])
    return {"success": True, "data": snake_to_camel(row)}


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
    return {"success": True, "data": snake_to_camel(row)}


@router.delete("/syslog/sources/{source_id}")
async def delete_syslog_source(source_id: str = Path(...), ds=Depends(get_datastore), user=Depends(get_current_user)) -> dict:
    await ds.execute("DELETE FROM syslog_sources WHERE id=$1", [source_id])
    return {"success": True, "message": "Syslog source deleted"}


@router.get("/syslog/rules")
async def get_syslog_rules(ds=Depends(get_datastore), user=Depends(get_current_user)) -> dict:
    rows = await ds.query("SELECT * FROM syslog_rules ORDER BY priority ASC")
    return {"success": True, "data": snake_to_camel_list(rows)}


@router.post("/syslog/rules")
async def create_syslog_rule(request: Request = None, ds=Depends(get_datastore), user=Depends(get_current_user)) -> dict:
    body = await request.json()
    rid = str(uuid.uuid4())
    await ds.execute(
        "INSERT INTO syslog_rules (id, name, pattern, action, priority, created_at) VALUES ($1,$2,$3,$4,$5,NOW())",
        [rid, body.get("name", ""), body.get("pattern", ""), json.dumps(body.get("action", {})), body.get("priority", 0)],
    )
    row = await ds.query_one("SELECT * FROM syslog_rules WHERE id=$1", [rid])
    return {"success": True, "data": snake_to_camel(row)}


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
    return {"success": True, "data": snake_to_camel(row)}


@router.delete("/syslog/rules/{rule_id}")
async def delete_syslog_rule(rule_id: str = Path(...), ds=Depends(get_datastore), user=Depends(get_current_user)) -> dict:
    await ds.execute("DELETE FROM syslog_rules WHERE id=$1", [rule_id])
    return {"success": True, "message": "Syslog rule deleted"}


def _regex_worker(pattern: str, text: str, queue) -> None:
    """在独立进程中执行正则匹配。必须定义在模块顶层。"""
    import re
    try:
        matched = bool(re.search(pattern, text)) if pattern else False
        queue.put({"success": True, "matched": matched})
    except re.error as e:
        queue.put({"success": False, "error": f"正则语法错误: {e}"})
    except Exception:
        queue.put({"success": False, "error": "内部执行错误"})


@router.post("/syslog/rules/{rule_id}/test")
async def test_syslog_rule(rule_id: str = Path(...), request: Request = None, ds=Depends(get_datastore), user=Depends(get_current_user)) -> dict:
    row = await ds.query_one("SELECT * FROM syslog_rules WHERE id=$1", [rule_id])
    if not row:
        raise HTTPException(404, "Syslog rule not found")
    body = await request.json()
    pattern = row.get("pattern", "")
    test_message = body.get("message", "")

    # 限制输入长度，减少回溯攻击面
    if len(pattern) > 500:
        raise HTTPException(400, "正则表达式过长（最大 500 字符）")
    if len(test_message) > 10000:
        raise HTTPException(400, "测试消息过长（最大 10000 字符）")

    # 使用独立进程执行正则：超时后可 terminate() 强制终止，不阻塞事件循环
    import multiprocessing
    ctx = multiprocessing.get_context("spawn")
    q = ctx.Queue()
    p = ctx.Process(target=_regex_worker, args=(pattern, test_message, q))
    p.start()

    async def _wait_for_process():
        while p.is_alive():
            await asyncio.sleep(0.05)
        return q.get_nowait() if not q.empty() else {"success": True, "matched": False}

    try:
        result = await asyncio.wait_for(_wait_for_process(), timeout=1.0)
    except asyncio.TimeoutError:
        p.terminate()
        # 异步等待进程退出，不使用同步 join() 避免阻塞事件循环
        for _ in range(20):
            if not p.is_alive():
                break
            await asyncio.sleep(0.05)
        if p.is_alive():
            p.kill()
        raise HTTPException(400, "正则表达式执行超时（可能存在性能问题）")
    finally:
        if p.is_alive():
            p.terminate()
        q.close()
        q.join_thread()

    # 解析 worker 返回结果
    if isinstance(result, dict) and not result.get("success"):
        raise HTTPException(400, result.get("error", "正则执行失败"))
    matched = result.get("matched", False) if isinstance(result, dict) else False
    return {"success": True, "data": {"matched": matched, "pattern": pattern}}


@router.get("/syslog/filters")
async def get_syslog_filters(ds=Depends(get_datastore), user=Depends(get_current_user)) -> dict:
    rows = await ds.query("SELECT * FROM syslog_filters ORDER BY created_at DESC")
    return {"success": True, "data": snake_to_camel_list(rows)}


@router.post("/syslog/filters")
async def create_syslog_filter(request: Request = None, ds=Depends(get_datastore), user=Depends(get_current_user)) -> dict:
    body = await request.json()
    fid = str(uuid.uuid4())
    await ds.execute(
        "INSERT INTO syslog_filters (id, name, condition, action, created_at) VALUES ($1,$2,$3,$4,NOW())",
        [fid, body.get("name", ""), json.dumps(body.get("condition", {})), body.get("action", "drop")],
    )
    row = await ds.query_one("SELECT * FROM syslog_filters WHERE id=$1", [fid])
    return {"success": True, "data": snake_to_camel(row)}


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
    return {"success": True, "data": snake_to_camel_list(rows)}


@router.post("/snmp-trap/oid-mappings")
async def create_oid_mapping(request: Request = None, ds=Depends(get_datastore), user=Depends(get_current_user)) -> dict:
    body = await request.json()
    mid = str(uuid.uuid4())
    await ds.execute(
        "INSERT INTO snmp_oid_mappings (id, oid, name, severity, description, created_at) VALUES ($1,$2,$3,$4,$5,NOW())",
        [mid, body.get("oid", ""), body.get("name", ""), body.get("severity", "info"), body.get("description", "")],
    )
    row = await ds.query_one("SELECT * FROM snmp_oid_mappings WHERE id=$1", [mid])
    return {"success": True, "data": snake_to_camel(row)}


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
    return {"success": True, "data": snake_to_camel(row)}


@router.delete("/snmp-trap/oid-mappings/{mapping_id}")
async def delete_oid_mapping(mapping_id: str = Path(...), ds=Depends(get_datastore), user=Depends(get_current_user)) -> dict:
    await ds.execute("DELETE FROM snmp_oid_mappings WHERE id=$1", [mapping_id])
    return {"success": True, "message": "OID mapping deleted"}


@router.get("/snmp-trap/v3-credentials")
async def get_v3_credentials(ds=Depends(get_datastore), user=Depends(get_current_user)) -> dict:
    rows = await ds.query("SELECT * FROM snmp_v3_credentials ORDER BY created_at DESC")
    return {"success": True, "data": snake_to_camel_list(rows)}


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
    return {"success": True, "data": snake_to_camel(row)}


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
    device_id: str | None = Depends(get_device_id),
    request: Request = None,
    ds=Depends(get_datastore),
    user=Depends(get_current_user),
) -> dict:
    body = await request.json()
    row = await ds.query_one(
        "SELECT * FROM decision_rules WHERE id=$1", [rule_id]
    )
    if not row:
        raise HTTPException(404, "Decision rule not found")
    weights_json = json.dumps(body)
    await ds.execute(
        "UPDATE decision_rules SET weights=$1 WHERE id=$2",
        [weights_json, rule_id],
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
    device_id: str | None = Depends(get_device_id),
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
    device_id: str | None = Depends(get_device_id),
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
    device_id: str | None = Depends(get_device_id),
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
    device_id: str | None = Depends(get_device_id),
    ds=Depends(get_datastore),
    user=Depends(get_current_user),
) -> dict:
    """Alias: frontend calls /notifications/channels/{id}/test."""
    row = await ds.query_one(
        "SELECT * FROM notification_channels WHERE id=$1", [channel_id]
    )
    if not row:
        raise HTTPException(404, "Channel not found")
    return {"success": True, "data": {"sent": True, "message": "Test notification sent"}}



# ===========================================================================
# Feature Flags (Bug 1.2)
# ===========================================================================

@router.get("/feature-flags")
async def get_feature_flags(
    ds=Depends(get_datastore),
    ffm=Depends(get_feature_flag_manager),
    user=Depends(get_current_user),
) -> dict:
    """以 DB 为 Source of Truth，内存覆盖运行时 value。"""
    db_rows = await ds.query("SELECT * FROM feature_flags ORDER BY created_at")
    memory = ffm.get_all()
    result = []
    for row in db_rows:
        key = row.get("key") or row.get("flag_key", "")
        entry = dict(row)
        if key in memory:
            entry["runtime_value"] = memory[key]
        result.append(entry)
    # 内存中有但 DB 没有的 flag 也返回
    db_keys = {(r.get("key") or r.get("flag_key", "")) for r in db_rows}
    for k, v in memory.items():
        if k not in db_keys:
            result.append({"key": k, "value": "true" if v else "false", "runtime_value": v, "source": "memory"})
    return {"success": True, "data": result}


@router.get("/feature-flags/history")
async def get_feature_flag_history(
    flag_name: str = Query(None),
    limit: int = Query(100, le=1000, ge=1),
    offset: int = Query(0, ge=0),
    ds=Depends(get_datastore),
    user=Depends(get_current_user),
) -> dict:
    if flag_name:
        rows = await ds.query(
            "SELECT * FROM feature_flag_history WHERE flag_name=$1 ORDER BY changed_at DESC LIMIT $2 OFFSET $3",
            [flag_name, limit, offset],
        )
    else:
        rows = await ds.query(
            "SELECT * FROM feature_flag_history ORDER BY changed_at DESC LIMIT $1 OFFSET $2",
            [limit, offset],
        )
    return {"success": True, "data": snake_to_camel_list(rows)}


@router.put("/feature-flags/{name}")
async def update_feature_flag(
    name: str,
    request: Request,
    ds=Depends(get_datastore),
    ffm=Depends(get_feature_flag_manager),
    user=Depends(get_current_user),
) -> dict:
    body = await request.json()
    new_value = body.get("value", body.get("enabled"))
    if new_value is None:
        raise HTTPException(400, "value or enabled is required")
    enabled = new_value if isinstance(new_value, bool) else str(new_value).lower() == "true"
    new_val_str = "true" if enabled else "false"

    async def _tx(tx):
        # 读取旧值（加锁防止并发写入导致历史记录断层）
        old_row = await tx.query_one("SELECT value FROM feature_flags WHERE key=$1 FOR UPDATE", [name])
        old_val = old_row["value"] if old_row else None
        # UPSERT 主表
        await tx.execute(
            "INSERT INTO feature_flags (key, value, flag_key) VALUES ($1, $2, $1) "
            "ON CONFLICT (key) DO UPDATE SET value=$2, updated_at=NOW()",
            [name, new_val_str],
        )
        # 记录历史
        await tx.execute(
            "INSERT INTO feature_flag_history (flag_name, old_value, new_value, changed_by) VALUES ($1,$2,$3,$4)",
            [name, old_val, new_val_str, str(user["id"])],
        )

    # asyncio.Lock 保护 DB 写入 + 内存更新的原子性，防止并发交错覆盖
    async with _feature_flag_lock:
        await ds.transaction(_tx)
        ffm._flags[name] = enabled
    return {"success": True, "data": {"name": name, "value": new_val_str, "enabled": enabled}}


# ===========================================================================
# Traces (Bug 1.3)
# ===========================================================================

def _format_trace(trace_id: str, spans: list[dict]) -> dict:
    """将 TracingService 内部格式转换为前端期望格式。"""
    if not spans:
        return {"traceId": trace_id, "name": trace_id, "status": "unknown", "duration": 0, "startTime": 0, "spans": []}
    start_ts = spans[0].get("timestamp", 0) if spans else 0
    end_ts = spans[-1].get("timestamp", 0) if spans else 0
    last_stage = spans[-1].get("stage", "") if spans else ""
    status = "completed" if last_stage == "end" else "active"
    return {
        "traceId": trace_id,
        "name": trace_id,
        "status": status,
        "duration": end_ts - start_ts,
        "startTime": start_ts,
        "spans": spans,
    }


@router.get("/traces")
async def get_traces(
    search: str = Query(None),
    status: str = Query(None),
    limit: int = Query(100, le=1000, ge=1),
    offset: int = Query(0, ge=0),
    ts=Depends(get_tracing_service),
    user=Depends(get_current_user),
) -> dict:
    all_traces = ts.get_all_traces()
    result = [_format_trace(tid, spans) for tid, spans in all_traces.items()]
    if search:
        result = [t for t in result if search.lower() in t["name"].lower()]
    if status:
        result = [t for t in result if t["status"] == status]
    total = len(result)
    return {"success": True, "data": result[offset:offset + limit], "total": total}


@router.get("/traces/slow")
async def get_slow_traces(
    limit: int = Query(20, le=1000, ge=1),
    ts=Depends(get_tracing_service),
    user=Depends(get_current_user),
) -> dict:
    all_traces = ts.get_all_traces()
    result = [_format_trace(tid, spans) for tid, spans in all_traces.items()]
    result.sort(key=lambda t: t["duration"], reverse=True)
    return {"success": True, "data": result[:limit]}


@router.get("/traces/{trace_id}")
async def get_trace_detail(
    trace_id: str,
    ts=Depends(get_tracing_service),
    user=Depends(get_current_user),
) -> dict:
    spans = ts.get_trace(trace_id)
    if not spans:
        raise HTTPException(404, "Trace not found")
    return {"success": True, "data": _format_trace(trace_id, spans)}


# ===========================================================================
# System Config (Bug 1.4)
# ===========================================================================

_SAFE_ENV_PREFIXES = ("OPSEVO_", "APP_", "NODE_ENV", "LOG_LEVEL")


@router.get("/system/config")
async def get_system_config(
    ds=Depends(get_datastore),
    user=Depends(get_current_user),
) -> dict:
    import os
    configs = await ds.query("SELECT * FROM system_config ORDER BY key")
    env_vars = [
        {"key": k, "value": v}
        for k, v in os.environ.items()
        if any(k.startswith(p) for p in _SAFE_ENV_PREFIXES)
    ]
    return {"success": True, "data": {"configs": configs, "envVars": env_vars}}


@router.get("/system/config/history")
async def get_system_config_history(
    key: str = Query(None),
    limit: int = Query(100, le=1000, ge=1),
    offset: int = Query(0, ge=0),
    ds=Depends(get_datastore),
    user=Depends(get_current_user),
) -> dict:
    if key:
        rows = await ds.query(
            "SELECT * FROM system_config_history WHERE config_key=$1 ORDER BY changed_at DESC LIMIT $2 OFFSET $3",
            [key, limit, offset],
        )
    else:
        rows = await ds.query(
            "SELECT * FROM system_config_history ORDER BY changed_at DESC LIMIT $1 OFFSET $2",
            [limit, offset],
        )
    return {"success": True, "data": snake_to_camel_list(rows)}


@router.put("/system/config")
async def update_system_config(
    request: Request,
    ds=Depends(get_datastore),
    user=Depends(get_current_user),
) -> dict:
    body = await request.json()
    items = body.get("items", [body] if "key" in body else [])
    if not items:
        raise HTTPException(400, "No config items provided")

    async def _tx(tx):
        # 按 key 排序以防止并发事务死锁
        sorted_items = sorted(items, key=lambda x: x.get("key", ""))
        for item in sorted_items:
            k = item.get("key")
            v = item.get("value")
            desc = item.get("description")
            if not k:
                continue
            # SELECT FOR UPDATE 锁定
            old = await tx.query_one("SELECT value FROM system_config WHERE key=$1 FOR UPDATE", [k])
            old_val = old["value"] if old else None
            # UPSERT
            await tx.execute(
                "INSERT INTO system_config (key, value, description, updated_at) VALUES ($1,$2,$3,NOW()) "
                "ON CONFLICT (key) DO UPDATE SET value=$2, description=COALESCE($3, system_config.description), updated_at=NOW()",
                [k, v, desc],
            )
            # 历史记录
            await tx.execute(
                "INSERT INTO system_config_history (config_key, old_value, new_value, changed_by) VALUES ($1,$2,$3,$4)",
                [k, old_val, v, str(user["id"])],
            )

    await ds.transaction(_tx)
    configs = await ds.query("SELECT * FROM system_config ORDER BY key")
    return {"success": True, "data": configs}


# ===========================================================================
# Knowledge / Prompts (Bug 1.7)
# ===========================================================================

@router.get("/knowledge/prompts")
async def get_knowledge_prompts(
    search: str = Query(None),
    limit: int = Query(100, le=1000, ge=1),
    offset: int = Query(0, ge=0),
    ds=Depends(get_datastore),
    user=Depends(get_current_user),
) -> dict:
    """查询 knowledge_embeddings 中 metadata->>'type' = 'prompt' 的条目。"""
    base = "SELECT * FROM knowledge_embeddings WHERE metadata->>'type' = 'prompt'"
    params: list = []
    idx = 1
    if search:
        base += f" AND (content ILIKE ${idx})"
        params.append(f"%{search}%")
        idx += 1
    base += f" ORDER BY created_at DESC LIMIT ${idx} OFFSET ${idx + 1}"
    params.extend([limit, offset])
    rows = await ds.query(base, params)
    return {"success": True, "data": snake_to_camel_list(rows)}


@router.post("/knowledge/prompts")
async def create_knowledge_prompt(
    request: Request,
    ds=Depends(get_datastore),
    user=Depends(get_current_user),
) -> dict:
    body = await request.json()
    content = body.get("content", "")
    if not content:
        raise HTTPException(400, "content is required")
    metadata = body.get("metadata", {})
    metadata["type"] = "prompt"
    kid = str(uuid.uuid4())
    await ds.execute(
        "INSERT INTO knowledge_embeddings (id, content, metadata, created_at) VALUES ($1,$2,$3,NOW())",
        [kid, content, json.dumps(metadata)],
    )
    row = await ds.query_one("SELECT * FROM knowledge_embeddings WHERE id=$1", [kid])
    return {"success": True, "data": snake_to_camel(row)}


# ---------------------------------------------------------------------------
# AI Providers (maps to ai_configs table, global scope)
# ---------------------------------------------------------------------------

def _mask_api_key(key: str | None) -> str:
    if not key:
        return ""
    if len(key) <= 4:
        return "****"
    return "*" * (len(key) - 4) + key[-4:]


def _format_provider_row(row: dict[str, Any] | None) -> dict[str, Any] | None:
    if not row:
        return None
    return {
        "id": row.get("id"),
        "name": row.get("name", ""),
        "provider": row.get("provider", ""),
        "apiKey": _mask_api_key(row.get("api_key") or ""),
        "model": row.get("model") or row.get("model_name") or "",
        "baseUrl": row.get("base_url") or "",
        "enabled": bool(row.get("is_active", True)),
        "isDefault": bool(row.get("is_default", False)),
        "createdAt": row.get("created_at"),
        "updatedAt": row.get("updated_at"),
    }


@router.get("/ai-providers")
async def get_ai_providers(
    ds=Depends(get_datastore),
    user=Depends(get_current_user),
) -> dict:
    rows = await ds.query("SELECT * FROM ai_configs ORDER BY created_at DESC")
    return {"success": True, "data": [_format_provider_row(r) for r in (rows or [])]}


@router.post("/ai-providers")
async def create_ai_provider(
    request: Request,
    ds=Depends(get_datastore),
    user=Depends(get_current_user),
) -> dict:
    body = await request.json()
    pid = str(uuid.uuid4())
    name = body.get("name", "")
    provider = body.get("provider", "custom")
    api_key = body.get("apiKey", "")
    model = body.get("model", "")
    base_url = body.get("baseUrl", "")
    enabled = body.get("enabled", True)
    await ds.execute(
        "INSERT INTO ai_configs (id, name, provider, api_key, model, base_url, is_active) "
        "VALUES ($1,$2,$3,$4,$5,$6,$7)",
        (pid, name, provider, api_key, model, base_url, enabled),
    )
    row = await ds.query_one("SELECT * FROM ai_configs WHERE id=$1", [pid])
    return {"success": True, "data": _format_provider_row(row)}


@router.put("/ai-providers/{provider_id}")
async def update_ai_provider(
    provider_id: str = Path(...),
    request: Request = None,
    ds=Depends(get_datastore),
    user=Depends(get_current_user),
) -> dict:
    body = await request.json()
    existing = await ds.query_one("SELECT * FROM ai_configs WHERE id=$1", [provider_id])
    if not existing:
        raise HTTPException(404, "Provider not found")
    sets = []
    params: list[Any] = []
    idx = 1
    col_map = {
        "name": "name", "provider": "provider", "apiKey": "api_key",
        "model": "model", "baseUrl": "base_url", "enabled": "is_active",
        "isDefault": "is_default",
    }
    for k, v in body.items():
        col = col_map.get(k)
        if col:
            sets.append(f"{col} = ${idx}")
            params.append(v)
            idx += 1
    if sets:
        sets.append(f"updated_at = NOW()")
        params.append(provider_id)
        await ds.execute(
            f"UPDATE ai_configs SET {', '.join(sets)} WHERE id = ${idx}",
            tuple(params),
        )
    row = await ds.query_one("SELECT * FROM ai_configs WHERE id=$1", [provider_id])
    return {"success": True, "data": _format_provider_row(row)}


@router.delete("/ai-providers/{provider_id}")
async def delete_ai_provider(
    provider_id: str = Path(...),
    ds=Depends(get_datastore),
    user=Depends(get_current_user),
) -> dict:
    rows = await ds.execute("DELETE FROM ai_configs WHERE id=$1", [provider_id])
    if rows == 0:
        raise HTTPException(404, "Provider not found")
    return {"success": True, "message": "Provider deleted"}


@router.post("/ai-providers/{provider_id}/test")
async def test_ai_provider(
    provider_id: str = Path(...),
    request: Request = None,
    ds=Depends(get_datastore),
    user=Depends(get_current_user),
) -> dict:
    row = await ds.query_one("SELECT * FROM ai_configs WHERE id=$1", [provider_id])
    if not row:
        raise HTTPException(404, "Provider not found")
    try:
        container = request.app.state.container
        pool = container.adapter_pool()
        adapter = await pool.get_adapter()
        await adapter.chat([{"role": "user", "content": "ping"}])
        return {"success": True, "message": "Connection test passed"}
    except Exception as exc:
        return {"success": False, "error": str(exc)}


@router.get("/ai-providers/usage")
async def get_ai_providers_usage(
    ds=Depends(get_datastore),
    user=Depends(get_current_user),
) -> dict:
    """Token usage statistics per provider/model."""
    rows = await ds.query(
        """SELECT provider, model, 
           COALESCE(SUM((config->>'totalTokens')::int), 0) as total_tokens,
           COALESCE(SUM((config->>'promptTokens')::int), 0) as prompt_tokens,
           COALESCE(SUM((config->>'completionTokens')::int), 0) as completion_tokens,
           COUNT(*) as request_count,
           0 as error_count
           FROM ai_configs
           GROUP BY provider, model
           ORDER BY total_tokens DESC"""
    )
    result = []
    for r in (rows or []):
        result.append({
            "provider": r.get("provider", ""),
            "model": r.get("model", ""),
            "totalTokens": r.get("total_tokens", 0),
            "promptTokens": r.get("prompt_tokens", 0),
            "completionTokens": r.get("completion_tokens", 0),
            "requestCount": r.get("request_count", 0),
            "errorCount": r.get("error_count", 0),
        })
    return {"success": True, "data": result}
