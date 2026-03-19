"""
TopologyDiscoveryService — 拓扑发现核心服务

分层轮询调度、完整发现流程、配置管理、持久化。
拓扑数据收集使用 DeviceDriver.collect_data('topology')，不使用厂商特定命令。

Requirements: 16.1, 16.2, 16.3
"""

from __future__ import annotations

import asyncio
import json
import time
import uuid
from pathlib import Path
from typing import Any, Callable, Awaitable

import structlog

from opsevo.events.event_bus import EventBus
from opsevo.events.types import EventType, PerceptionEvent, Priority
from opsevo.services.topology.candidate_graph import build_candidate_graph
from opsevo.services.topology.dampening_engine import DampeningTimer, SlidingWindow
from opsevo.services.topology.data_collector import collect_all_devices_data
from opsevo.services.topology.diff_engine import compute_diff
from opsevo.services.topology.edge_utils import calculate_edge_confidence
from opsevo.services.topology.graph_serializer import deserialize_graph, serialize_graph
from opsevo.services.topology.kgb_adapter import sync_diff_to_knowledge_graph
from opsevo.services.topology.state_machine import (
    StateMachineEntity, on_entity_missed, on_entity_seen,
)
from opsevo.services.topology.types import (
    TopologyDiscoveryConfig, TopologyDiff, TopologyGraph,
    TopologyStats, TopologyChangeEvent, NodeState, StabilityTier,
    is_diff_empty,
)

logger = structlog.get_logger(__name__)

DATA_DIR = Path("data/ai-ops")


class TopologyDiscoveryService:
    """拓扑发现核心服务 — 分层轮询、状态机、差分、抑制。"""

    def __init__(self) -> None:
        self._config = TopologyDiscoveryConfig()
        self._graph = TopologyGraph()
        self._stats = TopologyStats()
        self._diff_history: list[TopologyDiff] = []

        self._sliding_window = SlidingWindow(self._config.sliding_window_size)
        self._dampening_timer = DampeningTimer(
            self._config.dampening_timer_ms, self._publish_diff,
        )

        # Polling tasks
        self._fast_task: asyncio.Task | None = None
        self._medium_task: asyncio.Task | None = None
        self._slow_task: asyncio.Task | None = None

        # Dependency injection
        self._get_devices: Callable[[], Awaitable[list[dict[str, Any]]]] | None = None
        self._get_connection: Any = None
        self._on_topology_change: Callable[[TopologyChangeEvent], None] | None = None
        self._event_bus: EventBus | None = None
        self._knowledge_graph: Any = None

        self._initialized = False
        self._running = False
        self._started_at = 0.0

    # ─── Dependency injection ───

    def set_device_provider(self, fn: Callable[[], Awaitable[list[dict[str, Any]]]]) -> None:
        self._get_devices = fn

    def set_connection_provider(self, fn: Any) -> None:
        self._get_connection = fn

    def set_topology_change_handler(self, fn: Callable[[TopologyChangeEvent], None]) -> None:
        self._on_topology_change = fn

    def set_event_bus(self, eb: EventBus) -> None:
        self._event_bus = eb

    def set_knowledge_graph_builder(self, kg: Any) -> None:
        self._knowledge_graph = kg

    # ─── Lifecycle ───

    async def initialize(self) -> None:
        if self._initialized:
            return
        await self._load_config()
        await self._load_graph()
        await self._load_diff_history()
        self._initialized = True

    async def start(self) -> None:
        if self._running:
            return
        if not self._initialized:
            await self.initialize()
        if not self._config.enabled:
            logger.info("TopologyDiscovery disabled by config")
            return
        self._started_at = time.time()
        self._start_polling_timers()
        self._running = True
        logger.info("TopologyDiscoveryService started")

    async def stop(self) -> None:
        if not self._running:
            return
        self._stop_polling_timers()
        self._dampening_timer.stop()
        self._running = False
        await self._save_graph()
        logger.info("TopologyDiscoveryService stopped")

    @property
    def is_running(self) -> bool:
        return self._running

    def get_config(self) -> TopologyDiscoveryConfig:
        return TopologyDiscoveryConfig(**{
            k: getattr(self._config, k) for k in self._config.__dataclass_fields__
        })

    async def update_config(self, **updates: Any) -> None:
        for k, v in updates.items():
            if hasattr(self._config, k):
                setattr(self._config, k, v)
        self._sliding_window = SlidingWindow(self._config.sliding_window_size)
        self._dampening_timer.stop()
        self._dampening_timer = DampeningTimer(
            self._config.dampening_timer_ms, self._publish_diff,
        )
        await self._save_config()
        if self._running:
            self._stop_polling_timers()
            self._start_polling_timers()

    def get_topology_graph(self) -> TopologyGraph:
        return self._graph

    def get_diff_history(self, limit: int = 20) -> list[TopologyDiff]:
        return self._diff_history[-limit:]

    def get_stats(self) -> TopologyStats:
        self._stats.current_node_count = len(self._graph.nodes)
        self._stats.current_edge_count = len(self._graph.edges)
        return self._stats

    async def trigger_full_discovery(self) -> None:
        await self._execute_discovery("slow")

    async def trigger_device_update(self, device_id: str) -> None:
        if not self._get_devices or not self._get_connection:
            return
        devices = await self._get_devices()
        target = [d for d in devices if d["id"] == device_id]
        if not target:
            return
        all_data = await collect_all_devices_data(
            target, self._get_connection, max_concurrent=1,
        )
        if all_data:
            candidate = build_candidate_graph(
                all_data, self._config.endpoint_discovery_enabled,
            )
            self._advance_state_machine(candidate, [], "slow")


    # ─── Core discovery ───

    async def _execute_discovery(self, tier: str) -> None:
        if not self._get_devices or not self._get_connection:
            logger.warn("TopologyDiscovery: no device/connection provider set")
            return

        start = time.time()
        self._stats.total_rounds += 1

        try:
            devices = await self._get_devices()
            if not devices:
                self._stats.successful_rounds += 1
                return

            all_data = await collect_all_devices_data(
                devices, self._get_connection,
                max_concurrent=self._config.max_concurrent_device_queries,
            )

            # Track query errors
            for data in all_data:
                self._stats.device_query_errors += len(data.errors)

            skipped_ids = [
                d["id"] for d in devices
                if d["id"] not in {dd.device_id for dd in all_data}
            ]

            candidate = build_candidate_graph(
                all_data, self._config.endpoint_discovery_enabled,
            )

            self._advance_state_machine(candidate, skipped_ids, tier)

            duration = (time.time() - start) * 1000
            self._stats.successful_rounds += 1
            self._stats.last_discovery_at = time.time()
            # Running average
            n = self._stats.successful_rounds
            self._stats.average_duration_ms = (
                (self._stats.average_duration_ms * (n - 1) + duration) / n
            )

            await self._save_graph()

        except Exception as exc:
            self._stats.failed_rounds += 1
            logger.error("Discovery round failed", tier=tier, error=str(exc))

    def _advance_state_machine(
        self, candidate: TopologyGraph, skipped_device_ids: list[str], tier: str,
    ) -> None:
        """Apply state machine transitions and compute diff."""
        now = time.time()
        old_graph = TopologyGraph(
            nodes=dict(self._graph.nodes),
            edges=dict(self._graph.edges),
            version=self._graph.version,
            last_updated_at=self._graph.last_updated_at,
        )

        # Record sliding window snapshot for edges
        present_edge_ids = set(candidate.edges.keys())
        self._sliding_window.record_snapshot(present_edge_ids)

        # Process nodes
        seen_node_ids = set(candidate.nodes.keys())
        for nid, node in candidate.nodes.items():
            if nid in self._graph.nodes:
                existing = self._graph.nodes[nid]
                entity = StateMachineEntity(
                    state=existing.state, confirm_count=existing.confirm_count,
                    miss_count=existing.miss_count, last_seen_at=existing.last_seen_at,
                    stability_tier=existing.stability_tier,
                )
                updated = on_entity_seen(entity, existing.stability_tier, self._config, now)
                existing.state = updated.state
                existing.confirm_count = updated.confirm_count
                existing.miss_count = updated.miss_count
                existing.last_seen_at = updated.last_seen_at
            else:
                self._graph.nodes[nid] = node

        # Miss unseen nodes (skip devices that failed to respond)
        for nid, node in list(self._graph.nodes.items()):
            if nid in seen_node_ids:
                continue
            # Don't penalize nodes belonging to skipped devices
            if node.device_id and node.device_id in skipped_device_ids:
                continue
            entity = StateMachineEntity(
                state=node.state, confirm_count=node.confirm_count,
                miss_count=node.miss_count, last_seen_at=node.last_seen_at,
                stability_tier=node.stability_tier,
            )
            result = on_entity_missed(entity, node.stability_tier, self._config, now)
            if result is None:
                del self._graph.nodes[nid]
            else:
                node.state = result.state
                node.miss_count = result.miss_count

        # Process edges
        for eid, edge in candidate.edges.items():
            snapshots = self._sliding_window.get_snapshots(eid)
            confidence = calculate_edge_confidence(
                edge.sources, self._config.edge_confidence_weights, snapshots,
            )
            if eid in self._graph.edges:
                existing = self._graph.edges[eid]
                entity = StateMachineEntity(
                    state=existing.state, confirm_count=existing.confirm_count,
                    miss_count=existing.miss_count, last_seen_at=existing.last_seen_at,
                    stability_tier=StabilityTier.INFRASTRUCTURE,
                )
                updated = on_entity_seen(entity, StabilityTier.INFRASTRUCTURE, self._config, now)
                existing.state = updated.state
                existing.confirm_count = updated.confirm_count
                existing.miss_count = updated.miss_count
                existing.last_seen_at = updated.last_seen_at
                existing.confidence = confidence
            else:
                edge.confidence = confidence
                self._graph.edges[eid] = edge

        # Miss unseen edges
        for eid, edge in list(self._graph.edges.items()):
            if eid in present_edge_ids:
                continue
            entity = StateMachineEntity(
                state=edge.state, confirm_count=edge.confirm_count,
                miss_count=edge.miss_count, last_seen_at=edge.last_seen_at,
                stability_tier=StabilityTier.INFRASTRUCTURE,
            )
            result = on_entity_missed(entity, StabilityTier.INFRASTRUCTURE, self._config, now)
            if result is None:
                del self._graph.edges[eid]
                self._sliding_window.remove_edge(eid)
            else:
                edge.state = result.state
                edge.miss_count = result.miss_count

        self._graph.version += 1
        self._graph.last_updated_at = now

        # Compute diff
        diff = compute_diff(old_graph, self._graph)
        if not is_diff_empty(diff):
            self._stats.total_changes_detected += 1
            self._dampening_timer.add_diff(diff)


    # ─── Diff publishing ───

    def _publish_diff(self, diff: TopologyDiff) -> None:
        """Called by DampeningTimer when flushing merged diffs."""
        self._diff_history.append(diff)
        # Keep max 100 diffs
        if len(self._diff_history) > 100:
            self._diff_history = self._diff_history[-100:]

        change_event = self._create_change_event(diff)

        if self._on_topology_change:
            try:
                self._on_topology_change(change_event)
            except Exception as exc:
                logger.error("Topology change handler error", error=str(exc))

        # Publish to EventBus
        if self._event_bus:
            event = PerceptionEvent(
                type=EventType.INTERNAL,
                priority=Priority.LOW,
                source="topology-discovery",
                payload={
                    "event": "topology_changed",
                    "diff_id": diff.id,
                    "summary": change_event.diff_summary,
                    "severity": change_event.severity,
                    "nodes_added": len(diff.nodes_added),
                    "nodes_removed": len(diff.nodes_removed),
                    "edges_added": len(diff.edges_added),
                    "edges_removed": len(diff.edges_removed),
                },
                schema_version="1.0.0",
            )
            asyncio.create_task(self._event_bus.publish(event))

        # Sync to knowledge graph
        if self._knowledge_graph:
            asyncio.create_task(
                sync_diff_to_knowledge_graph(self._knowledge_graph, diff)
            )

        # Persist
        asyncio.create_task(self._save_diff_history())

    def _create_change_event(self, diff: TopologyDiff) -> TopologyChangeEvent:
        parts: list[str] = []
        if diff.nodes_added:
            parts.append(f"+{len(diff.nodes_added)} nodes")
        if diff.nodes_removed:
            parts.append(f"-{len(diff.nodes_removed)} nodes")
        if diff.edges_added:
            parts.append(f"+{len(diff.edges_added)} edges")
        if diff.edges_removed:
            parts.append(f"-{len(diff.edges_removed)} edges")
        summary = ", ".join(parts) if parts else "no changes"

        # Determine severity
        severity = "info"
        if diff.edges_removed and len(diff.edges_removed) >= self._config.critical_edge_loss_threshold:
            severity = "critical"
        elif diff.nodes_removed or diff.edges_removed:
            severity = "warning"

        return TopologyChangeEvent(
            id=f"topo-event-{uuid.uuid4().hex[:8]}",
            timestamp=diff.timestamp,
            diff_summary=summary,
            diff=diff,
            severity=severity,
        )

    # ─── Polling timers ───

    def _start_polling_timers(self) -> None:
        async def _poll_loop(interval_ms: int, tier: str) -> None:
            while True:
                await asyncio.sleep(interval_ms / 1000.0)
                if not self._running:
                    break
                await self._execute_discovery(tier)

        self._fast_task = asyncio.create_task(
            _poll_loop(self._config.fast_poll_interval_ms, "fast")
        )
        self._medium_task = asyncio.create_task(
            _poll_loop(self._config.medium_poll_interval_ms, "medium")
        )
        self._slow_task = asyncio.create_task(
            _poll_loop(self._config.slow_poll_interval_ms, "slow")
        )

    def _stop_polling_timers(self) -> None:
        for task in (self._fast_task, self._medium_task, self._slow_task):
            if task and not task.done():
                task.cancel()
        self._fast_task = None
        self._medium_task = None
        self._slow_task = None

    # ─── Persistence ───

    async def _load_config(self) -> None:
        config_file = DATA_DIR / "topology-discovery-config.json"
        try:
            if config_file.exists():
                data = json.loads(config_file.read_text())
                for k, v in data.items():
                    # Convert camelCase to snake_case
                    snake = _camel_to_snake(k)
                    if hasattr(self._config, snake):
                        setattr(self._config, snake, v)
        except Exception as exc:
            logger.warn("Failed to load topology config", error=str(exc))

    async def _save_config(self) -> None:
        config_file = DATA_DIR / "topology-discovery-config.json"
        try:
            config_file.parent.mkdir(parents=True, exist_ok=True)
            data = {k: getattr(self._config, k) for k in self._config.__dataclass_fields__}
            config_file.write_text(json.dumps(data, indent=2))
        except Exception as exc:
            logger.warn("Failed to save topology config", error=str(exc))

    async def _load_graph(self) -> None:
        graph_file = DATA_DIR / "topology-graph.json"
        try:
            if graph_file.exists():
                data = json.loads(graph_file.read_text())
                self._graph = deserialize_graph(data)
        except Exception as exc:
            logger.warn("Failed to load topology graph", error=str(exc))

    async def _save_graph(self) -> None:
        graph_file = DATA_DIR / "topology-graph.json"
        try:
            graph_file.parent.mkdir(parents=True, exist_ok=True)
            data = serialize_graph(self._graph)
            graph_file.write_text(json.dumps(data, indent=2))
        except Exception as exc:
            logger.warn("Failed to save topology graph", error=str(exc))

    async def _load_diff_history(self) -> None:
        hist_file = DATA_DIR / "topology-diff-history.json"
        try:
            if hist_file.exists():
                self._diff_history = []  # Simplified: just clear on load
                # Full deserialization would require TopologyDiff from JSON
        except Exception as exc:
            logger.warn("Failed to load diff history", error=str(exc))

    async def _save_diff_history(self) -> None:
        hist_file = DATA_DIR / "topology-diff-history.json"
        try:
            hist_file.parent.mkdir(parents=True, exist_ok=True)
            # Simplified: store just IDs and timestamps
            data = [{"id": d.id, "timestamp": d.timestamp} for d in self._diff_history[-50:]]
            hist_file.write_text(json.dumps(data, indent=2))
        except Exception as exc:
            logger.warn("Failed to save diff history", error=str(exc))

    # ─── Health check ───

    async def health_check(self) -> dict[str, Any]:
        return {
            "name": "topology-discovery",
            "healthy": self._running or not self._config.enabled,
            "running": self._running,
            "node_count": len(self._graph.nodes),
            "edge_count": len(self._graph.edges),
            "last_discovery_at": self._stats.last_discovery_at,
        }


def _camel_to_snake(name: str) -> str:
    """Convert camelCase to snake_case."""
    import re
    s1 = re.sub(r"(.)([A-Z][a-z]+)", r"\1_\2", name)
    return re.sub(r"([a-z0-9])([A-Z])", r"\1_\2", s1).lower()
