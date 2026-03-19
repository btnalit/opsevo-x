"""
EventProcessingTracker 事件处理跟踪器
跟踪正在处理中的事件，防止重复处理。

- 事件进入处理流程时记录处理中状态
- 同一事件 ID 再次进入时检测重复并跳过
- 事件处理完成或超时时移除处理中状态
- 支持可配置的处理超时时间（默认 3 分钟）
- 定期清理过期的处理中状态记录
"""

from __future__ import annotations

import time
from dataclasses import dataclass

import structlog

logger = structlog.get_logger(__name__)


@dataclass
class EventProcessingState:
    event_id: str
    started_at: float
    expires_at: float
    fingerprint: str | None = None


@dataclass
class EventProcessingTrackerConfig:
    default_timeout_s: float = 180.0  # 3 min
    max_entries: int = 1000


class EventProcessingTracker:
    """跟踪正在处理中的事件，防止重复处理。"""

    def __init__(self, config: EventProcessingTrackerConfig | None = None) -> None:
        self._config = config or EventProcessingTrackerConfig()
        self._processing: dict[str, EventProcessingState] = {}
        self._duplicates_blocked = 0
        self._timeouts_cleared = 0
        self._total_completed = 0
        logger.info("EventProcessingTracker initialized", config=self._config)

    def is_processing(self, event_id: str) -> bool:
        state = self._processing.get(event_id)
        if state is None:
            return False
        if time.time() > state.expires_at:
            del self._processing[event_id]
            self._timeouts_cleared += 1
            return False
        return True

    def mark_processing(
        self,
        event_id: str,
        timeout_s: float | None = None,
        fingerprint: str | None = None,
    ) -> bool:
        """标记事件开始处理。返回 True 表示成功，False 表示已在处理中。"""
        if self.is_processing(event_id):
            self._duplicates_blocked += 1
            return False

        if len(self._processing) >= self._config.max_entries:
            self._evict_oldest()

        now = time.time()
        t = timeout_s if timeout_s is not None else self._config.default_timeout_s
        self._processing[event_id] = EventProcessingState(
            event_id=event_id,
            started_at=now,
            expires_at=now + t,
            fingerprint=fingerprint,
        )
        return True

    def mark_completed(self, event_id: str) -> None:
        if event_id in self._processing:
            del self._processing[event_id]
            self._total_completed += 1

    def cleanup(self) -> int:
        now = time.time()
        expired = [k for k, v in self._processing.items() if now > v.expires_at]
        for k in expired:
            del self._processing[k]
        self._timeouts_cleared += len(expired)
        if expired:
            logger.info("Cleaned up expired event processing states", count=len(expired))
        return len(expired)

    @property
    def processing_count(self) -> int:
        return len(self._processing)

    def get_processing_event_ids(self) -> list[str]:
        return list(self._processing.keys())

    def get_stats(self) -> dict:
        return {
            "processingCount": len(self._processing),
            "duplicatesBlocked": self._duplicates_blocked,
            "timeoutsCleared": self._timeouts_cleared,
            "totalCompleted": self._total_completed,
        }

    def stop(self) -> None:
        self._processing.clear()
        logger.info("EventProcessingTracker stopped")

    def _evict_oldest(self) -> None:
        if not self._processing:
            return
        oldest_id = min(self._processing, key=lambda k: self._processing[k].started_at)
        del self._processing[oldest_id]
        self._timeouts_cleared += 1
        logger.warning("Evicted oldest event processing state", event_id=oldest_id)
