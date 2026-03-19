"""
拓扑图序列化/反序列化 — JSON 持久化

Requirements: 16.2
"""

from __future__ import annotations

import time
from typing import Any

from opsevo.services.topology.types import (
    TopologyGraph, TopologyNode, TopologyEdge,
    NodeState, DeviceType, StabilityTier,
)


def serialize_graph(graph: TopologyGraph) -> dict[str, Any]:
    """将 TopologyGraph 序列化为 JSON-safe dict。"""
    return {
        "nodes": [_serialize_node(n) for n in graph.nodes.values()],
        "edges": [_serialize_edge(e) for e in graph.edges.values()],
        "version": graph.version,
        "lastUpdatedAt": graph.last_updated_at,
    }


def deserialize_graph(data: dict[str, Any]) -> TopologyGraph:
    """从 JSON dict 反序列化为 TopologyGraph。"""
    nodes: dict[str, TopologyNode] = {}
    for nd in data.get("nodes", []):
        node = _deserialize_node(nd)
        nodes[node.id] = node
    edges: dict[str, TopologyEdge] = {}
    for ed in data.get("edges", []):
        edge = _deserialize_edge(ed)
        edges[edge.id] = edge
    return TopologyGraph(
        nodes=nodes, edges=edges,
        version=data.get("version", 0),
        last_updated_at=data.get("lastUpdatedAt", time.time()),
    )


def _serialize_node(n: TopologyNode) -> dict[str, Any]:
    d: dict[str, Any] = {
        "id": n.id, "hostname": n.hostname, "ipAddresses": n.ip_addresses,
        "macAddress": n.mac_address, "deviceType": n.device_type,
        "stabilityTier": n.stability_tier, "state": n.state,
        "confirmCount": n.confirm_count, "missCount": n.miss_count,
        "discoveredAt": n.discovered_at, "lastSeenAt": n.last_seen_at,
        "sources": n.sources,
    }
    if n.device_id:
        d["deviceId"] = n.device_id
    if n.connected_to:
        d["connectedTo"] = n.connected_to
    if n.endpoint_info:
        d["endpointInfo"] = n.endpoint_info
    return d


def _deserialize_node(d: dict[str, Any]) -> TopologyNode:
    return TopologyNode(
        id=d["id"], hostname=d.get("hostname", ""),
        ip_addresses=d.get("ipAddresses", []),
        mac_address=d.get("macAddress", ""),
        device_type=d.get("deviceType", DeviceType.ENDPOINT),
        stability_tier=d.get("stabilityTier", StabilityTier.ENDPOINT),
        state=d.get("state", NodeState.PENDING),
        device_id=d.get("deviceId"),
        confirm_count=d.get("confirmCount", 0),
        miss_count=d.get("missCount", 0),
        discovered_at=d.get("discoveredAt", 0),
        last_seen_at=d.get("lastSeenAt", 0),
        sources=d.get("sources", []),
        connected_to=d.get("connectedTo"),
        endpoint_info=d.get("endpointInfo"),
    )


def _serialize_edge(e: TopologyEdge) -> dict[str, Any]:
    return {
        "id": e.id, "sourceId": e.source_id, "targetId": e.target_id,
        "localInterface": e.local_interface, "remoteInterface": e.remote_interface,
        "confidence": e.confidence, "sources": e.sources, "state": e.state,
        "confirmCount": e.confirm_count, "missCount": e.miss_count,
        "discoveredAt": e.discovered_at, "lastSeenAt": e.last_seen_at,
        "localInterfaceRunning": e.local_interface_running,
        "remoteInterfaceRunning": e.remote_interface_running,
    }


def _deserialize_edge(d: dict[str, Any]) -> TopologyEdge:
    return TopologyEdge(
        id=d["id"], source_id=d.get("sourceId", ""), target_id=d.get("targetId", ""),
        local_interface=d.get("localInterface", ""),
        remote_interface=d.get("remoteInterface", ""),
        confidence=d.get("confidence", 0.0), sources=d.get("sources", []),
        state=d.get("state", NodeState.PENDING),
        confirm_count=d.get("confirmCount", 0), miss_count=d.get("missCount", 0),
        discovered_at=d.get("discoveredAt", 0), last_seen_at=d.get("lastSeenAt", 0),
        local_interface_running=d.get("localInterfaceRunning", True),
        remote_interface_running=d.get("remoteInterfaceRunning", True),
    )
