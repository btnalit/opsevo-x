/**
 * 差分计算引擎
 *
 * Property 9: 增量差分幂等性
 * Requirements: 4.1-4.5
 */

import { TopologyGraph, TopologyDiff, TopologyNode, TopologyEdge } from './types';

/**
 * 比较两个 TopologyGraph，生成 TopologyDiff
 */
export function computeDiff(oldGraph: TopologyGraph, newGraph: TopologyGraph): TopologyDiff {
  const now = Date.now();
  const nodesAdded: TopologyNode[] = [];
  const nodesRemoved: TopologyNode[] = [];
  const edgesAdded: TopologyEdge[] = [];
  const edgesRemoved: TopologyEdge[] = [];
  const edgesUpdated: { edgeId: string; changes: Record<string, { old: unknown; new: unknown }> }[] = [];
  const nodesUpdated: { nodeId: string; changes: Record<string, { old: unknown; new: unknown }> }[] = [];

  // 新增节点：在 newGraph 中但不在 oldGraph 中
  for (const [id, node] of newGraph.nodes) {
    if (!oldGraph.nodes.has(id)) {
      nodesAdded.push(node);
    }
  }

  // 移除节点：在 oldGraph 中但不在 newGraph 中
  for (const [id, node] of oldGraph.nodes) {
    if (!newGraph.nodes.has(id)) {
      nodesRemoved.push(node);
    }
  }

  // 新增边：在 newGraph 中但不在 oldGraph 中
  for (const [id, edge] of newGraph.edges) {
    if (!oldGraph.edges.has(id)) {
      edgesAdded.push(edge);
    }
  }

  // 移除边：在 oldGraph 中但不在 newGraph 中
  for (const [id, edge] of oldGraph.edges) {
    if (!newGraph.edges.has(id)) {
      edgesRemoved.push(edge);
    }
  }

  // 属性变更节点：两个图中都存在但属性不同
  for (const [id, newNode] of newGraph.nodes) {
    const oldNode = oldGraph.nodes.get(id);
    if (!oldNode) continue;

    const changes: Record<string, { old: unknown; new: unknown }> = {};
    if (oldNode.state !== newNode.state) {
      changes.state = { old: oldNode.state, new: newNode.state };
    }
    if (oldNode.hostname !== newNode.hostname) {
      changes.hostname = { old: oldNode.hostname, new: newNode.hostname };
    }
    if (JSON.stringify(oldNode.ipAddresses?.sort() || []) !== JSON.stringify(newNode.ipAddresses?.sort() || [])) {
      changes.ipAddresses = { old: oldNode.ipAddresses, new: newNode.ipAddresses };
    }
    if (oldNode.stabilityTier !== newNode.stabilityTier) {
      changes.stabilityTier = { old: oldNode.stabilityTier, new: newNode.stabilityTier };
    }

    if (Object.keys(changes).length > 0) {
      nodesUpdated.push({ nodeId: id, changes });
    }
  }

  // 属性变更边：两个图中都存在但属性不同
  for (const [id, newEdge] of newGraph.edges) {
    const oldEdge = oldGraph.edges.get(id);
    if (!oldEdge) continue;

    const changes: Record<string, { old: unknown; new: unknown }> = {};
    if (oldEdge.confidence !== newEdge.confidence) {
      changes.confidence = { old: oldEdge.confidence, new: newEdge.confidence };
    }
    if (oldEdge.localInterfaceRunning !== newEdge.localInterfaceRunning) {
      changes.localInterfaceRunning = { old: oldEdge.localInterfaceRunning, new: newEdge.localInterfaceRunning };
    }
    if (oldEdge.remoteInterfaceRunning !== newEdge.remoteInterfaceRunning) {
      changes.remoteInterfaceRunning = { old: oldEdge.remoteInterfaceRunning, new: newEdge.remoteInterfaceRunning };
    }
    if (oldEdge.state !== newEdge.state) {
      changes.state = { old: oldEdge.state, new: newEdge.state };
    }
    if (JSON.stringify(oldEdge.sources.sort()) !== JSON.stringify(newEdge.sources.sort())) {
      changes.sources = { old: oldEdge.sources, new: newEdge.sources };
    }

    if (Object.keys(changes).length > 0) {
      edgesUpdated.push({ edgeId: id, changes });
    }
  }

  return {
    id: `diff-${now}`,
    timestamp: now,
    nodesAdded, nodesRemoved, nodesUpdated,
    edgesAdded, edgesRemoved, edgesUpdated,
  };
}

/**
 * 将 TopologyDiff 增量应用到 TopologyGraph
 */
export function applyDiff(graph: TopologyGraph, diff: TopologyDiff): TopologyGraph {
  // 深拷贝 Map
  const nodes = new Map(graph.nodes);
  const edges = new Map(graph.edges);

  // 添加新节点
  for (const node of diff.nodesAdded) {
    nodes.set(node.id, node);
  }

  // 移除节点
  for (const node of diff.nodesRemoved) {
    nodes.delete(node.id);
  }

  // 应用节点属性变更
  for (const update of diff.nodesUpdated || []) {
    const node = nodes.get(update.nodeId);
    if (!node) continue;
    const updated = { ...node };
    for (const [key, change] of Object.entries(update.changes)) {
      (updated as Record<string, unknown>)[key] = change.new;
    }
    nodes.set(update.nodeId, updated);
  }

  // 添加新边
  for (const edge of diff.edgesAdded) {
    edges.set(edge.id, edge);
  }

  // 移除边
  for (const edge of diff.edgesRemoved) {
    edges.delete(edge.id);
  }

  // 应用边属性变更
  for (const update of diff.edgesUpdated) {
    const edge = edges.get(update.edgeId);
    if (!edge) continue;
    const updated = { ...edge };
    for (const [key, change] of Object.entries(update.changes)) {
      (updated as Record<string, unknown>)[key] = change.new;
    }
    edges.set(update.edgeId, updated);
  }

  return {
    nodes, edges,
    version: graph.version + 1,
    lastUpdatedAt: diff.timestamp,
  };
}

/** 检查 diff 是否为空 */
export function isDiffEmpty(diff: TopologyDiff): boolean {
  return diff.nodesAdded.length === 0
    && diff.nodesRemoved.length === 0
    && (diff.nodesUpdated?.length || 0) === 0
    && diff.edgesAdded.length === 0
    && diff.edgesRemoved.length === 0
    && diff.edgesUpdated.length === 0;
}
