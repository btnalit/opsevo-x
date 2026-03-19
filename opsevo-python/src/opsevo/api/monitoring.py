"""Monitoring API routes.

GET /api/monitoring/status   — 聚合所有设备健康概览
GET /api/monitoring/overview — 同上（别名）
GET /api/devices/{device_id}/monitoring/metrics

Requirements: 3.1, 9.4
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, Request

from opsevo.api.deps import get_current_user
from opsevo.data.datastore import DataStore
from opsevo.utils.logger import get_logger

logger = get_logger(__name__)
router = APIRouter(tags=["monitoring"])


async def _build_overview(request: Request, user: dict) -> dict:
    """Build multi-device health overview (mirrors TS monitoringController.getOverview)."""
    container = request.app.state.container
    dm = container.device_manager()
    pool = container.device_pool()
    ds: DataStore = container.datastore()
    tenant_id = str(user["id"])

    devices = await dm.list_devices(tenant_id=tenant_id)

    device_overviews = []
    total_active_alerts = 0

    for dev in devices:
        did = dev.get("id") or dev.get("device_id", "")

        # Active alert count
        active_alert_count = 0
        try:
            row = await ds.query_one(
                "SELECT count(*) as count FROM alert_events WHERE tenant_id = $1 AND device_id = $2 AND status = 'active'",
                (tenant_id, did),
            )
            active_alert_count = row["count"] if row else 0
        except Exception as exc:
            logger.warning("monitoring_alert_query_failed", device_id=did, error=str(exc))
        total_active_alerts += active_alert_count

        # Latest health metrics
        latest_metrics = None
        try:
            rows = await ds.query(
                "SELECT metric_name, metric_value, collected_at FROM health_metrics "
                "WHERE tenant_id = $1 AND device_id = $2 "
                "AND metric_name IN ('cpu_usage', 'memory_usage', 'disk_usage') "
                "ORDER BY collected_at DESC LIMIT 3",
                (tenant_id, did),
            )
            if rows:
                latest_metrics = {"collectedAt": rows[0].get("collected_at")}
                for r in rows:
                    name = r.get("metric_name", "")
                    if name == "cpu_usage":
                        latest_metrics["cpuUsage"] = r["metric_value"]
                    elif name == "memory_usage":
                        latest_metrics["memoryUsage"] = r["metric_value"]
                    elif name == "disk_usage":
                        latest_metrics["diskUsage"] = r["metric_value"]
        except Exception as exc:
            logger.warning("monitoring_metrics_query_failed", device_id=did, error=str(exc))

        # Pool status
        pool_status = "not_in_pool"
        try:
            driver = await pool.get_driver(did)
            pool_status = "connected"
        except Exception:
            pool_status = "disconnected"

        device_overviews.append({
            "deviceId": did,
            "name": dev.get("name", ""),
            "host": dev.get("host", ""),
            "status": dev.get("status", "offline"),
            "lastSeen": dev.get("last_seen"),
            "errorMessage": dev.get("error_message"),
            "poolStatus": pool_status,
            "activeAlertCount": active_alert_count,
            "latestMetrics": latest_metrics,
        })

    online = sum(1 for d in devices if d.get("status") == "online")
    offline = sum(1 for d in devices if d.get("status") == "offline")
    error = sum(1 for d in devices if d.get("status") == "error")
    connecting = sum(1 for d in devices if d.get("status") == "connecting")

    return {
        "totalDevices": len(devices),
        "onlineCount": online,
        "offlineCount": offline,
        "errorCount": error,
        "connectingCount": connecting,
        "totalActiveAlerts": total_active_alerts,
        "devices": device_overviews,
    }


@router.get("/api/monitoring/status")
async def monitoring_status(
    request: Request,
    user: dict = Depends(get_current_user),
):
    try:
        overview = await _build_overview(request, user)
        return {"success": True, "data": overview}
    except Exception as exc:
        logger.error("monitoring_status_error", error=str(exc))
        return {"success": False, "error": str(exc)}


@router.get("/api/monitoring/overview")
async def monitoring_overview(
    request: Request,
    user: dict = Depends(get_current_user),
):
    try:
        overview = await _build_overview(request, user)
        return overview
    except Exception as exc:
        logger.error("monitoring_overview_error", error=str(exc))
        return {"error": "服务器内部错误", "code": "INTERNAL_ERROR"}


@router.get("/api/devices/{device_id}/monitoring/metrics")
async def device_metrics(
    device_id: str,
    request: Request,
    user: dict = Depends(get_current_user),
):
    pool = request.app.state.container.device_pool()
    try:
        driver = await pool.get_driver(device_id)
        metrics = await driver.collect_metrics()
        return {"success": True, "data": metrics.model_dump()}
    except Exception as exc:
        return {"success": False, "error": str(exc)}
