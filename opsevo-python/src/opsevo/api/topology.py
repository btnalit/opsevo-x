"""
Topology API 路由
/api/topology/* 端点

接入 TopologyDiscoveryService 真实逻辑。
Topology 是全局服务（跨设备网络拓扑），不绑定特定 device_id。
"""

from __future__ import annotations

import asyncio
import json
from dataclasses import asdict
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from fastapi.responses import StreamingResponse

from .deps import get_current_user, get_datastore

router = APIRouter(prefix="/api/topology", tags=["topology"])


def _get_topology_service(request: Request):
    return request.app.state.container.topology_discovery()


# ---------------------------------------------------------------------------
# GET /topology — 获取当前完整拓扑图
# ---------------------------------------------------------------------------
@router.get("")
async def get_topology_graph(
    request: Request,
    user=Depends(get_current_user),
) -> dict:
    svc = _get_topology_service(request)
    graph = svc.get_topology_graph()
    nodes = [asdict(n) for n in graph.nodes.values()]
    edges = [asdict(e) for e in graph.edges.values()]
    return {
        "success": True,
        "data": {
            "nodes": nodes,
            "edges": edges,
            "version": graph.version,
            "lastUpdatedAt": graph.last_updated_at,
        },
    }


# ---------------------------------------------------------------------------
# GET /topology/diff — 获取最近 N 条差分历史
# ---------------------------------------------------------------------------
@router.get("/diff")
async def get_diff_history(
    request: Request,
    limit: int = Query(20),
    user=Depends(get_current_user),
) -> dict:
    svc = _get_topology_service(request)
    diffs = svc.get_diff_history(limit=limit)
    return {"success": True, "data": [asdict(d) for d in diffs]}


# ---------------------------------------------------------------------------
# POST /topology/discover — 手动触发完整发现
# ---------------------------------------------------------------------------
@router.post("/discover")
async def trigger_full_discovery(
    request: Request,
    user=Depends(get_current_user),
) -> dict:
    svc = _get_topology_service(request)
    await svc.trigger_full_discovery()
    return {"success": True, "message": "Discovery triggered"}


# ---------------------------------------------------------------------------
# GET /topology/stats — 获取发现统计信息
# ---------------------------------------------------------------------------
@router.get("/stats")
async def get_topology_stats(
    request: Request,
    user=Depends(get_current_user),
) -> dict:
    svc = _get_topology_service(request)
    stats = svc.get_stats()
    return {"success": True, "data": asdict(stats)}


# ---------------------------------------------------------------------------
# GET /topology/config — 获取当前配置
# ---------------------------------------------------------------------------
@router.get("/config")
async def get_topology_config(
    request: Request,
    user=Depends(get_current_user),
) -> dict:
    svc = _get_topology_service(request)
    cfg = svc.get_config()
    return {"success": True, "data": asdict(cfg)}


# ---------------------------------------------------------------------------
# PUT /topology/config — 更新配置
# ---------------------------------------------------------------------------
@router.put("/config")
async def update_topology_config(
    request: Request,
    user=Depends(get_current_user),
) -> dict:
    body = await request.json()
    svc = _get_topology_service(request)

    # Validate numeric fields
    numeric_fields = [
        "fastPollIntervalMs", "mediumPollIntervalMs", "slowPollIntervalMs",
        "dampeningTimerMs", "slidingWindowSize", "staleExpiryMs",
        "infraConfirmCount", "infraStaleThresholdCount",
        "endpointConfirmCount", "endpointStaleThresholdCount",
        "criticalEdgeLossThreshold", "maxConcurrentDeviceQueries",
    ]
    for field in numeric_fields:
        if field in body:
            val = body[field]
            if not isinstance(val, (int, float)) or val <= 0:
                raise HTTPException(400, f"{field} must be a positive number")

    fast = body.get("fastPollIntervalMs", 10000)
    medium = body.get("mediumPollIntervalMs", 30000)
    slow = body.get("slowPollIntervalMs", 60000)
    if fast > medium or medium > slow:
        raise HTTPException(400, "Poll intervals must satisfy: fast ≤ medium ≤ slow")

    # Convert camelCase to snake_case for service
    snake_updates = {}
    camel_to_snake = {
        "fastPollIntervalMs": "fast_poll_interval_ms",
        "mediumPollIntervalMs": "medium_poll_interval_ms",
        "slowPollIntervalMs": "slow_poll_interval_ms",
        "dampeningTimerMs": "dampening_timer_ms",
        "slidingWindowSize": "sliding_window_size",
        "staleExpiryMs": "stale_expiry_ms",
        "infraConfirmCount": "infra_confirm_count",
        "infraStaleThresholdCount": "infra_stale_threshold_count",
        "endpointConfirmCount": "endpoint_confirm_count",
        "endpointStaleThresholdCount": "endpoint_stale_threshold_count",
        "criticalEdgeLossThreshold": "critical_edge_loss_threshold",
        "maxConcurrentDeviceQueries": "max_concurrent_device_queries",
        "enabled": "enabled",
        "enabledSources": "enabled_sources",
        "endpointDiscoveryEnabled": "endpoint_discovery_enabled",
    }
    for k, v in body.items():
        snake_key = camel_to_snake.get(k, k)
        snake_updates[snake_key] = v

    await svc.update_config(**snake_updates)
    cfg = svc.get_config()
    return {"success": True, "data": asdict(cfg)}


# ---------------------------------------------------------------------------
# GET /topology/stream — SSE 事件流
# ---------------------------------------------------------------------------
@router.get("/stream")
async def topology_stream(
    request: Request,
    user=Depends(get_current_user),
) -> StreamingResponse:
    svc = _get_topology_service(request)

    async def event_generator():
        # Send initial state
        graph = svc.get_topology_graph()
        nodes = [asdict(n) for n in graph.nodes.values()]
        edges = [asdict(e) for e in graph.edges.values()]
        yield f"data: {json.dumps({'type': 'snapshot', 'nodes': nodes, 'edges': edges, 'version': graph.version})}\n\n"
        try:
            last_version = graph.version
            while True:
                await asyncio.sleep(5)
                current = svc.get_topology_graph()
                if current.version != last_version:
                    nodes = [asdict(n) for n in current.nodes.values()]
                    edges = [asdict(e) for e in current.edges.values()]
                    yield f"data: {json.dumps({'type': 'update', 'nodes': nodes, 'edges': edges, 'version': current.version})}\n\n"
                    last_version = current.version
                else:
                    yield f"data: {json.dumps({'type': 'heartbeat'})}\n\n"
        except asyncio.CancelledError:
            return

    return StreamingResponse(
        event_generator(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "Connection": "keep-alive"},
    )
