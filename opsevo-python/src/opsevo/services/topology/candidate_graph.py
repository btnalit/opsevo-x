"""
候选图构建器 — 从原始采集数据构建候选拓扑图

Requirements: 16.2
"""

from __future__ import annotations

import time
from typing import Any

from opsevo.services.topology.edge_utils import generate_edge_id
from opsevo.services.topology.mac_normalizer import normalize_mac
from opsevo.services.topology.types import (
    DeviceType, NodeState, RawDiscoveryData, StabilityTier,
    TopologyEdge, TopologyGraph, TopologyNode,
)


def build_candidate_graph(
    all_data: list[RawDiscoveryData],
    endpoint_discovery_enabled: bool = True,
) -> TopologyGraph:
    """从多个设备的原始采集数据构建候选拓扑图。"""
    now = time.time()
    nodes: dict[str, TopologyNode] = {}
    edges: dict[str, TopologyEdge] = {}

    # 先为每个被管理设备创建节点
    for data in all_data:
        node_id = f"device-{data.device_id}"
        if node_id not in nodes:
            nodes[node_id] = TopologyNode(
                id=node_id,
                device_id=data.device_id,
                hostname=data.device_name or data.device_id,
                ip_addresses=[data.management_address] if data.management_address else [],
                mac_address="",
                device_type=DeviceType.ROUTER,
                stability_tier=StabilityTier.INFRASTRUCTURE,
                state=NodeState.PENDING,
                discovered_at=now,
                last_seen_at=now,
                sources=["managed"],
            )

    # 处理邻居发现数据
    for data in all_data:
        src_node_id = f"device-{data.device_id}"
        for neighbor in data.neighbors:
            mac = normalize_mac(neighbor.get("macAddress", ""))
            identity = neighbor.get("identity", "unknown")
            target_id = f"neighbor-{mac}" if mac else f"neighbor-{identity}"

            if target_id not in nodes:
                nodes[target_id] = TopologyNode(
                    id=target_id, hostname=identity,
                    ip_addresses=[neighbor["address"]] if neighbor.get("address") else [],
                    mac_address=mac,
                    device_type=DeviceType.SWITCH,
                    stability_tier=StabilityTier.INFRASTRUCTURE,
                    state=NodeState.PENDING,
                    discovered_at=now, last_seen_at=now,
                    sources=[neighbor.get("discoverySource", "ip-neighbor")],
                )

            local_if = neighbor.get("interface", "")
            edge_id = generate_edge_id(src_node_id, target_id, local_if, "")
            if edge_id not in edges:
                edges[edge_id] = TopologyEdge(
                    id=edge_id, source_id=src_node_id, target_id=target_id,
                    local_interface=local_if, remote_interface="",
                    sources=[neighbor.get("discoverySource", "ip-neighbor")],
                    state=NodeState.PENDING,
                    discovered_at=now, last_seen_at=now,
                )

    # 处理 ARP 数据（endpoint 发现）
    if endpoint_discovery_enabled:
        for data in all_data:
            src_node_id = f"device-{data.device_id}"
            for arp in data.arp_entries:
                mac = normalize_mac(arp.get("macAddress", ""))
                if not mac:
                    continue
                ep_id = f"endpoint-{mac}"
                if ep_id not in nodes:
                    nodes[ep_id] = TopologyNode(
                        id=ep_id, hostname=arp.get("address", ""),
                        ip_addresses=[arp["address"]] if arp.get("address") else [],
                        mac_address=mac,
                        device_type=DeviceType.ENDPOINT,
                        stability_tier=StabilityTier.ENDPOINT,
                        state=NodeState.PENDING,
                        discovered_at=now, last_seen_at=now,
                        sources=["arp"],
                        connected_to=src_node_id,
                    )

    return TopologyGraph(nodes=nodes, edges=edges, version=0, last_updated_at=now)
