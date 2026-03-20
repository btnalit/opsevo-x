"""DeviceOrchestrator — AIOPS 平台的设备资源管理器。

负责设备注册表、连接管理、周期性健康检查/指标采集、热插拔、
生命周期事件、IP 映射、拓扑集成、Brain/PerceptionCache 集成。

Requirements: 1.1–12.5
"""

from __future__ import annotations

import asyncio
import json
import time
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Any

from opsevo.drivers.types import DeviceConnectionConfig
from opsevo.events.types import EventType, PerceptionEvent, Priority
from opsevo.utils.logger import get_logger

if TYPE_CHECKING:
    from opsevo.data.datastore import DataStore
    from opsevo.drivers.base import DeviceDriver
    from opsevo.events.event_bus import EventBus
    from opsevo.services.ai_ops.alert_engine import AlertEngine
    from opsevo.services.ai_ops.health_monitor import HealthMonitor
    from opsevo.services.ai_ops.metrics_collector import MetricsCollector
    from opsevo.services.device_manager import DeviceManager
    from opsevo.services.device_pool import DevicePool
    from opsevo.services.topology.discovery_service import TopologyDiscoveryService
    from opsevo.settings import Settings

logger = get_logger(__name__)


@dataclass
class DeviceSlot:
    """Device Registry 中一台设备的完整记录。"""

    device_id: str
    name: str
    host: str
    port: int
    profile_id: str
    tenant_id: str | None = None
    username: str = ""
    password: str = ""
    use_tls: bool = False

    # 运行时状态（不持久化到 DB）
    status: str = "connecting"  # connecting | online | offline
    health_score: int = 0  # 0-100
    last_health_check: float = 0.0  # monotonic timestamp
    last_metrics_collection: float = 0.0
    consecutive_failures: int = 0
    last_check_attempt: float = 0.0  # 用于退避计算
    metadata: dict = field(default_factory=dict)
    lock: asyncio.Lock = field(default_factory=asyncio.Lock)  # 设备级互斥锁


@dataclass
class DeviceSummary:
    """设备聚合摘要，用于 API 和 Brain 上下文。"""

    total: int = 0
    online: int = 0
    offline: int = 0
    connecting: int = 0
    avg_health_score: float = 0.0


class DeviceOrchestrator:
    """AIOPS 平台的设备资源管理器。"""

    def __init__(
        self,
        device_manager: DeviceManager,
        device_pool: DevicePool,
        health_monitor: HealthMonitor,
        alert_engine: AlertEngine,
        metrics_collector: MetricsCollector,
        event_bus: EventBus,
        settings: Settings,
        datastore: DataStore,
        topology_discovery: TopologyDiscoveryService | None = None,
    ) -> None:
        self._device_manager = device_manager
        self._device_pool = device_pool
        self._health_monitor = health_monitor
        self._alert_engine = alert_engine
        self._metrics_collector = metrics_collector
        self._event_bus = event_bus
        self._settings = settings
        self._datastore = datastore
        self._topology_discovery = topology_discovery

        # 内部状态
        self._registry: dict[str, DeviceSlot] = {}
        self._ip_to_device: dict[str, str] = {}
        self._running = False
        self._start_time: float = 0.0  # monotonic timestamp for uptime
        self._cycle_lock = asyncio.Lock()
        self._health_task: asyncio.Task | None = None
        self._metrics_task: asyncio.Task | None = None

    # ── 设备查询 ──────────────────────────────────────────────────────

    def list_devices(self, status: str | None = None) -> list[DeviceSlot]:
        """返回设备列表，可按状态过滤。"""
        if status is None:
            return list(self._registry.values())
        return [s for s in self._registry.values() if s.status == status]

    def get_device(self, device_id: str) -> DeviceSlot | None:
        """按 ID 获取单台设备。"""
        return self._registry.get(device_id)

    def get_device_summary(self) -> DeviceSummary:
        """返回设备聚合摘要。"""
        slots = list(self._registry.values())
        total = len(slots)
        online = sum(1 for s in slots if s.status == "online")
        offline = sum(1 for s in slots if s.status == "offline")
        connecting = sum(1 for s in slots if s.status == "connecting")
        online_slots = [s for s in slots if s.status == "online" and s.health_score > 0]
        avg = sum(s.health_score for s in online_slots) / len(online_slots) if online_slots else 0.0
        return DeviceSummary(
            total=total, online=online, offline=offline,
            connecting=connecting, avg_health_score=round(avg, 1),
        )

    def get_status(self) -> dict:
        """返回编排器运行状态。"""
        uptime_s = round(time.monotonic() - self._start_time, 1) if self._running else 0.0
        return {
            "running": self._running,
            "uptime_s": uptime_s,
            "last_health_cycle": None,
            "last_metrics_cycle": None,
            "registry_size": len(self._registry),
        }

    def resolve_device_by_ip(self, ip: str) -> str | None:
        """通过 IP 地址解析 device_id。"""
        return self._ip_to_device.get(ip)

    async def get_driver(self, device_id: str) -> DeviceDriver:
        """获取设备驱动实例。"""
        slot = self._registry.get(device_id)
        if not slot:
            raise KeyError(f"Device {device_id} not in registry")
        return await self._device_pool.get_driver(device_id)

    # ── DB 同步辅助方法 ──────────────────────────────────────────────

    async def _sync_device_status_to_db(self, slot: DeviceSlot) -> None:
        """将内存中的设备状态同步到数据库（异步，失败只记日志）。"""
        try:
            heartbeat_clause = ", last_heartbeat = NOW()" if slot.status == "online" else ""
            await self._datastore.execute(
                f"UPDATE devices SET status = $1, health_score = $2,"
                f" error_message = $3, retry_count = $4,"
                f" updated_at = NOW(){heartbeat_clause}"
                f" WHERE id = $5",
                (slot.status, slot.health_score, slot.metadata.get("error"),
                 slot.consecutive_failures, slot.device_id),
            )
        except Exception:
            logger.warning("db_sync_failed", device_id=slot.device_id, exc_info=True)

    async def _record_lifecycle_event(
        self, device_id: str, event_type: str, details: dict | None = None,
    ) -> None:
        """记录设备生命周期事件到数据库（异步，失败只记日志）。"""
        try:
            await self._datastore.execute(
                "INSERT INTO device_lifecycle_events (device_id, event_type, details)"
                " VALUES ($1, $2, $3)",
                (device_id, event_type, json.dumps(details or {})),
            )
        except Exception:
            logger.warning("lifecycle_event_record_failed", device_id=device_id, exc_info=True)

    async def _get_orchestrator_state(self, key: str) -> dict | None:
        """获取编排器持久化状态。"""
        try:
            row = await self._datastore.query_one(
                "SELECT value FROM device_orchestrator_state WHERE key = $1",
                (key,),
            )
            return row["value"] if row else None
        except Exception:
            logger.warning("orchestrator_state_get_failed", key=key, exc_info=True)
            return None

    async def _set_orchestrator_state(self, key: str, value: dict) -> None:
        """保存编排器持久化状态（upsert）。"""
        try:
            await self._datastore.execute(
                "INSERT INTO device_orchestrator_state (key, value, updated_at)"
                " VALUES ($1, $2, NOW())"
                " ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = NOW()",
                (key, json.dumps(value)),
            )
        except Exception:
            logger.warning("orchestrator_state_set_failed", key=key, exc_info=True)

    # ── 生命周期 ──────────────────────────────────────────────────────

    async def start(self) -> None:
        """启动编排器：加载设备、连接、启动后台循环。"""
        self._start_time = time.monotonic()
        start_time = self._start_time
        logger.info("device_orchestrator_starting")

        # 1. 从 DB 加载设备
        devices = await self._device_manager.list_devices()
        for d in devices:
            device_id = str(d["id"])
            slot = DeviceSlot(
                device_id=device_id,
                name=d.get("name", ""),
                host=d.get("host", ""),
                port=d.get("port", 443),
                profile_id=d.get("profile_id", ""),
                tenant_id=d.get("tenant_id"),
                username=d.get("username", ""),
                password=d.get("password", ""),
                use_tls=d.get("use_tls", False),
                status="connecting",
            )
            self._registry[device_id] = slot
            self._ip_to_device[slot.host] = device_id

        # 2. 自动连接（受全局和设备级 auto_connect 控制）
        if self._settings.orchestrator_auto_connect:
            sem = asyncio.Semaphore(self._settings.orchestrator_max_concurrent_connections)

            async def _connect_with_sem(s: DeviceSlot, rec: dict) -> None:
                async with sem:
                    device_auto = rec.get("auto_connect", True)
                    if not device_auto:
                        s.status = "offline"
                        await self._sync_device_status_to_db(s)
                        return
                    await self._connect_device(s)

            # 构建 device_id -> record 映射以便查 auto_connect
            record_map = {str(d["id"]): d for d in devices}
            await asyncio.gather(
                *[_connect_with_sem(slot, record_map[slot.device_id])
                  for slot in self._registry.values()],
                return_exceptions=True,
            )
        else:
            # 全局 auto_connect 关闭，所有设备直接 offline
            for slot in self._registry.values():
                slot.status = "offline"
                await self._sync_device_status_to_db(slot)

        # 3. 设置拓扑 provider
        if self._topology_discovery:
            self._topology_discovery.set_device_provider(
                self._provide_devices_for_topology
            )
            self._topology_discovery.set_connection_provider(
                self._provide_connection_for_topology
            )

        # 4. 启动后台循环
        self._running = True
        self._health_task = asyncio.create_task(self._health_check_loop())
        self._metrics_task = asyncio.create_task(self._metrics_collection_loop())

        # 5. 发布 ORCHESTRATOR_READY
        summary = self.get_device_summary()
        duration_ms = round((time.monotonic() - start_time) * 1000, 1)
        await self._publish_lifecycle_event(
            EventType.ORCHESTRATOR_READY,
            slot=None,
            total=summary.total, online=summary.online,
            offline=summary.offline, duration_ms=duration_ms,
        )
        logger.info(
            "device_orchestrator_started",
            total=summary.total, online=summary.online,
            offline=summary.offline, duration_ms=duration_ms,
        )

    async def stop(self) -> None:
        """优雅关闭：取消后台任务，同步最终状态到 DB。"""
        self._running = False

        # 取消后台循环
        for task in (self._health_task, self._metrics_task):
            if task and not task.done():
                task.cancel()

        # 等待后台任务结束（最多 10s）
        tasks_to_wait = [
            t for t in (self._health_task, self._metrics_task)
            if t and not t.done()
        ]
        if tasks_to_wait:
            done, pending = await asyncio.wait(tasks_to_wait, timeout=10.0)
            if pending:
                logger.warning("orchestrator_stop_timeout", pending=len(pending))

        # 将最终状态同步到 DB
        for slot in self._registry.values():
            try:
                await self._sync_device_status_to_db(slot)
            except Exception:
                logger.warning("final_db_sync_failed", device_id=slot.device_id)

        # 清理
        self._registry.clear()
        self._ip_to_device.clear()
        logger.info("device_orchestrator_stopped")

    async def _connect_device(self, slot: DeviceSlot) -> bool:
        """连接单台设备，返回是否成功。"""
        try:
            config = DeviceConnectionConfig(
                host=slot.host,
                port=slot.port,
                username=slot.username,
                password=slot.password,
                use_tls=slot.use_tls,
                profile_name=slot.profile_id,
            )
            # 网络 I/O 在锁外执行，避免阻塞健康检查
            await asyncio.wait_for(
                self._device_pool.get_driver(
                    slot.device_id, config=config, profile_name=slot.profile_id,
                ),
                timeout=self._settings.orchestrator_operation_timeout_s,
            )
            aborted = False
            async with slot.lock:
                # 二次确认：如果在网络 I/O 期间被手动断开或状态已变，放弃连接
                if slot.status not in ("connecting", "offline") or slot.metadata.get("manual_disconnect"):
                    aborted = True
                else:
                    slot.status = "online"
                    slot.consecutive_failures = 0

            if aborted:
                logger.info(
                    "connect_aborted_state_changed",
                    device_id=slot.device_id, current_status=slot.status,
                )
                try:
                    await self._device_pool.remove(slot.device_id)
                except Exception:
                    pass
                return False
            await self._sync_device_status_to_db(slot)
            await self._publish_lifecycle_event(
                EventType.DEVICE_ONLINE, slot,
                health_score=slot.health_score,
            )
            return True
        except Exception as exc:
            async with slot.lock:
                slot.status = "offline"
                slot.consecutive_failures += 1
                slot.metadata["error"] = str(exc)
            await self._sync_device_status_to_db(slot)
            logger.warning(
                "device_connect_failed",
                device_id=slot.device_id, error=str(exc),
            )
            return False

    async def _publish_lifecycle_event(
        self, event_type: EventType, slot: DeviceSlot | None, **extra: Any,
    ) -> None:
        """发布生命周期事件到 EventBus 并持久化到 DB。"""
        payload: dict[str, Any] = {**extra}
        if slot:
            payload["device_id"] = slot.device_id
            payload["device_name"] = slot.name

        try:
            event = PerceptionEvent(
                type=event_type,
                priority=Priority.INFO,
                source="device-orchestrator",
                payload=payload,
            )
            await self._event_bus.publish(event)
        except Exception:
            logger.warning("lifecycle_event_publish_failed", event_type=event_type.value)

        # 异步写入 DB（不阻塞主流程）
        if slot:
            try:
                await self._record_lifecycle_event(
                    slot.device_id, event_type.value, extra or None,
                )
                await self._sync_device_status_to_db(slot)
            except Exception:
                logger.warning("lifecycle_db_write_failed", device_id=slot.device_id)

    # ── 拓扑集成 ──────────────────────────────────────────────────────

    async def _provide_devices_for_topology(self) -> list[dict[str, Any]]:
        """为 TopologyDiscoveryService 提供在线设备列表。"""
        return [
            {
                "id": s.device_id,
                "tenant_id": s.tenant_id,
                "name": s.name,
                "host": s.host,
            }
            for s in self._registry.values()
            if s.status == "online"
        ]

    async def _provide_connection_for_topology(
        self, tenant_id: str, device_id: str,
    ) -> DeviceDriver:
        """为 TopologyDiscoveryService 提供设备连接。"""
        return await self._device_pool.get_driver(device_id)

    # ── 后台循环占位（Task 5/7 实现） ─────────────────────────────────

    async def _health_check_loop(self) -> None:
        """健康检查后台循环（Task 5 实现完整逻辑）。"""
        while self._running:
            try:
                await asyncio.sleep(self._settings.orchestrator_health_check_interval_s)
                if not self._running:
                    break
                await self._run_health_cycle()
            except asyncio.CancelledError:
                break
            except Exception:
                logger.error("health_check_loop_error", exc_info=True)

    async def _metrics_collection_loop(self) -> None:
        """指标采集后台循环（Task 7 实现完整逻辑）。"""
        while self._running:
            try:
                await asyncio.sleep(self._settings.orchestrator_metrics_interval_s)
                if not self._running:
                    break
                await self._run_metrics_cycle()
            except asyncio.CancelledError:
                break
            except Exception:
                logger.error("metrics_collection_loop_error", exc_info=True)

    async def _run_health_cycle(self) -> None:
        """执行一次健康检查周期（快照模式）。"""
        start = time.monotonic()

        # 仅在获取快照时加锁
        async with self._cycle_lock:
            snapshot = list(self._registry.values())

        online = [s for s in snapshot if s.status == "online"]
        offline_due = [s for s in snapshot if self._should_check_offline_device(s)]
        targets = online + offline_due
        skipped = len(snapshot) - len(targets)

        if not targets:
            return

        sem = asyncio.Semaphore(self._settings.orchestrator_max_concurrent_checks)
        success = 0
        failure = 0

        async def _check(slot: DeviceSlot) -> None:
            nonlocal success, failure
            async with sem:
                try:
                    await self._check_device_health(slot)
                    success += 1
                except Exception:
                    failure += 1

        await asyncio.gather(*[_check(s) for s in targets], return_exceptions=True)

        duration_ms = round((time.monotonic() - start) * 1000, 1)
        logger.info(
            "health_cycle_complete",
            total=len(snapshot), success=success, failure=failure,
            skipped=skipped, duration_ms=duration_ms,
        )

    async def _check_device_health(self, slot: DeviceSlot) -> None:
        """检查单台设备健康状态，更新 slot 并触发事件。"""
        slot.last_check_attempt = time.monotonic()

        # 1. 网络 I/O 在锁外执行，避免阻塞 connect/disconnect API
        healthy = False
        latency_ms = 0
        error_msg: str | None = None
        try:
            driver = await asyncio.wait_for(
                self._device_pool.get_driver(slot.device_id),
                timeout=self._settings.orchestrator_operation_timeout_s,
            )
            result = await asyncio.wait_for(
                self._health_monitor.check_device(slot.device_id, driver),
                timeout=self._settings.orchestrator_operation_timeout_s,
            )
            healthy = result.get("healthy", False)
            latency_ms = result.get("latency_ms", 0)
        except asyncio.CancelledError:
            raise  # 让上层 task.cancel() 正常工作
        except (asyncio.TimeoutError, Exception) as exc:
            error_msg = str(exc)

        # 2. 锁内更新状态
        publish_online = False
        publish_offline = False
        publish_health_changed = False
        old_score = 0
        new_score_val = 0
        failure_reason = ""
        consecutive = 0

        async with slot.lock:
            old_score = slot.health_score

            if error_msg is not None:
                # 网络异常
                slot.consecutive_failures += 1
                slot.last_health_check = time.monotonic()
                slot.metadata["error"] = error_msg
                if slot.consecutive_failures >= 3 and slot.status == "online":
                    slot.status = "offline"
                    publish_offline = True
                    failure_reason = error_msg
                    consecutive = slot.consecutive_failures
            elif healthy:
                new_score_val = min(100, max(1, 100 - latency_ms // 10))
                slot.health_score = new_score_val
                slot.last_health_check = time.monotonic()

                if slot.status == "offline":
                    slot.status = "online"
                    slot.consecutive_failures = 0
                    publish_online = True
                else:
                    slot.consecutive_failures = 0

                if abs(slot.health_score - old_score) > 20:
                    publish_health_changed = True
            else:
                # 检查返回不健康
                slot.consecutive_failures += 1
                slot.last_health_check = time.monotonic()
                if slot.consecutive_failures >= 3 and slot.status == "online":
                    slot.status = "offline"
                    publish_offline = True
                    failure_reason = "consecutive_failures"
                    consecutive = slot.consecutive_failures

        # 3. 锁外发布事件和同步 DB
        if publish_online:
            await self._publish_lifecycle_event(
                EventType.DEVICE_ONLINE, slot,
                health_score=slot.health_score,
            )
        if publish_offline:
            await self._publish_lifecycle_event(
                EventType.DEVICE_OFFLINE, slot,
                failure_reason=failure_reason,
                consecutive_failures=consecutive,
            )
        if publish_health_changed:
            await self._publish_lifecycle_event(
                EventType.DEVICE_HEALTH_CHANGED, slot,
                old_score=old_score, new_score=slot.health_score,
            )
        await self._sync_device_status_to_db(slot)

    def _should_check_offline_device(self, slot: DeviceSlot) -> bool:
        """判断离线设备是否到了下次检查时间（指数退避）。"""
        if slot.status != "offline":
            return False
        # 人为断开的设备不参与自动恢复检查
        if slot.metadata.get("manual_disconnect"):
            return False
        if slot.consecutive_failures < 3:
            return True
        backoff = min(
            self._settings.orchestrator_health_check_interval_s
            * (2 ** (slot.consecutive_failures - 2)),
            self._settings.orchestrator_max_backoff_s,
        )
        elapsed = time.monotonic() - slot.last_check_attempt
        return elapsed >= backoff

    async def _run_metrics_cycle(self) -> None:
        """执行一次指标采集周期（快照模式）。"""
        start = time.monotonic()

        async with self._cycle_lock:
            snapshot = list(self._registry.values())

        online = [s for s in snapshot if s.status == "online"]
        if not online:
            return

        sem = asyncio.Semaphore(self._settings.orchestrator_max_concurrent_checks)
        success = 0
        failure = 0

        async def _collect(slot: DeviceSlot) -> None:
            nonlocal success, failure
            async with sem:
                try:
                    await self._collect_device_metrics(slot)
                    success += 1
                except Exception:
                    failure += 1

        await asyncio.gather(*[_collect(s) for s in online], return_exceptions=True)

        duration_ms = round((time.monotonic() - start) * 1000, 1)
        logger.info(
            "metrics_cycle_complete",
            total=len(snapshot), success=success, failure=failure,
            duration_ms=duration_ms,
        )

    async def _collect_device_metrics(self, slot: DeviceSlot) -> None:
        """采集单台设备指标并评估告警。"""
        # 网络 I/O 在锁外执行，避免阻塞 connect/disconnect API
        try:
            driver = await asyncio.wait_for(
                self._device_pool.get_driver(slot.device_id),
                timeout=self._settings.orchestrator_operation_timeout_s,
            )
            metrics = await asyncio.wait_for(
                self._metrics_collector.collect(driver, slot.device_id),
                timeout=self._settings.orchestrator_operation_timeout_s,
            )
        except Exception as exc:
            logger.warning(
                "metrics_collect_failed",
                device_id=slot.device_id, error=str(exc),
            )
            return

        # 锁内更新时间戳
        async with slot.lock:
            slot.last_metrics_collection = time.monotonic()

        # 锁外评估告警
        await self._alert_engine.evaluate(slot.device_id, metrics)

    # ── 设备热插拔 ────────────────────────────────────────────────────

    async def register_device(self, device_record: dict) -> DeviceSlot:
        """注册设备到 Registry（不自动连接）。

        供 API create_device 端点调用。设备创建后只注册到内存，
        用户点击"连接"按钮时再通过 connect_device_manual 触发连接。
        如果设备已在 registry 中则跳过。
        """
        device_id = str(device_record["id"])
        if device_id in self._registry:
            return self._registry[device_id]

        slot = DeviceSlot(
            device_id=device_id,
            name=device_record.get("name", ""),
            host=device_record.get("host", ""),
            port=device_record.get("port", 443),
            profile_id=device_record.get("profile_id", ""),
            tenant_id=device_record.get("tenant_id"),
            username=device_record.get("username", ""),
            password=device_record.get("password", ""),
            use_tls=device_record.get("use_tls", False),
            status="offline",
        )

        async with self._cycle_lock:
            self._registry[device_id] = slot
            self._ip_to_device[slot.host] = device_id

        await self._publish_lifecycle_event(EventType.DEVICE_ADDED, slot,
                                            host=slot.host, profile_id=slot.profile_id)
        return slot

    async def add_device(self, device_record: dict) -> DeviceSlot:
        """运行时添加设备到 Registry 并尝试连接。"""
        device_id = str(device_record["id"])
        slot = DeviceSlot(
            device_id=device_id,
            name=device_record.get("name", ""),
            host=device_record.get("host", ""),
            port=device_record.get("port", 443),
            profile_id=device_record.get("profile_id", ""),
            tenant_id=device_record.get("tenant_id"),
            username=device_record.get("username", ""),
            password=device_record.get("password", ""),
            use_tls=device_record.get("use_tls", False),
            status="connecting",
        )

        async with self._cycle_lock:
            self._registry[device_id] = slot
            self._ip_to_device[slot.host] = device_id

        await self._publish_lifecycle_event(EventType.DEVICE_ADDED, slot,
                                            host=slot.host, profile_id=slot.profile_id)
        await self._connect_device(slot)
        return slot

    async def remove_device(self, device_id: str) -> None:
        """从 Registry 移除设备。DB 删除优先，失败则中止。"""
        slot = self._registry.get(device_id)
        if not slot:
            raise KeyError(f"Device {device_id} not in registry")

        # DB 先删，失败则中止（保持内存与 DB 一致）
        await self._device_manager.delete_device(device_id)

        # 标记为已删除，阻断正在进行中的 _connect_device（TOCTOU 校验会拦截）
        async with slot.lock:
            slot.status = "deleted"

        # DB 删除成功后才清理内存
        async with self._cycle_lock:
            self._registry.pop(device_id, None)
            self._ip_to_device.pop(slot.host, None)

        try:
            await self._device_pool.remove(device_id)
        except Exception:
            logger.warning("device_pool_remove_failed", device_id=device_id)

        await self._publish_lifecycle_event(EventType.DEVICE_REMOVED, slot)

    async def update_device(self, device_id: str, changes: dict) -> DeviceSlot:
        """更新设备字段，host/port 变化时重连。"""
        slot = self._registry.get(device_id)
        if not slot:
            raise KeyError(f"Device {device_id} not in registry")

        need_reconnect = False
        old_host = slot.host

        async with slot.lock:
            for key, value in changes.items():
                if key in ("name", "username", "password", "use_tls", "profile_id", "tenant_id"):
                    setattr(slot, key, value)
                elif key == "host":
                    slot.host = value
                    need_reconnect = True
                elif key == "port":
                    slot.port = value
                    need_reconnect = True

            if need_reconnect:
                slot.status = "connecting"
                slot.metadata.pop("manual_disconnect", None)

        # 耗时网络操作移出 slot.lock，避免阻塞健康检查
        if need_reconnect:
            async with self._cycle_lock:
                self._ip_to_device.pop(old_host, None)
                self._ip_to_device[slot.host] = device_id

            async def _bg_reconnect() -> None:
                try:
                    try:
                        await self._device_pool.remove(device_id)
                    except Exception:
                        pass
                    await self._connect_device(slot)
                except Exception:
                    logger.exception("bg_reconnect_error", device_id=device_id)

            asyncio.create_task(_bg_reconnect())

        return slot

    # ── 手动连接/断开（供 API 调用） ─────────────────────────────────

    async def connect_device_manual(self, device_id: str) -> bool:
        """手动触发设备连接（供 API 调用）。

        异步触发连接，立即返回 True 表示已受理。
        连接结果通过 SSE 事件（DEVICE_ONLINE / DEVICE_OFFLINE）通知前端。
        """
        slot = self._registry.get(device_id)
        if not slot:
            raise KeyError(f"Device {device_id} not in registry")

        async with slot.lock:
            slot.status = "connecting"
            slot.metadata.pop("manual_disconnect", None)
        await self._sync_device_status_to_db(slot)

        # 异步触发连接，不阻塞 API 返回——避免 SSE 事件在 HTTP 响应之前到达前端
        async def _do_connect() -> None:
            try:
                success = await self._connect_device(slot)
                if not success:
                    # 连接失败时发布 OFFLINE 事件，让前端从 connecting 恢复
                    await self._publish_lifecycle_event(
                        EventType.DEVICE_OFFLINE, slot,
                        failure_reason="connection_failed",
                    )
            except Exception:
                logger.exception(
                    "connect_device_manual_task_error", device_id=device_id,
                )

        asyncio.create_task(_do_connect())
        return True  # 已受理

    async def disconnect_device_manual(self, device_id: str) -> None:
        """手动断开设备连接（供 API 调用）。"""
        slot = self._registry.get(device_id)
        if not slot:
            raise KeyError(f"Device {device_id} not in registry")

        async with slot.lock:
            slot.status = "offline"
            slot.consecutive_failures = 0
            slot.metadata["manual_disconnect"] = True

        # 锁外执行连接池清理（可能涉及网络 I/O）
        try:
            await self._device_pool.remove(device_id)
        except Exception:
            pass

        await self._sync_device_status_to_db(slot)
        await self._publish_lifecycle_event(
            EventType.DEVICE_OFFLINE, slot, failure_reason="manual_disconnect",
        )
