"""Event types and data structures for the EventBus.

Requirements: 7.1, 7.2
"""

from __future__ import annotations

import uuid
from dataclasses import dataclass, field
from datetime import datetime, timezone
from enum import Enum
from typing import Any


class EventType(str, Enum):
    ALERT = "alert"
    METRIC = "metric"
    SYSLOG = "syslog"
    SNMP_TRAP = "snmp_trap"
    WEBHOOK = "webhook"
    INTERNAL = "internal"
    BRAIN_HEARTBEAT = "brain_heartbeat"

    # DeviceOrchestrator 生命周期事件
    DEVICE_ADDED = "device_added"
    DEVICE_REMOVED = "device_removed"
    DEVICE_ONLINE = "device_online"
    DEVICE_OFFLINE = "device_offline"
    DEVICE_HEALTH_CHANGED = "device_health_changed"
    ORCHESTRATOR_READY = "orchestrator_ready"


class Priority(str, Enum):
    CRITICAL = "critical"
    HIGH = "high"
    MEDIUM = "medium"
    LOW = "low"
    INFO = "info"


@dataclass
class PerceptionEvent:
    """A single event flowing through the EventBus."""

    type: EventType
    priority: Priority
    source: str
    payload: dict[str, Any]
    schema_version: str = "1.0"
    timestamp: datetime = field(default_factory=lambda: datetime.now(timezone.utc))
    event_id: str = field(default_factory=lambda: str(uuid.uuid4()))
