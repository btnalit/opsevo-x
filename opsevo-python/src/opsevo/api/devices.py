"""Devices API routes.

GET    /api/devices
POST   /api/devices
GET    /api/devices/summary
GET    /api/devices/orchestrator/status
GET    /api/devices/events/stream
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

Requirements: 3.1, 10.1, 6.1, 6.2
"""

from __future__ import annotations

import asyncio
import json

from fastapi import APIRouter, Depends, HTTPException, Request, status
from fastapi.responses import StreamingResponse

from opsevo.api.deps import get_current_user
from opsevo.api.dependencies import get_device_orchestrator
from opsevo.drivers.types import DeviceConnectionConfig
from opsevo.events.types import EventType, PerceptionEvent
from opsevo.models.common import MessageResponse, SuccessResponse
from opsevo.models.device import DeviceCreate, DeviceResponse, DeviceUpdate
from opsevo.utils.logger import get_logger

logger = get_logger(__name__)

router = APIRouter(prefix="/api/devices", tags=["devices"])


def _get_device_manager(request: Request):
    return request.app.state.container.device_manager()


def _get_device_pool(request: Request):
    return request.app.state.container.device_pool()


async def _resolve_driver(request: Request, device_id: str):
    """Resolve device_id → connected DeviceDriver via DevicePool.

    Follows the same pattern as device_context.py middleware:
    fetch device record → build DeviceConnectionConfig → get/create driver.
    """
    dm = _get_device_manager(request)
    pool = _get_device_pool(request)

    device = await dm.get_device(device_id)
    if not device:
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail=f"Device {device_id} not found")

    profile_name = device.get("profile_id", "")
    if not profile_name:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, detail="Device has no profile_id")

    config = DeviceConnectionConfig(
        host=device.get("host", ""),
        port=device.get("port", 443),
        username=device.get("username", ""),
        password=device.get("password", ""),
        use_tls=device.get("use_tls", False),
        timeout=device.get("timeout", 30000),
        driver_type=device.get("driver_type", "api"),
        profile_name=profile_name,
    )

    driver = await pool.get_driver(device_id, config, profile_name)
    return driver, config


@router.get("")
async def list_devices(
    request: Request,
    user: dict = Depends(get_current_user),
):
    dm = _get_device_manager(request)
    devices = await dm.list_devices(tenant_id=str(user["id"]))
    return SuccessResponse(data=devices).model_dump()


@router.get("/summary")
async def get_device_summary(
    orchestrator=Depends(get_device_orchestrator),
    user: dict = Depends(get_current_user),
):
    """GET /api/devices/summary — 设备聚合摘要（来自 DeviceOrchestrator）。"""
    summary = orchestrator.get_device_summary()
    return {
        "success": True,
        "data": {
            "total": summary.total,
            "online": summary.online,
            "offline": summary.offline,
            "connecting": summary.connecting,
            "avg_health_score": summary.avg_health_score,
        },
    }


@router.get("/orchestrator/status")
async def get_orchestrator_status(
    orchestrator=Depends(get_device_orchestrator),
    user: dict = Depends(get_current_user),
):
    """GET /api/devices/orchestrator/status — 编排器运行状态。"""
    return {"success": True, "data": orchestrator.get_status()}


# 需要订阅的设备生命周期事件类型
_DEVICE_EVENT_TYPES = (
    EventType.DEVICE_ADDED,
    EventType.DEVICE_REMOVED,
    EventType.DEVICE_ONLINE,
    EventType.DEVICE_OFFLINE,
    EventType.DEVICE_HEALTH_CHANGED,
    EventType.ORCHESTRATOR_READY,
)


@router.get("/events/stream")
async def stream_device_events(
    request: Request,
    user: dict = Depends(get_current_user),
):
    """SSE 端点：推送设备生命周期事件。"""
    event_bus = request.app.state.container.event_bus()
    queue: asyncio.Queue[PerceptionEvent | None] = asyncio.Queue(maxsize=256)
    _overflow = False  # 标记队列溢出，通知生成器停止

    async def _on_event(event: PerceptionEvent) -> None:
        nonlocal _overflow
        if _overflow:
            return  # 已溢出，不再入队
        try:
            queue.put_nowait(event)
        except asyncio.QueueFull:
            # 队列满说明客户端消费太慢，放入哨兵值通知生成器断开
            _overflow = True
            logger.warning("sse_queue_full_disconnecting")
            try:
                queue.get_nowait()  # 腾出一个位置
            except asyncio.QueueEmpty:
                pass
            try:
                queue.put_nowait(None)  # 哨兵值
            except asyncio.QueueFull:
                pass

    async def _generate():
        # 订阅移入生成器内部，确保 finally 一定能配对清理
        for et in _DEVICE_EVENT_TYPES:
            event_bus.subscribe(et, _on_event)
        try:
            yield f"data: {json.dumps({'type': 'connected'})}\n\n"
            while True:
                try:
                    event = await asyncio.wait_for(queue.get(), timeout=30.0)
                    if event is None:
                        # 哨兵值：队列溢出，断开连接迫使前端重连并全量拉取
                        break
                    payload = {
                        "type": event.type.value,
                        **(event.payload or {}),
                    }
                    yield f"data: {json.dumps(payload, default=str)}\n\n"
                except asyncio.TimeoutError:
                    # keep-alive ping
                    yield f"data: {json.dumps({'type': 'ping'})}\n\n"
        except asyncio.CancelledError:
            pass
        finally:
            for et in _DEVICE_EVENT_TYPES:
                event_bus.unsubscribe(et, _on_event)

    return StreamingResponse(
        _generate(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


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
    orchestrator=Depends(get_device_orchestrator),
    user: dict = Depends(get_current_user),
):
    try:
        success = await orchestrator.connect_device_manual(device_id)
        if not success:
            return {"success": False, "error": "Connection failed"}
        dm = _get_device_manager(request)
        device = await dm.get_device(device_id)
        return SuccessResponse(data=device).model_dump()
    except KeyError as exc:
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail=str(exc))
    except Exception as exc:
        return {"success": False, "error": str(exc)}


@router.post("/{device_id}/disconnect")
async def disconnect_device(
    device_id: str,
    request: Request,
    orchestrator=Depends(get_device_orchestrator),
    user: dict = Depends(get_current_user),
):
    try:
        await orchestrator.disconnect_device_manual(device_id)
        dm = _get_device_manager(request)
        device = await dm.get_device(device_id)
        return SuccessResponse(data=device).model_dump()
    except KeyError as exc:
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail=str(exc))
    except Exception as exc:
        return {"success": False, "error": str(exc)}


@router.post("/{device_id}/test-connection")
async def test_device_connection_alias(
    device_id: str,
    request: Request,
    user: dict = Depends(get_current_user),
):
    """Alias for /test to match frontend deviceApi.testConnection()."""
    try:
        driver, _ = await _resolve_driver(request, device_id)
        result = await driver.health_check()
        return SuccessResponse(data=result.model_dump()).model_dump()
    except HTTPException:
        raise
    except Exception as exc:
        return {"success": False, "error": str(exc)}


@router.post("/{device_id}/test")
async def test_device_connection(
    device_id: str,
    request: Request,
    user: dict = Depends(get_current_user),
):
    try:
        driver, _ = await _resolve_driver(request, device_id)
        result = await driver.health_check()
        return SuccessResponse(data=result.model_dump()).model_dump()
    except HTTPException:
        raise
    except Exception as exc:
        return {"success": False, "error": str(exc)}


@router.get("/{device_id}/metrics")
async def get_device_metrics(
    device_id: str,
    request: Request,
    user: dict = Depends(get_current_user),
):
    """GET /api/devices/{device_id}/metrics — frontend deviceApi.getMetrics()."""
    try:
        driver, _ = await _resolve_driver(request, device_id)
        metrics = await driver.collect_metrics()
        return SuccessResponse(data=metrics.model_dump()).model_dump()
    except HTTPException:
        raise
    except Exception as exc:
        return {"success": False, "error": str(exc)}


@router.get("/{device_id}/health")
async def get_device_health(
    device_id: str,
    request: Request,
    user: dict = Depends(get_current_user),
):
    """GET /api/devices/{device_id}/health — frontend deviceApi.getHealth()."""
    try:
        driver, _ = await _resolve_driver(request, device_id)
        result = await driver.health_check()
        return SuccessResponse(data=result.model_dump()).model_dump()
    except HTTPException:
        raise
    except Exception as exc:
        return {"success": False, "error": str(exc)}


@router.post("/{device_id}/execute")
async def execute_device_command(
    device_id: str,
    request: Request,
    user: dict = Depends(get_current_user),
):
    """POST /api/devices/{device_id}/execute — frontend deviceApi.execute()."""
    body = await request.json()
    command = body.get("command", "")
    params = body.get("params", {})
    try:
        driver, _ = await _resolve_driver(request, device_id)
        result = await driver.execute(command, params)
        return SuccessResponse(data=result.data if hasattr(result, "data") else result).model_dump()
    except HTTPException:
        raise
    except Exception as exc:
        return {"success": False, "error": str(exc)}
