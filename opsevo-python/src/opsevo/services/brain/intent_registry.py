"""
IntentRegistry — Brain 意图注册与管理

管理自主大脑产生的意图（intents），支持：
- 意图注册与分类
- 待审批意图队列
- 意图授权/拒绝
- 意图执行跟踪
"""

from __future__ import annotations

import time
import uuid
from dataclasses import dataclass, field
from enum import Enum
from typing import Any

import structlog

logger = structlog.get_logger(__name__)


class IntentStatus(str, Enum):
    PENDING = "pending"
    GRANTED = "granted"
    REJECTED = "rejected"
    EXECUTING = "executing"
    COMPLETED = "completed"
    FAILED = "failed"


class IntentCategory(str, Enum):
    DIAGNOSTIC = "diagnostic"
    REMEDIATION = "remediation"
    CONFIGURATION = "configuration"
    NOTIFICATION = "notification"
    SCHEDULING = "scheduling"
    KNOWLEDGE = "knowledge"
    MONITORING = "monitoring"


@dataclass
class Intent:
    id: str = field(default_factory=lambda: str(uuid.uuid4()))
    category: IntentCategory = IntentCategory.DIAGNOSTIC
    description: str = ""
    tool_name: str = ""
    params: dict[str, Any] = field(default_factory=dict)
    status: IntentStatus = IntentStatus.PENDING
    created_at: float = field(default_factory=time.time)
    resolved_at: float | None = None
    result: Any = None
    device_id: str | None = None
    requires_approval: bool = True


class IntentRegistry:
    """管理 Brain 产生的意图。"""

    def __init__(self) -> None:
        self._intents: dict[str, Intent] = {}
        self._listeners: list[Any] = []

    def register(self, intent: Intent) -> str:
        self._intents[intent.id] = intent
        logger.info("Intent registered", id=intent.id, category=intent.category.value)
        self._notify("registered", intent)
        return intent.id

    def get_pending(self) -> list[Intent]:
        return [i for i in self._intents.values() if i.status == IntentStatus.PENDING]

    def get_by_id(self, intent_id: str) -> Intent | None:
        return self._intents.get(intent_id)

    def grant(self, intent_id: str) -> bool:
        intent = self._intents.get(intent_id)
        if not intent or intent.status != IntentStatus.PENDING:
            return False
        intent.status = IntentStatus.GRANTED
        intent.resolved_at = time.time()
        self._notify("granted", intent)
        return True

    def reject(self, intent_id: str) -> bool:
        intent = self._intents.get(intent_id)
        if not intent or intent.status != IntentStatus.PENDING:
            return False
        intent.status = IntentStatus.REJECTED
        intent.resolved_at = time.time()
        self._notify("rejected", intent)
        return True

    def mark_executing(self, intent_id: str) -> None:
        intent = self._intents.get(intent_id)
        if intent:
            intent.status = IntentStatus.EXECUTING

    def mark_completed(self, intent_id: str, result: Any = None) -> None:
        intent = self._intents.get(intent_id)
        if intent:
            intent.status = IntentStatus.COMPLETED
            intent.result = result
            intent.resolved_at = time.time()

    def mark_failed(self, intent_id: str, error: str = "") -> None:
        intent = self._intents.get(intent_id)
        if intent:
            intent.status = IntentStatus.FAILED
            intent.result = {"error": error}
            intent.resolved_at = time.time()

    def on_change(self, listener: Any) -> None:
        self._listeners.append(listener)

    def _notify(self, event: str, intent: Intent) -> None:
        for listener in self._listeners:
            try:
                listener(event, intent)
            except Exception:
                pass

    def cleanup(self, max_age_s: float = 3600) -> int:
        now = time.time()
        expired = [
            k for k, v in self._intents.items()
            if v.status in (IntentStatus.COMPLETED, IntentStatus.FAILED, IntentStatus.REJECTED)
            and v.resolved_at and (now - v.resolved_at) > max_age_s
        ]
        for k in expired:
            del self._intents[k]
        return len(expired)
