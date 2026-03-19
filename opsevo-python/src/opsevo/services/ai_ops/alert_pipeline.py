"""AlertPipeline — multi-stage alert processing pipeline.

Stages: normalize → deduplicate → filter → analyze → decide
Requirements: 9.1
"""

from __future__ import annotations

import asyncio
import hashlib
import time
import uuid
from dataclasses import dataclass, field
from typing import Any, Callable, Awaitable

from opsevo.data.datastore import DataStore
from opsevo.utils.logger import get_logger

logger = get_logger(__name__)


@dataclass
class PipelineConfig:
    dedup_window_ms: int = 300_000
    processing_timeout_ms: int = 30_000
    max_concurrent: int = 5
    enable_syslog_rate_limit: bool = True
    syslog_rate_limit_per_sec: int = 100


@dataclass
class PipelineResult:
    event_id: str = ""
    success: bool = True
    stage: str = ""
    deduplicated: bool = False
    filtered: bool = False
    analysis: dict[str, Any] | None = None
    decision: dict[str, Any] | None = None
    duration_ms: int = 0
    error: str | None = None


class NormalizerAdapter:
    async def normalize(self, event: dict[str, Any]) -> dict[str, Any]:
        return event


class AlertPipeline:
    def __init__(self, datastore: DataStore | None = None, config: PipelineConfig | None = None):
        self._ds = datastore
        self._config = config or PipelineConfig()
        self._normalizers: dict[str, NormalizerAdapter] = {"default": NormalizerAdapter()}
        self._fingerprints: dict[str, float] = {}
        self._stats = {"processed": 0, "deduplicated": 0, "filtered": 0, "errors": 0}
        self._semaphore = asyncio.Semaphore(self._config.max_concurrent)
        self._event_bus: Any = None
        self._initialized = False

    def set_event_bus(self, event_bus: Any) -> None:
        self._event_bus = event_bus

    def register_normalizer(self, source_type: str, adapter: NormalizerAdapter) -> None:
        self._normalizers[source_type] = adapter

    async def initialize(self) -> None:
        self._initialized = True
        logger.info("alert_pipeline_initialized")

    async def process(self, event: dict[str, Any]) -> PipelineResult:
        start = int(time.time() * 1000)
        event_id = event.get("id", str(uuid.uuid4()))
        async with self._semaphore:
            try:
                normalized = await self._stage_normalize(event)
                is_dup = await self._stage_deduplicate(normalized)
                if is_dup:
                    self._stats["deduplicated"] += 1
                    return PipelineResult(event_id=event_id, deduplicated=True, stage="deduplicate",
                                          duration_ms=int(time.time() * 1000) - start)
                filtered = await self._stage_filter(normalized)
                if filtered:
                    self._stats["filtered"] += 1
                    return PipelineResult(event_id=event_id, filtered=True, stage="filter",
                                          duration_ms=int(time.time() * 1000) - start)
                analysis = await self._stage_analyze(normalized)
                decision = await self._stage_decide(normalized, analysis)
                self._stats["processed"] += 1
                return PipelineResult(event_id=event_id, success=True, stage="complete",
                                      analysis=analysis, decision=decision,
                                      duration_ms=int(time.time() * 1000) - start)
            except Exception as exc:
                self._stats["errors"] += 1
                logger.error("pipeline_process_error", event_id=event_id, error=str(exc))
                return PipelineResult(event_id=event_id, success=False, error=str(exc),
                                      duration_ms=int(time.time() * 1000) - start)

    async def _stage_normalize(self, event: dict[str, Any]) -> dict[str, Any]:
        source = event.get("source_type", "default")
        adapter = self._normalizers.get(source, self._normalizers["default"])
        return await adapter.normalize(event)

    async def _stage_deduplicate(self, event: dict[str, Any]) -> bool:
        fp = self._compute_fingerprint(event)
        now = time.time() * 1000
        # Purge expired fingerprints to prevent memory leak
        expired = [k for k, v in self._fingerprints.items() if now - v >= self._config.dedup_window_ms]
        for k in expired:
            del self._fingerprints[k]
        if fp in self._fingerprints:
            if now - self._fingerprints[fp] < self._config.dedup_window_ms:
                return True
        self._fingerprints[fp] = now
        return False

    async def _stage_filter(self, event: dict[str, Any]) -> bool:
        severity = event.get("severity", "info")
        return severity == "debug"

    async def _stage_analyze(self, event: dict[str, Any]) -> dict[str, Any]:
        return {"severity": event.get("severity", "info"), "category": event.get("type", "unknown")}

    async def _stage_decide(self, event: dict[str, Any], analysis: dict[str, Any]) -> dict[str, Any]:
        severity = analysis.get("severity", "info")
        action = "notify" if severity in ("critical", "high") else "log"
        return {"action": action, "severity": severity}

    @staticmethod
    def _compute_fingerprint(event: dict[str, Any]) -> str:
        key = f"{event.get('device_id','')}-{event.get('type','')}-{event.get('message','')[:100]}"
        return hashlib.md5(key.encode()).hexdigest()

    def get_stats(self) -> dict[str, int]:
        return dict(self._stats)

    def reset_stats(self) -> None:
        self._stats = {"processed": 0, "deduplicated": 0, "filtered": 0, "errors": 0}

    async def flush(self) -> None:
        self._fingerprints.clear()

    async def stop(self) -> None:
        await self.flush()
        logger.info("alert_pipeline_stopped")

    async def health_check(self) -> dict[str, Any]:
        return {"healthy": self._initialized, "stats": self._stats}
