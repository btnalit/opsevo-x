"""
拓扑发现 — 类型定义

Requirements: 16.1, 16.2, 16.3
"""

from __future__ import annotations

import time
from dataclasses import dataclass, field
from enum import Enum
from typing import Any


class DiscoverySource(str, Enum):
    IP_NEIGHBOR = "ip-neighbor"
    ARP = "arp"
    LLDP = "lldp"
    CDP = "cdp"
    ROUTING_TABLE = "routing-table"
    INTERFACE_STATUS = "interface-status"


class NodeState(str, Enum):
    PENDING = "pending"
    CONFIRMED = "confirmed"
    STALE = "stale"


class StabilityTier(str, Enum):
    INFRASTRUCTURE = "infrastructure"
    ENDPOINT = "endpoint"


class DeviceType(str, Enum):
    ROUTER = "router"
    SWITCH = "switch"
    FIREWALL = "firewall"
    SERVER = "server"
    ENDPOINT = "endpoint"


@dataclass
class TopologyNode:
    id: str
    hostname: str
    ip_addresses: list[str]
    mac_address: str
    device_type: DeviceType
    stability_tier: StabilityTier
    state: NodeState = NodeState.PENDING
    device_id: str | None = None
    confirm_count: int = 0
    miss_count: int = 0
    discovered_at: float = field(default_factory=time.time)
    last_seen_at: float = field(default_factory=time.time)
    sources: list[str] = field(default_factory=list)
    connected_to: str | None = None
    endpoint_info: dict[str, Any] | None = None


@dataclass
class TopologyEdge:
    id: str
    source_id: str
    target_id: str
    local_interface: str
    remote_interface: str
    confidence: float = 0.0
    sources: list[str] = field(default_factory=list)
    state: NodeState = NodeState.PENDING
    confirm_count: int = 0
    miss_count: int = 0
    discovered_at: float = field(default_factory=time.time)
    last_seen_at: float = field(default_factory=time.time)
    local_interface_running: bool = True
    remote_interface_running: bool = True


@dataclass
class TopologyGraph:
    nodes: dict[str, TopologyNode] = field(default_factory=dict)
    edges: dict[str, TopologyEdge] = field(default_factory=dict)
    version: int = 0
    last_updated_at: float = field(default_factory=time.time)


@dataclass
class TopologyDiff:
    id: str
    timestamp: float
    nodes_added: list[TopologyNode] = field(default_factory=list)
    nodes_removed: list[TopologyNode] = field(default_factory=list)
    edges_added: list[TopologyEdge] = field(default_factory=list)
    edges_removed: list[TopologyEdge] = field(default_factory=list)
    edges_updated: list[dict[str, Any]] = field(default_factory=list)
    nodes_updated: list[dict[str, Any]] = field(default_factory=list)


@dataclass
class TopologyChangeEvent:
    id: str
    timestamp: float
    source: str = "topology"
    diff_summary: str = ""
    diff: TopologyDiff | None = None
    severity: str = "info"
    metadata: dict[str, Any] = field(default_factory=lambda: {"source": "topology"})


@dataclass
class TopologyStats:
    total_rounds: int = 0
    successful_rounds: int = 0
    failed_rounds: int = 0
    average_duration_ms: float = 0.0
    last_discovery_at: float | None = None
    current_node_count: int = 0
    current_edge_count: int = 0
    total_changes_detected: int = 0
    device_query_errors: int = 0


@dataclass
class TopologyDiscoveryConfig:
    enabled: bool = True
    fast_poll_interval_ms: int = 60_000
    medium_poll_interval_ms: int = 180_000
    slow_poll_interval_ms: int = 600_000
    infra_confirm_count: int = 5
    infra_stale_threshold_count: int = 7
    endpoint_confirm_count: int = 3
    endpoint_stale_threshold_count: int = 3
    stale_expiry_ms: int = 600_000
    edge_confidence_weights: dict[str, float] = field(default_factory=lambda: {
        "ip-neighbor": 0.4, "arp": 0.2, "lldp": 0.3,
        "cdp": 0.3, "routing-table": 0.1, "interface-status": 0.0,
    })
    critical_edge_loss_threshold: int = 3
    enabled_sources: list[str] = field(default_factory=lambda: [
        "ip-neighbor", "arp", "routing-table", "interface-status",
    ])
    dampening_timer_ms: int = 30_000
    sliding_window_size: int = 5
    endpoint_discovery_enabled: bool = True
    max_concurrent_device_queries: int = 2


@dataclass
class RawDiscoveryData:
    device_id: str
    tenant_id: str
    timestamp: float
    neighbors: list[dict[str, Any]] = field(default_factory=list)
    arp_entries: list[dict[str, Any]] = field(default_factory=list)
    interfaces: list[dict[str, Any]] = field(default_factory=list)
    routes: list[dict[str, Any]] = field(default_factory=list)
    dhcp_leases: list[dict[str, Any]] = field(default_factory=list)
    errors: list[dict[str, str]] = field(default_factory=list)
    device_name: str | None = None
    management_address: str | None = None


def is_diff_empty(diff: TopologyDiff) -> bool:
    return (
        not diff.nodes_added and not diff.nodes_removed
        and not diff.edges_added and not diff.edges_removed
        and not diff.edges_updated and not diff.nodes_updated
    )
