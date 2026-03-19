"""
抑制定时器与滑动窗口

SlidingWindow: 维护最近 N 个快照的边出现记录
DampeningTimer: 批量合并快速连续的变更

Requirements: 16.2
"""

from __future__ import annotations

import asyncio
import time
from typing import Any, Callable

from opsevo.services.topology.types import TopologyDiff, is_diff_empty


class SlidingWindow:
    """维护最近 N 个快照的边出现记录。"""

    def __init__(self, max_size: int) -> None:
        self._max_size = max(1, max_size)
        self._snapshots: dict[str, list[bool]] = {}

    def record_snapshot(self, present_edge_ids: set[str]) -> None:
        all_ids = set(self._snapshots.keys()) | present_edge_ids
        for edge_id in all_ids:
            history = self._snapshots.get(edge_id, [])
            history.append(edge_id in present_edge_ids)
            while len(history) > self._max_size:
                history.pop(0)
            self._snapshots[edge_id] = history

    def get_snapshots(self, edge_id: str) -> list[bool]:
        return self._snapshots.get(edge_id, [])

    def remove_edge(self, edge_id: str) -> None:
        self._snapshots.pop(edge_id, None)

    def prune_absent_edges(self, current_edges: dict[str, Any]) -> None:
        stale = [eid for eid in self._snapshots if eid not in current_edges]
        for eid in stale:
            del self._snapshots[eid]

    def clear(self) -> None:
        self._snapshots.clear()


class DampeningTimer:
    """批量合并快速连续的拓扑变更。"""

    def __init__(self, delay_ms: int, on_flush: Callable[[TopologyDiff], None]) -> None:
        self._delay_s = delay_ms / 1000.0
        self._on_flush = on_flush
        self._pending: list[TopologyDiff] = []
        self._task: asyncio.Task | None = None

    def add_diff(self, diff: TopologyDiff) -> None:
        if is_diff_empty(diff):
            return
        self._pending.append(diff)
        if self._task is None or self._task.done():
            self._task = asyncio.create_task(self._delayed_flush())

    async def _delayed_flush(self) -> None:
        await asyncio.sleep(self._delay_s)
        self.flush()

    def flush(self) -> None:
        if self._task and not self._task.done():
            self._task.cancel()
            self._task = None
        if not self._pending:
            return
        merged = self._merge_diffs(self._pending)
        self._pending = []
        if not is_diff_empty(merged):
            self._on_flush(merged)

    def stop(self) -> None:
        if self._task and not self._task.done():
            self._task.cancel()
            self._task = None

    @property
    def pending_count(self) -> int:
        return len(self._pending)

    def _merge_diffs(self, diffs: list[TopologyDiff]) -> TopologyDiff:
        now = time.time()
        nodes_added: dict[str, Any] = {}
        nodes_removed: dict[str, Any] = {}
        edges_added: dict[str, Any] = {}
        edges_removed: dict[str, Any] = {}
        edges_updated: dict[str, dict] = {}
        nodes_updated: dict[str, dict] = {}

        for diff in diffs:
            for n in diff.nodes_added:
                nodes_removed.pop(n.id, None)
                nodes_added[n.id] = n
            for n in diff.nodes_removed:
                if n.id in nodes_added:
                    del nodes_added[n.id]
                else:
                    nodes_removed[n.id] = n
            for e in diff.edges_added:
                edges_removed.pop(e.id, None)
                edges_added[e.id] = e
            for e in diff.edges_removed:
                if e.id in edges_added:
                    del edges_added[e.id]
                else:
                    edges_removed[e.id] = e
                edges_updated.pop(e.id, None)
            for u in diff.edges_updated:
                eid = u["edgeId"] if "edgeId" in u else u.get("edge_id", "")
                existing = edges_updated.get(eid)
                if existing:
                    for k, v in u.get("changes", {}).items():
                        if k in existing["changes"]:
                            existing["changes"][k]["new"] = v["new"]
                        else:
                            existing["changes"][k] = v
                else:
                    edges_updated[eid] = {**u, "changes": dict(u.get("changes", {}))}
            for u in diff.nodes_updated:
                nid = u["nodeId"] if "nodeId" in u else u.get("node_id", "")
                existing = nodes_updated.get(nid)
                if existing:
                    for k, v in u.get("changes", {}).items():
                        if k in existing["changes"]:
                            existing["changes"][k]["new"] = v["new"]
                        else:
                            existing["changes"][k] = v
                else:
                    nodes_updated[nid] = {**u, "changes": dict(u.get("changes", {}))}

        return TopologyDiff(
            id=f"diff-merged-{now}",
            timestamp=now,
            nodes_added=list(nodes_added.values()),
            nodes_removed=list(nodes_removed.values()),
            edges_added=list(edges_added.values()),
            edges_removed=list(edges_removed.values()),
            edges_updated=list(edges_updated.values()),
            nodes_updated=list(nodes_updated.values()),
        )
