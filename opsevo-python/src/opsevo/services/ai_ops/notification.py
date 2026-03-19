"""NotificationService — send notifications via configured channels.

Requirements: 9.2, 9.8
"""

from __future__ import annotations

import time
from typing import Any

import httpx

from opsevo.utils.logger import get_logger

logger = get_logger(__name__)


class NotificationService:
    def __init__(self) -> None:
        self._channels: list[dict[str, Any]] = []

    def load_channels(self, channels: list[dict[str, Any]]) -> None:
        self._channels = channels
        logger.info("notification_channels_loaded", count=len(channels))

    async def send(self, title: str, message: str, severity: str = "info", metadata: dict[str, Any] | None = None) -> list[dict[str, Any]]:
        results: list[dict[str, Any]] = []
        for ch in self._channels:
            if not ch.get("enabled", True):
                continue
            try:
                await self._send_to_channel(ch, title, message, severity, metadata)
                results.append({"channel": ch.get("name", ""), "success": True})
            except Exception as exc:
                results.append({"channel": ch.get("name", ""), "success": False, "error": str(exc)})
                logger.warning("notification_send_failed", channel=ch.get("name"), error=str(exc))
        return results

    async def _send_to_channel(self, channel: dict[str, Any], title: str, message: str,
                                severity: str, metadata: dict[str, Any] | None) -> None:
        ch_type = channel.get("type", "webhook")
        if ch_type == "webhook":
            url = channel.get("url", "")
            if not url:
                return
            async with httpx.AsyncClient(timeout=10.0) as client:
                await client.post(url, json={
                    "title": title, "message": message, "severity": severity,
                    "timestamp": int(time.time() * 1000), **(metadata or {}),
                })
        # Other channel types (email, slack, etc.) can be added here

    def get_channels(self) -> list[dict[str, Any]]:
        return list(self._channels)
