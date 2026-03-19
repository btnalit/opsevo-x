"""
KnowledgeGraphBuilder 适配器 — 将拓扑变更同步到知识图谱

Requirements: 16.3
"""

from __future__ import annotations

from typing import Any, Protocol

import structlog

from opsevo.services.topology.types import TopologyDiff

logger = structlog.get_logger(__name__)


class KnowledgeGraphBuilder(Protocol):
    """Protocol for knowledge graph integration."""
    async def add_entity(self, entity_type: str, entity_id: str, properties: dict[str, Any]) -> None: ...
    async def remove_entity(self, entity_type: str, entity_id: str) -> None: ...
    async def add_relation(self, relation_type: str, source_id: str, target_id: str, properties: dict[str, Any]) -> None: ...
    async def remove_relation(self, relation_type: str, source_id: str, target_id: str) -> None: ...


async def sync_diff_to_knowledge_graph(
    kgb: KnowledgeGraphBuilder, diff: TopologyDiff,
) -> None:
    """将拓扑差分同步到知识图谱。"""
    try:
        for node in diff.nodes_added:
            await kgb.add_entity("topology_node", node.id, {
                "hostname": node.hostname, "device_type": node.device_type,
                "ip_addresses": node.ip_addresses, "mac_address": node.mac_address,
            })
        for node in diff.nodes_removed:
            await kgb.remove_entity("topology_node", node.id)
        for edge in diff.edges_added:
            await kgb.add_relation("topology_link", edge.source_id, edge.target_id, {
                "local_interface": edge.local_interface,
                "remote_interface": edge.remote_interface,
                "confidence": edge.confidence,
            })
        for edge in diff.edges_removed:
            await kgb.remove_relation("topology_link", edge.source_id, edge.target_id)
    except Exception as exc:
        logger.error("Failed to sync topology to knowledge graph", error=str(exc))
