"""
AlertEngineBridge — AlertEngine → EventBus 桥接

将 AlertEngine 触发的告警事件转换为 PerceptionEvent 注入 EventBus。
"""

from __future__ import annotations

from typing import Any

import structlog

from opsevo.events.event_bus import EventBus
from opsevo.events.types import EventType, PerceptionEvent, Priority

logger = structlog.get_logger(__name__)


class AlertEngineBridge:
    """AlertEngine → EventBus 桥接器。"""

    def __init__(
        self,
        event_bus: EventBus,
        alert_engine: Any,
        enabled: bool = True,
    ) -> None:
        self._event_bus = event_bus
        self._alert_engine = alert_engine
        self._enabled = enabled
        self._started = False

    def start(self) -> None:
        if self._started:
            return
        if not self._enabled:
            logger.debug("AlertEngineBridge disabled")
            return
        self._event_bus.register_source(
            "alert-engine-bridge",
            {"event_types": ["alert"], "schema_version": "1.0.0"},
        )
        # 注册回调到 AlertEngine
        if hasattr(self._alert_engine, "on_preprocessed_event"):
            self._alert_engine.on_preprocessed_event(self._on_event)
        self._started = True
        logger.info("AlertEngineBridge started")

    def stop(self) -> None:
        if not self._started:
            return
        if hasattr(self._alert_engine, "off_preprocessed_event"):
            self._alert_engine.off_preprocessed_event(self._on_event)
        self._started = False
        logger.info("AlertEngineBridge stopped")

    async def _on_event(self, event: dict[str, Any]) -> None:
        try:
            await self._publish_alert(event)
        except Exception as exc:
            logger.warn("AlertEngineBridge publish failed", error=str(exc))

    async def _publish_alert(self, event: dict[str, Any]) -> None:
        severity = event.get("severity", "info")
        priority = self._severity_to_priority(severity)
        payload: dict[str, Any] = {
            "unified_event_id": event.get("id"),
            "source": event.get("source"),
            "category": event.get("category"),
            "severity": severity,
            "message": event.get("message"),
            "metadata": event.get("metadata"),
        }
        # 告警规则信息
        rule_info = event.get("alert_rule_info") or event.get("alertRuleInfo")
        if rule_info:
            payload["rule_id"] = rule_info.get("ruleId")
            payload["rule_name"] = rule_info.get("ruleName")
        # 设备信息
        device_info = event.get("device_info") or event.get("deviceInfo")
        if device_info:
            payload["device_name"] = device_info.get("hostname")
            payload["device_ip"] = device_info.get("ip")
        # 复合事件
        if event.get("is_composite") or event.get("isComposite"):
            payload["is_composite"] = True
            payload["child_events"] = event.get("child_events") or event.get("childEvents")

        perception = PerceptionEvent(
            type=EventType.ALERT,
            priority=priority,
            source="alert-engine-bridge",
            payload=payload,
            schema_version="1.0.0",
        )
        device_id = event.get("device_id") or event.get("deviceId")
        if device_id:
            perception.payload["device_id"] = device_id
        await self._event_bus.publish(perception)

    @staticmethod
    def _severity_to_priority(severity: str) -> Priority:
        mapping = {
            "critical": Priority.CRITICAL,
            "warning": Priority.MEDIUM,
            "info": Priority.INFO,
        }
        return mapping.get(severity, Priority.MEDIUM)
