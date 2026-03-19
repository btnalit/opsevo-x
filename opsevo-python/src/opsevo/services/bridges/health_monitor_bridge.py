"""
HealthMonitorBridge — HealthMonitor → EventBus 桥接

定期从 HealthMonitor 获取指标快照，转换为 PerceptionEvent 注入 EventBus。
健康评分低于阈值时额外生成 internal 告警事件。
"""

from __future__ import annotations

import asyncio
from typing import Any

import structlog

from opsevo.events.event_bus import EventBus
from opsevo.events.types import EventType, PerceptionEvent, Priority

logger = structlog.get_logger(__name__)


class HealthMonitorBridge:
    """HealthMonitor → EventBus 桥接器。"""

    def __init__(
        self,
        event_bus: EventBus,
        health_monitor: Any,
        collect_interval_ms: int = 60_000,
        alert_score_threshold: int = 60,
        enabled: bool = True,
    ) -> None:
        self._event_bus = event_bus
        self._health_monitor = health_monitor
        self._collect_interval = collect_interval_ms / 1000
        self._alert_threshold = alert_score_threshold
        self._enabled = enabled
        self._task: asyncio.Task[None] | None = None
        self._running = False

    def start(self) -> None:
        if self._running:
            return
        if not self._enabled:
            logger.debug("HealthMonitorBridge disabled")
            return
        self._event_bus.register_source(
            "health-monitor-bridge",
            {"event_types": ["metric", "internal"], "schema_version": "1.0.0"},
        )
        self._running = True
        self._task = asyncio.create_task(self._loop())
        logger.info("HealthMonitorBridge started")

    def stop(self) -> None:
        self._running = False
        if self._task and not self._task.done():
            self._task.cancel()
        logger.info("HealthMonitorBridge stopped")

    async def publish_once(self, device_id: str | None = None) -> None:
        try:
            metrics = await self._health_monitor.collect_metrics()
            score = self._health_monitor.calculate_score(metrics)
            await self._publish_metric(metrics, score, device_id)
            overall = score.get("overall", 100) if isinstance(score, dict) else getattr(score, "overall", 100)
            if overall < self._alert_threshold:
                await self._publish_health_alert(metrics, score, device_id)
        except Exception as exc:
            logger.warn("HealthMonitorBridge publish failed", error=str(exc))

    async def _loop(self) -> None:
        while self._running:
            await self.publish_once()
            await asyncio.sleep(self._collect_interval)

    async def _publish_metric(
        self, metrics: Any, score: Any, device_id: str | None
    ) -> None:
        overall = score.get("overall", 100) if isinstance(score, dict) else getattr(score, "overall", 100)
        priority = self._score_to_priority(overall)
        payload: dict[str, Any] = {}
        if isinstance(metrics, dict):
            payload = dict(metrics)
        else:
            for attr in ("cpu_usage", "memory_usage", "disk_usage", "error_rate"):
                if hasattr(metrics, attr):
                    payload[attr] = getattr(metrics, attr)
        payload["score"] = overall
        event = PerceptionEvent(
            type=EventType.METRIC,
            priority=priority,
            source="health-monitor-bridge",
            payload=payload,
            schema_version="1.0.0",
        )
        if device_id:
            event.payload["device_id"] = device_id
        await self._event_bus.publish(event)

    async def _publish_health_alert(
        self, metrics: Any, score: Any, device_id: str | None
    ) -> None:
        overall = score.get("overall", 100) if isinstance(score, dict) else getattr(score, "overall", 100)
        if overall < 30:
            priority = Priority.CRITICAL
        elif overall < 50:
            priority = Priority.HIGH
        else:
            priority = Priority.MEDIUM
        payload: dict[str, Any] = {"alert_type": "low_health_score", "score": overall}
        event = PerceptionEvent(
            type=EventType.INTERNAL,
            priority=priority,
            source="health-monitor-bridge",
            payload=payload,
            schema_version="1.0.0",
        )
        if device_id:
            event.payload["device_id"] = device_id
        await self._event_bus.publish(event)

    @staticmethod
    def _score_to_priority(score: float) -> Priority:
        if score >= 80:
            return Priority.INFO
        if score >= 60:
            return Priority.LOW
        if score >= 40:
            return Priority.MEDIUM
        if score >= 20:
            return Priority.HIGH
        return Priority.CRITICAL
