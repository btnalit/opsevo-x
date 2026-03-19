"""
拓扑差分引擎 — 比较两个 TopologyGraph 生成 TopologyDiff

Requirements: 16.2
"""

from __future__ import annotations

import time
import uuid
from typing import Any

from opsevo.services.topology.types import (
    TopologyGraph, TopologyDiff, TopologyNode, TopologyEdge,
)


def compute_diff(old_graph: TopologyGraph, new_graph: TopologyGraph) -> TopologyDiff:
    """比较新旧拓扑图，生成差分。"""
    now = time.time()
    nodes_added: list[TopologyNode] = []
    nodes_removed: list[TopologyNode] = []
    nodes_updated: list[dict[str, Any]] = []
    edges_added: list[TopologyEdge] = []
    edges_removed: list[TopologyEdge] = []
    edges_updated: list[dict[str, Any]] = []

    # Nodes
    for nid, node in new_graph.nodes.items():
        if nid not in old_graph.nodes:
            nodes_added.append(node)
        else:
            changes = _diff_node(old_graph.nodes[nid], node)
            if changes:
                nodes_updated.append({"node_id": nid, "changes": changes})
    for nid, node in old_graph.nodes.items():
        if nid not in new_graph.nodes:
            nodes_removed.append(node)

    # Edges
    for eid, edge in new_graph.edges.items():
        if eid not in old_graph.edges:
            edges_added.append(edge)
        else:
            changes = _diff_edge(old_graph.edges[eid], edge)
            if changes:
                edges_updated.append({"edge_id": eid, "changes": changes})
    for eid, edge in old_graph.edges.items():
        if eid not in new_graph.edges:
            edges_removed.append(edge)

    return TopologyDiff(
        id=f"diff-{uuid.uuid4().hex[:8]}",
        timestamp=now,
        nodes_added=nodes_added, nodes_removed=nodes_removed,
        edges_added=edges_added, edges_removed=edges_removed,
        edges_updated=edges_updated, nodes_updated=nodes_updated,
    )


def _diff_node(old: TopologyNode, new: TopologyNode) -> dict[str, dict[str, Any]]:
    changes: dict[str, dict[str, Any]] = {}
    for attr in ("state", "confirm_count", "miss_count", "ip_addresses", "sources"):
        ov = getattr(old, attr)
        nv = getattr(new, attr)
        if ov != nv:
            changes[attr] = {"old": ov, "new": nv}
    return changes


def _diff_edge(old: TopologyEdge, new: TopologyEdge) -> dict[str, dict[str, Any]]:
    changes: dict[str, dict[str, Any]] = {}
    for attr in ("state", "confidence", "confirm_count", "miss_count", "sources",
                 "local_interface_running", "remote_interface_running"):
        ov = getattr(old, attr)
        nv = getattr(new, attr)
        if ov != nv:
            changes[attr] = {"old": ov, "new": nv}
    return changes
