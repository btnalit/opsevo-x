/**
 * 拓扑图序列化/反序列化
 *
 * Map↔Array 转换，用于 JSON 持久化
 * Property 14: TopologyGraph 持久化往返一致性
 * Requirements: 11.5
 */

import { TopologyGraph, SerializedTopologyGraph, createEmptyGraph } from './types';

/** 序列化：Map → Array（用于 JSON.stringify） */
export function serializeGraph(graph: TopologyGraph): SerializedTopologyGraph {
  return {
    nodes: Array.from(graph.nodes.values()),
    edges: Array.from(graph.edges.values()),
    version: graph.version,
    lastUpdatedAt: graph.lastUpdatedAt,
  };
}

/** 反序列化：Array → Map（用于 JSON.parse 后恢复） */
export function deserializeGraph(data: SerializedTopologyGraph): TopologyGraph {
  if (!data || !Array.isArray(data.nodes) || !Array.isArray(data.edges)) {
    return createEmptyGraph();
  }
  return {
    nodes: new Map(data.nodes.map(n => [n.id, n])),
    edges: new Map(data.edges.map(e => [e.id, e])),
    version: data.version || 0,
    lastUpdatedAt: data.lastUpdatedAt || Date.now(),
  };
}
