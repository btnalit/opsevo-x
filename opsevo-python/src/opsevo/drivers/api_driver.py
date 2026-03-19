"""HTTP REST API device driver.

Requirements: 8.2, 1.4, 1.9
"""

from __future__ import annotations

import re
import time
from typing import Any

import httpx

from opsevo.drivers.base import DeviceDriver
from opsevo.drivers.profile_loader import ProfileLoader
from opsevo.drivers.types import (
    CapabilityManifest,
    DeviceConnectionConfig,
    DeviceExecutionResult,
    DeviceMetrics,
    HealthCheckResult,
)
from opsevo.models.device import DeviceProfile, ProfileEndpoint
from opsevo.utils.logger import get_logger

logger = get_logger(__name__)


class ApiDriver(DeviceDriver):
    """HTTP REST driver — adapts to any REST API device via Profile config."""

    def __init__(self, profile: DeviceProfile) -> None:
        self._profile = profile
        self._config: DeviceConnectionConfig | None = None
        self._client: httpx.AsyncClient | None = None
        self._endpoint_map: dict[str, ProfileEndpoint] = {
            ep.action_type: ep for ep in profile.endpoints
        }

    async def connect(self, config: DeviceConnectionConfig) -> None:
        self._config = config
        base_url = self._resolve_base_url(config)
        auth = None
        if self._profile.auth.type == "basic" and config.username:
            auth = (config.username, config.password)
        self._client = httpx.AsyncClient(
            base_url=base_url,
            auth=auth,
            timeout=httpx.Timeout(config.timeout / 1000.0),
            verify=config.use_tls,
        )
        logger.info("api_driver_connected", host=config.host)

    async def disconnect(self) -> None:
        if self._client:
            await self._client.aclose()
            self._client = None

    async def health_check(self) -> HealthCheckResult:
        start = time.monotonic()
        try:
            c = self._ensure_client()
            resp = await c.get("/")
            latency = (time.monotonic() - start) * 1000
            return HealthCheckResult(
                healthy=resp.status_code < 500,
                message=f"HTTP {resp.status_code}",
                latency_ms=latency,
            )
        except Exception as e:
            latency = (time.monotonic() - start) * 1000
            return HealthCheckResult(healthy=False, message=str(e), latency_ms=latency)

    async def query(self, action_type: str, params: dict[str, Any] | None = None) -> DeviceExecutionResult:
        return await self._request(action_type, params)

    async def execute(self, action_type: str, params: dict[str, Any] | None = None) -> DeviceExecutionResult:
        return await self._request(action_type, params)

    async def configure(self, action_type: str, params: dict[str, Any] | None = None) -> DeviceExecutionResult:
        return await self._request(action_type, params)

    async def monitor(self, action_type: str) -> DeviceExecutionResult:
        return await self._request(action_type)

    async def collect_metrics(self) -> DeviceMetrics:
        metrics = DeviceMetrics()
        me = self._profile.metrics_endpoints
        if "cpu_usage" in me:
            r = await self.query(me["cpu_usage"])
            if r.success and isinstance(r.data, dict):
                metrics.cpu_usage = float(r.data.get("cpu-load", 0))
                metrics.memory_usage = self._calc_mem(r.data)
                metrics.uptime = int(r.data.get("uptime", "0").replace("s", "") or 0)
        return metrics

    async def collect_data(self, data_type: str) -> DeviceExecutionResult:
        action = f"get_{data_type}"
        if action in self._endpoint_map:
            return await self.query(action)
        return DeviceExecutionResult(success=False, error=f"No endpoint for data_type={data_type}")

    def get_capability_manifest(self) -> CapabilityManifest:
        return ProfileLoader.to_capability_manifest(self._profile)

    # ── internals ─────────────────────────────────────────────────────

    def _ensure_client(self) -> httpx.AsyncClient:
        if not self._client:
            raise RuntimeError("ApiDriver not connected")
        return self._client

    def _resolve_base_url(self, config: DeviceConnectionConfig) -> str:
        url = self._profile.base_url
        url = url.replace("{{host}}", config.host)
        url = url.replace("{{port}}", str(config.port))
        return url

    async def _request(self, action_type: str, params: dict[str, Any] | None = None) -> DeviceExecutionResult:
        ep = self._endpoint_map.get(action_type)
        if not ep:
            return DeviceExecutionResult(success=False, error=f"Unknown action_type: {action_type}")
        client = self._ensure_client()
        start = time.monotonic()
        try:
            path = self._interpolate_path(ep.path, params or {})
            if ep.method.upper() == "GET":
                resp = await client.get(path, params=params)
            elif ep.method.upper() == "POST":
                resp = await client.post(path, json=params)
            elif ep.method.upper() == "PUT":
                resp = await client.put(path, json=params)
            elif ep.method.upper() == "PATCH":
                resp = await client.patch(path, json=params)
            elif ep.method.upper() == "DELETE":
                resp = await client.delete(path)
            else:
                resp = await client.request(ep.method.upper(), path)
            elapsed = (time.monotonic() - start) * 1000
            data = resp.json() if resp.headers.get("content-type", "").startswith("application/json") else resp.text
            return DeviceExecutionResult(success=resp.is_success, data=data, execution_time_ms=elapsed)
        except Exception as e:
            elapsed = (time.monotonic() - start) * 1000
            return DeviceExecutionResult(success=False, error=str(e), execution_time_ms=elapsed)

    @staticmethod
    def _interpolate_path(path: str, params: dict[str, Any]) -> str:
        for key, val in params.items():
            path = path.replace(f"{{{key}}}", str(val))
        return path

    @staticmethod
    def _calc_mem(data: dict) -> float:
        total = int(data.get("total-memory", 0))
        free = int(data.get("free-memory", 0))
        if total > 0:
            return round((total - free) / total * 100, 1)
        return 0.0
