"""
SyslogReceiver — asyncio UDP/TCP Syslog 接收器

监听 UDP 514 端口接收 syslog 消息，解析后注入 EventBus。
严重性映射从配置加载，不使用硬编码。
"""

from __future__ import annotations

import asyncio
import re
import time
from typing import Any

import structlog

from opsevo.events.event_bus import EventBus
from opsevo.events.types import EventType, PerceptionEvent, Priority

logger = structlog.get_logger(__name__)


class SyslogReceiver:
    """asyncio UDP Syslog 接收器。"""

    _MAX_QUEUE_SIZE = 10_000
    _NUM_WORKERS = 4

    def __init__(
        self,
        event_bus: EventBus,
        port: int = 514,
        severity_mapping: dict[str, str] | None = None,
    ) -> None:
        self._event_bus = event_bus
        self._port = port
        self._severity_mapping = severity_mapping or {}
        self._transport: asyncio.DatagramTransport | None = None
        self._protocol: _SyslogProtocol | None = None
        self._message_count = 0
        self._queue: asyncio.Queue[tuple[bytes, tuple[str, int]]] | None = None
        self._workers: list[asyncio.Task[None]] = []

    async def start(self) -> None:
        loop = asyncio.get_running_loop()
        self._queue = asyncio.Queue(maxsize=self._MAX_QUEUE_SIZE)
        self._protocol = _SyslogProtocol(self._queue)
        transport, _ = await loop.create_datagram_endpoint(
            lambda: self._protocol,
            local_addr=("0.0.0.0", self._port),
        )
        self._transport = transport
        self._event_bus.register_source(
            "syslog-receiver",
            {"event_types": ["syslog"], "schema_version": "1.0.0"},
        )
        # Start worker tasks for bounded concurrency
        for _ in range(self._NUM_WORKERS):
            self._workers.append(asyncio.create_task(self._worker()))
        logger.info("SyslogReceiver started", port=self._port, workers=self._NUM_WORKERS)

    async def stop(self) -> None:
        for w in self._workers:
            w.cancel()
        self._workers.clear()
        if self._transport:
            self._transport.close()
            self._transport = None
        logger.info("SyslogReceiver stopped", messages=self._message_count)

    async def _worker(self) -> None:
        """Worker that drains the bounded queue."""
        while True:
            try:
                data, addr = await self._queue.get()
                await self._on_message(data, addr)
            except asyncio.CancelledError:
                break
            except Exception:
                logger.warning("syslog_worker_error", exc_info=True)

    async def _on_message(self, data: bytes, addr: tuple[str, int]) -> None:
        self._message_count += 1
        try:
            text = data.decode("utf-8", errors="replace").strip()
            parsed = self._parse_syslog(text)
            parsed["source_ip"] = addr[0]
            parsed["source_port"] = addr[1]

            severity = parsed.get("severity", "info")
            priority = self._map_priority(severity)

            event = PerceptionEvent(
                type=EventType.SYSLOG,
                priority=priority,
                source="syslog-receiver",
                payload=parsed,
                schema_version="1.0.0",
            )
            await self._event_bus.publish(event)
        except Exception as exc:
            logger.warn("Syslog parse error", error=str(exc))

    def _parse_syslog(self, message: str) -> dict[str, Any]:
        """解析 RFC3164/RFC5424 syslog 消息。"""
        result: dict[str, Any] = {"raw": message, "timestamp": time.time()}

        # RFC3164: <PRI>TIMESTAMP HOSTNAME APP-NAME: MSG
        m = re.match(r"<(\d+)>(.+)", message)
        if m:
            pri = int(m.group(1))
            result["facility"] = pri >> 3
            result["severity_code"] = pri & 0x07
            result["severity"] = self._code_to_severity(pri & 0x07)
            remainder = m.group(2).strip()
            # 尝试提取 hostname 和 message
            parts = remainder.split(" ", 3)
            if len(parts) >= 3:
                result["hostname"] = parts[1] if not parts[0][0].isdigit() else parts[0]
                result["message"] = parts[-1] if len(parts) > 2 else remainder
            else:
                result["message"] = remainder
        else:
            result["message"] = message
            result["severity"] = "info"

        return result

    def _code_to_severity(self, code: int) -> str:
        mapping = {
            0: "emergency",
            1: "alert",
            2: "critical",
            3: "error",
            4: "warning",
            5: "notice",
            6: "info",
            7: "debug",
        }
        return mapping.get(code, "info")

    def _map_priority(self, severity: str) -> Priority:
        # 先查配置映射
        mapped = self._severity_mapping.get(severity, severity)
        priority_map = {
            "emergency": Priority.CRITICAL,
            "alert": Priority.CRITICAL,
            "critical": Priority.CRITICAL,
            "error": Priority.HIGH,
            "warning": Priority.MEDIUM,
            "notice": Priority.LOW,
            "info": Priority.INFO,
            "debug": Priority.INFO,
        }
        return priority_map.get(mapped, Priority.INFO)

    @property
    def message_count(self) -> int:
        return self._message_count


class _SyslogProtocol(asyncio.DatagramProtocol):
    """asyncio UDP 协议处理 — 使用有界队列实现背压。"""

    def __init__(self, queue: asyncio.Queue[tuple[bytes, tuple[str, int]]]) -> None:
        self._queue = queue

    def datagram_received(self, data: bytes, addr: tuple[str, int]) -> None:
        try:
            self._queue.put_nowait((data, addr))
        except asyncio.QueueFull:
            pass  # Drop packet under backpressure

    def error_received(self, exc: Exception) -> None:
        logger.warn("Syslog UDP error", error=str(exc))
