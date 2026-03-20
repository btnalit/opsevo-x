"""AnomalyPredictor — detect anomalies in metrics time series.

Requirements: 9.5
"""

from __future__ import annotations

from typing import Any

from opsevo.utils.logger import get_logger

logger = get_logger(__name__)


class AnomalyPredictor:
    def __init__(self, z_threshold: float = 2.5):
        self._z_threshold = z_threshold
        self._latest_predictions: list[dict[str, Any]] = []

    def detect(self, values: list[float]) -> list[dict[str, Any]]:
        if len(values) < 5:
            return []
        mean = sum(values) / len(values)
        variance = sum((v - mean) ** 2 for v in values) / len(values)
        std = variance ** 0.5
        if std == 0:
            return []
        anomalies: list[dict[str, Any]] = []
        for i, v in enumerate(values):
            z = abs(v - mean) / std
            if z > self._z_threshold:
                anomalies.append({"index": i, "value": v, "z_score": round(z, 2)})
        self._latest_predictions = anomalies
        return anomalies

    async def get_predictions(self) -> list[dict[str, Any]]:
        """Return the latest anomaly predictions for PerceptionCache consumption."""
        return list(self._latest_predictions)
