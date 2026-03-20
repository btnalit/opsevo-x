"""
PerceptionCache — 后台守护预热缓存

asyncio.Task 后台守护，30s 间隔预热，
为 Brain tick 提供低延迟的上下文数据。
"""

from __future__ import annotations

import asyncio
from typing import Any

import structlog

logger = structlog.get_logger(__name__)


class PerceptionCache:
    """后台预热缓存，定期从各服务收集数据供 Brain 使用。"""

    def __init__(
        self,
        datastore: Any = None,
        health_monitor: Any = None,
        alert_engine: Any = None,
        anomaly_predictor: Any = None,
        pattern_learner: Any = None,
        device_orchestrator: Any = None,
        refresh_interval_s: float = 30.0,
    ) -> None:
        self._datastore = datastore
        self._health_monitor = health_monitor
        self._alert_engine = alert_engine
        self._anomaly_predictor = anomaly_predictor
        self._pattern_learner = pattern_learner
        self._device_orchestrator = device_orchestrator
        self._interval = refresh_interval_s

        self._active_alerts: list[dict] = []
        self._recent_metrics: dict[str, Any] = {}
        self._health_summary: dict[str, Any] = {}
        self._predictions: list[dict] = []
        self._patterns: list[dict] = []
        self._device_inventory: dict[str, Any] = {}

        self._task: asyncio.Task[None] | None = None
        self._running = False

    async def start(self) -> None:
        if self._running:
            return
        self._running = True
        await self._refresh()  # initial load
        self._task = asyncio.create_task(self._loop())
        logger.info("PerceptionCache started", interval=self._interval)

    def stop(self) -> None:
        self._running = False
        if self._task and not self._task.done():
            self._task.cancel()
            self._task = None
        logger.info("PerceptionCache stopped")

    # ------------------------------------------------------------------
    # public getters (async for interface consistency)
    # ------------------------------------------------------------------
    async def get_active_alerts(self) -> list[dict]:
        return list(self._active_alerts)

    async def get_recent_metrics(self) -> dict[str, Any]:
        return dict(self._recent_metrics)

    async def get_health_summary(self) -> dict[str, Any]:
        return dict(self._health_summary)

    async def get_predictions(self) -> list[dict]:
        return list(self._predictions)

    async def get_patterns(self) -> list[dict]:
        return list(self._patterns)

    async def get_device_inventory(self) -> dict[str, Any]:
        return dict(self._device_inventory)

    # ------------------------------------------------------------------
    async def _loop(self) -> None:
        while self._running:
            try:
                await asyncio.sleep(self._interval)
                if self._running:
                    await self._refresh()
            except asyncio.CancelledError:
                break
            except Exception:
                logger.exception("PerceptionCache refresh error")

    async def _refresh(self) -> None:
        tasks: list[tuple[str, Any]] = []

        if self._alert_engine and hasattr(self._alert_engine, "get_active_alerts"):
            tasks.append(("alerts", self._alert_engine.get_active_alerts()))
        if self._health_monitor and hasattr(self._health_monitor, "get_summary"):
            tasks.append(("health", self._health_monitor.get_summary()))
        if self._anomaly_predictor and hasattr(self._anomaly_predictor, "get_predictions"):
            tasks.append(("predictions", self._anomaly_predictor.get_predictions()))
        if self._pattern_learner and hasattr(self._pattern_learner, "get_patterns"):
            tasks.append(("patterns", self._pattern_learner.get_patterns()))

        if not tasks:
            return

        labels = [t[0] for t in tasks]
        coros = [t[1] for t in tasks]
        results = await asyncio.gather(*coros, return_exceptions=True)

        for label, result in zip(labels, results):
            if isinstance(result, Exception):
                logger.warning(f"PerceptionCache refresh failed: {label}", error=str(result))
                continue
            if label == "alerts" and isinstance(result, list):
                self._active_alerts = result
            elif label == "health" and isinstance(result, dict):
                self._health_summary = result
            elif label == "predictions" and isinstance(result, list):
                self._predictions = result
            elif label == "patterns" and isinstance(result, list):
                self._patterns = result

        # 从 DeviceOrchestrator 获取设备清单
        if self._device_orchestrator:
            try:
                summary = self._device_orchestrator.get_device_summary()
                self._device_inventory = {
                    "summary": {
                        "total": summary.total,
                        "online": summary.online,
                        "offline": summary.offline,
                        "connecting": summary.connecting,
                        "avg_health_score": summary.avg_health_score,
                    },
                    "devices": [
                        {
                            "id": s.device_id,
                            "name": s.name,
                            "status": s.status,
                            "health_score": s.health_score,
                        }
                        for s in self._device_orchestrator.list_devices()
                    ],
                }
            except Exception:
                logger.warning("PerceptionCache: device inventory refresh failed")
