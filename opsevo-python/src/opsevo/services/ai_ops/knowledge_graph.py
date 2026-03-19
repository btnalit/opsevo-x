"""KnowledgeGraphBuilder — build and query knowledge graph from operational data.

Requirements: 9.6, 9.7
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from opsevo.utils.logger import get_logger

logger = get_logger(__name__)


@dataclass
class GraphNode:
    id: str
    type: str  # device, alert, metric, remediation
    label: str
    properties: dict[str, Any] = field(default_factory=dict)


@dataclass
class GraphEdge:
    source: str
    target: str
    relation: str
    weight: float = 1.0


class KnowledgeGraphBuilder:
    def __init__(self) -> None:
        self._nodes: dict[str, GraphNode] = {}
        self._edges: list[GraphEdge] = []

    def add_node(self, node_id: str, node_type: str, label: str, properties: dict[str, Any] | None = None) -> None:
        self._nodes[node_id] = GraphNode(id=node_id, type=node_type, label=label, properties=properties or {})

    def add_edge(self, source: str, target: str, relation: str, weight: float = 1.0) -> None:
        self._edges.append(GraphEdge(source=source, target=target, relation=relation, weight=weight))

    def get_neighbors(self, node_id: str) -> list[dict[str, Any]]:
        results: list[dict[str, Any]] = []
        for edge in self._edges:
            if edge.source == node_id:
                node = self._nodes.get(edge.target)
                if node:
                    results.append({"node": vars(node), "relation": edge.relation, "weight": edge.weight})
            elif edge.target == node_id:
                node = self._nodes.get(edge.source)
                if node:
                    results.append({"node": vars(node), "relation": edge.relation, "weight": edge.weight})
        return results

    def get_stats(self) -> dict[str, int]:
        return {"nodes": len(self._nodes), "edges": len(self._edges)}

    def to_dict(self) -> dict[str, Any]:
        return {
            "nodes": [vars(n) for n in self._nodes.values()],
            "edges": [vars(e) for e in self._edges],
        }
