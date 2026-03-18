/**
 * KnowledgeGraphBuilder 适配器
 *
 * 将 TopologyDiscoveryService 的 TopologyGraph（Map-based）
 * 转换为 KnowledgeGraphBuilder 的 TopologyGraph（Array-based, GraphNode/GraphEdge）
 *
 * Property 20: KnowledgeGraph 同步数据完整性
 * Requirements: 13.1-13.5
 */

import { TopologyGraph } from './types';
import {
  TopologyGraph as KGBTopologyGraph,
  GraphNode, GraphEdge, NodeType, EdgeType,
} from '../knowledgeGraphBuilder';

/**
 * 将拓扑发现服务的图转换为知识图谱格式
 */
export function toKnowledgeGraphFormat(graph: TopologyGraph): KGBTopologyGraph {
  const now = Date.now();

  const nodes: GraphNode[] = Array.from(graph.nodes.values())
    .filter(n => n.state === 'confirmed')
    .map(n => ({
      id: n.id,
      type: 'device' as NodeType,
      name: n.hostname || n.id,
      properties: {
        deviceId: n.deviceId,
        ipAddresses: n.ipAddresses,
        deviceType: n.deviceType,
        macAddress: n.macAddress,
        stabilityTier: n.stabilityTier,
      },
      createdAt: n.discoveredAt,
      updatedAt: n.lastSeenAt,
    }));

  const edges: GraphEdge[] = Array.from(graph.edges.values())
    .filter(e => e.state === 'confirmed')
    .map(e => ({
      id: e.id,
      sourceId: e.sourceId,
      targetId: e.targetId,
      type: 'connected_to' as EdgeType,
      properties: {
        localInterface: e.localInterface,
        remoteInterface: e.remoteInterface,
        confidence: e.confidence,
        sources: e.sources,
      },
      weight: e.confidence,
      createdAt: e.discoveredAt,
    }));

  return {
    nodes,
    edges,
    lastUpdated: graph.lastUpdatedAt,
    version: graph.version,
  };
}
