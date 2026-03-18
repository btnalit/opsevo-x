/**
 * KnowledgeGraphBuilder - 知识图谱构建器
 *
 * 构建网络拓扑和配置的知识图谱，支持 PostgreSQL 持久化和内存双模式。
 *
 * Requirements: 8.4.1-8.4.5, H1.1-H1.5
 * - 8.4.1: 拓扑发现
 * - 8.4.2: 图谱更新
 * - 8.4.3: 依赖查询
 * - 8.4.4: 影响分析
 * - 8.4.5: 图谱存储
 * - H1.1: 节点/边持久化到 PostgreSQL
 * - H1.2: 节点类型 device/interface/service/alert/fault_pattern；边类型 connected_to/depends_on/triggers/related_to
 * - H1.3: 节点 TTL 自动清理
 * - H1.4: 图查询接口（按类型/最短路径/N跳邻居/属性过滤）
 * - H1.5: 告警关联分析和根因定位辅助
 */

import { logger } from '../../utils/logger';
import { EventEmitter } from 'events';
import * as fs from 'fs/promises';
import * as path from 'path';
import { topologyDiscoveryService } from './topology';
import { toKnowledgeGraphFormat } from './topology/kgbAdapter';
import type { DataStore } from '../dataStore';

/** 图节点类型 (H1.2) */
export type NodeType = 'device' | 'interface' | 'service' | 'alert' | 'fault_pattern';

/** 图边类型 (H1.2) */
export type EdgeType = 'connected_to' | 'depends_on' | 'triggers' | 'related_to';

/** 图节点 */
export interface GraphNode {
  id: string;
  type: NodeType;
  /** 节点名称（向后兼容，映射到 DB label 列） */
  name: string;
  /** 节点标签（映射到 DB label 列，与 name 同义） */
  label?: string;
  properties: Record<string, unknown>;
  /** TTL 秒数 (H1.3) */
  ttl?: number;
  createdAt: number;
  updatedAt?: number;
  /** 过期时间 (H1.3) */
  expiresAt?: Date;
}

/** 图边 */
export interface GraphEdge {
  id: string;
  sourceId: string;
  targetId: string;
  type: EdgeType;
  properties: Record<string, unknown>;
  weight: number;
  createdAt: number;
}

/** 拓扑图 */
export interface TopologyGraph {
  nodes: GraphNode[];
  edges: GraphEdge[];
  lastUpdated: number;
  version: number;
}

/** 图变更 */
export interface GraphChange {
  type: 'add_node' | 'update_node' | 'delete_node' | 'add_edge' | 'update_edge' | 'delete_edge';
  node?: Partial<GraphNode>;
  edge?: Partial<GraphEdge>;
  id?: string;
}

/** 依赖查询结果 */
export interface DependencyResult {
  componentId: string;
  upstream: GraphNode[];
  downstream: GraphNode[];
  depth: number;
}

/** 影响分析结果 */
export interface ImpactAnalysis {
  componentId: string;
  directImpact: GraphNode[];
  indirectImpact: GraphNode[];
  impactScore: number;
  riskLevel: 'low' | 'medium' | 'high' | 'critical';
}

/** 知识图谱配置 */
export interface KnowledgeGraphConfig {
  enabled: boolean;
  storagePath: string;
  maxNodes: number;
  maxEdges: number;
  discoveryInterval: number;
  maxDependencyDepth: number;
  nodeTTL: number;
}

const DEFAULT_CONFIG: KnowledgeGraphConfig = {
  enabled: true,
  storagePath: 'data/ai-ops/knowledge-graph',
  maxNodes: 10000,
  maxEdges: 50000,
  discoveryInterval: 3600000,
  maxDependencyDepth: 5,
  nodeTTL: 7 * 24 * 60 * 60 * 1000,
};

// ==================== DB Row 类型 ====================

interface DbNodeRow {
  id: string;
  type: string;
  label: string;
  properties: Record<string, unknown>;
  ttl_seconds: number | null;
  created_at: string;
  updated_at: string;
  expires_at: string | null;
}

interface DbEdgeRow {
  id: string;
  source_id: string;
  target_id: string;
  type: string;
  properties: Record<string, unknown>;
  weight: number;
  created_at: string;
  updated_at: string;
}

function dbRowToNode(row: DbNodeRow): GraphNode {
  return {
    id: row.id,
    type: row.type as NodeType,
    name: row.label,
    label: row.label,
    properties: row.properties,
    ttl: row.ttl_seconds ?? undefined,
    createdAt: new Date(row.created_at).getTime(),
    updatedAt: new Date(row.updated_at).getTime(),
    expiresAt: row.expires_at ? new Date(row.expires_at) : undefined,
  };
}

function dbRowToEdge(row: DbEdgeRow): GraphEdge {
  return {
    id: row.id,
    sourceId: row.source_id,
    targetId: row.target_id,
    type: row.type as EdgeType,
    properties: row.properties,
    weight: row.weight,
    createdAt: new Date(row.created_at).getTime(),
  };
}

/**
 * KnowledgeGraphBuilder 类
 * 双模式：dataStore 已设置时用 PostgreSQL 持久化 (H1.1)，否则回退到内存 Map
 */
export class KnowledgeGraphBuilder extends EventEmitter {
  private config: KnowledgeGraphConfig;
  private nodes: Map<string, GraphNode> = new Map();
  private edges: Map<string, GraphEdge> = new Map();
  private adjacencyList: Map<string, Set<string>> = new Map();
  private reverseAdjacencyList: Map<string, Set<string>> = new Map();
  private version = 0;
  private nodeIdCounter = 0;
  private edgeIdCounter = 0;
  private discoveryTimer: NodeJS.Timeout | null = null;
  private cleanupTimer: NodeJS.Timeout | null = null;
  private dataStore: DataStore | null = null;

  constructor(config?: Partial<KnowledgeGraphConfig>) {
    super();
    this.config = { ...DEFAULT_CONFIG, ...config };
    logger.debug('KnowledgeGraphBuilder created', { config: this.config });
  }

  // ==================== DataStore 注入 (H1.1) ====================

  /** 注入 PgDataStore，启用 PostgreSQL 持久化 */
  setDataStore(dataStore: DataStore): void {
    this.dataStore = dataStore;
    this.startCleanupTimer();
    logger.info('KnowledgeGraphBuilder: DataStore configured for PostgreSQL persistence');
  }

  private get hasPg(): boolean {
    return this.dataStore !== null;
  }

  // ==================== TTL 清理定时器 (H1.3) ====================

  private startCleanupTimer(): void {
    if (this.cleanupTimer) return;
    this.cleanupTimer = setInterval(async () => {
      try {
        const count = await this.cleanupExpiredNodes();
        if (count > 0) {
          logger.info(`KnowledgeGraphBuilder: TTL cleanup removed ${count} expired nodes`);
        }
      } catch (error) {
        logger.error('KnowledgeGraphBuilder: TTL cleanup failed', { error });
      }
    }, 3600000);
    this.cleanupTimer.unref();
  }

  private stopCleanupTimer(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
  }

  // ==================== CRUD 方法 (H1.1) ====================

  /** Upsert 节点到 PostgreSQL (H1.1) */
  async upsertNode(node: GraphNode): Promise<void> {
    if (this.hasPg) {
      const label = node.label || node.name;
      const expiresAt = node.ttl
        ? new Date(Date.now() + node.ttl * 1000)
        : node.expiresAt || null;
      await this.dataStore!.execute(
        `INSERT INTO knowledge_graph_nodes (id, type, label, properties, ttl_seconds, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (id) DO UPDATE SET
           type = EXCLUDED.type, label = EXCLUDED.label,
           properties = EXCLUDED.properties, ttl_seconds = EXCLUDED.ttl_seconds,
           expires_at = EXCLUDED.expires_at, updated_at = NOW()`,
        [node.id, node.type, label, JSON.stringify(node.properties), node.ttl ?? null, expiresAt]
      );
    }
    this.nodes.set(node.id, node);
    if (!this.adjacencyList.has(node.id)) this.adjacencyList.set(node.id, new Set());
    if (!this.reverseAdjacencyList.has(node.id)) this.reverseAdjacencyList.set(node.id, new Set());
    this.version++;
  }

  /** Upsert 边到 PostgreSQL (H1.1) */
  async upsertEdge(edge: GraphEdge): Promise<void> {
    if (this.hasPg) {
      await this.dataStore!.execute(
        `INSERT INTO knowledge_graph_edges (id, source_id, target_id, type, properties, weight)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (id) DO UPDATE SET
           source_id = EXCLUDED.source_id, target_id = EXCLUDED.target_id,
           type = EXCLUDED.type, properties = EXCLUDED.properties,
           weight = EXCLUDED.weight, updated_at = NOW()`,
        [edge.id, edge.sourceId, edge.targetId, edge.type, JSON.stringify(edge.properties), edge.weight]
      );
    }
    this.edges.set(edge.id, edge);
    this.adjacencyList.get(edge.sourceId)?.add(edge.id);
    this.reverseAdjacencyList.get(edge.targetId)?.add(edge.id);
    this.version++;
  }

  /** 删除节点 — 事务中先删关联边再删节点 (ON DELETE RESTRICT) */
  async removeNode(nodeId: string): Promise<void> {
    if (this.hasPg) {
      await this.dataStore!.transaction(async (tx) => {
        await tx.execute(
          'DELETE FROM knowledge_graph_edges WHERE source_id = $1 OR target_id = $1',
          [nodeId]
        );
        await tx.execute('DELETE FROM knowledge_graph_nodes WHERE id = $1', [nodeId]);
      });
    }
    const outgoing = this.adjacencyList.get(nodeId) || new Set();
    const incoming = this.reverseAdjacencyList.get(nodeId) || new Set();
    for (const edgeId of [...outgoing, ...incoming]) {
      this.deleteEdge(edgeId);
    }
    this.nodes.delete(nodeId);
    this.adjacencyList.delete(nodeId);
    this.reverseAdjacencyList.delete(nodeId);
    this.version++;
  }

  /** 删除边 (async PG 版本) */
  async removeEdge(edgeId: string): Promise<void> {
    if (this.hasPg) {
      await this.dataStore!.execute('DELETE FROM knowledge_graph_edges WHERE id = $1', [edgeId]);
    }
    this.deleteEdge(edgeId);
  }

  // ==================== 图查询接口 (H1.4) ====================

  /** 按类型查询节点 (H1.4) */
  async queryByType(nodeType: NodeType): Promise<GraphNode[]> {
    if (this.hasPg) {
      const rows = await this.dataStore!.query<DbNodeRow>(
        'SELECT * FROM knowledge_graph_nodes WHERE type = $1', [nodeType]
      );
      return rows.map(dbRowToNode);
    }
    return Array.from(this.nodes.values()).filter(n => n.type === nodeType);
  }

  /** 最短路径 — BFS (H1.4) */
  async shortestPath(fromId: string, toId: string): Promise<GraphNode[]> {
    if (fromId === toId) {
      const node = this.hasPg ? await this.getNodeFromDb(fromId) : this.nodes.get(fromId);
      return node ? [node] : [];
    }
    const edgeList = this.hasPg ? await this.getAllEdgesFromDb() : Array.from(this.edges.values());
    // 构建双向邻接表
    const adj = new Map<string, string[]>();
    for (const edge of edgeList) {
      if (!adj.has(edge.sourceId)) adj.set(edge.sourceId, []);
      if (!adj.has(edge.targetId)) adj.set(edge.targetId, []);
      adj.get(edge.sourceId)!.push(edge.targetId);
      adj.get(edge.targetId)!.push(edge.sourceId);
    }
    // BFS
    const visited = new Set<string>([fromId]);
    const parent = new Map<string, string>();
    const queue: string[] = [fromId];
    while (queue.length > 0) {
      const current = queue.shift()!;
      if (current === toId) break;
      for (const neighbor of (adj.get(current) || [])) {
        if (!visited.has(neighbor)) {
          visited.add(neighbor);
          parent.set(neighbor, current);
          queue.push(neighbor);
        }
      }
    }
    if (!visited.has(toId)) return [];
    // 回溯路径
    const pathIds: string[] = [];
    let cur: string | undefined = toId;
    while (cur !== undefined) {
      pathIds.unshift(cur);
      cur = parent.get(cur);
    }
    const result: GraphNode[] = [];
    for (const nid of pathIds) {
      const node = this.hasPg ? await this.getNodeFromDb(nid) : this.nodes.get(nid);
      if (node) result.push(node);
    }
    return result;
  }

  /** N 跳邻居 (H1.4) */
  async nHopNeighbors(nodeId: string, hops: number): Promise<{ nodes: GraphNode[]; edges: GraphEdge[] }> {
    if (hops <= 0) return { nodes: [], edges: [] };

    if (this.hasPg) {
      const edgeRows = await this.dataStore!.query<DbEdgeRow>(
        `WITH RECURSIVE hop AS (
           SELECT id, source_id, target_id, type, properties, weight, created_at, updated_at, 1 AS depth
           FROM knowledge_graph_edges
           WHERE source_id = $1 OR target_id = $1
         UNION
           SELECT e.id, e.source_id, e.target_id, e.type, e.properties, e.weight, e.created_at, e.updated_at, h.depth + 1
           FROM knowledge_graph_edges e
           INNER JOIN hop h ON (e.source_id = h.target_id OR e.source_id = h.source_id
                             OR e.target_id = h.target_id OR e.target_id = h.source_id)
             AND e.id != h.id
           WHERE h.depth < $2
        )
        SELECT DISTINCT id, source_id, target_id, type, properties, weight, created_at, updated_at FROM hop`,
        [nodeId, hops]
      );
      const edges = edgeRows.map(dbRowToEdge);
      const nodeIds = new Set<string>();
      for (const e of edges) { nodeIds.add(e.sourceId); nodeIds.add(e.targetId); }
      nodeIds.delete(nodeId);
      const nodes: GraphNode[] = [];
      for (const nid of nodeIds) {
        const node = await this.getNodeFromDb(nid);
        if (node) nodes.push(node);
      }
      return { nodes, edges };
    }

    // 内存模式：迭代 BFS
    const visitedNodes = new Set<string>([nodeId]);
    const visitedEdges = new Set<string>();
    let frontier = new Set<string>([nodeId]);
    for (let i = 0; i < hops; i++) {
      const nextFrontier = new Set<string>();
      for (const nid of frontier) {
        const outgoing = this.adjacencyList.get(nid) || new Set();
        const incoming = this.reverseAdjacencyList.get(nid) || new Set();
        for (const edgeId of [...outgoing, ...incoming]) {
          if (visitedEdges.has(edgeId)) continue;
          visitedEdges.add(edgeId);
          const edge = this.edges.get(edgeId);
          if (edge) {
            const other = edge.sourceId === nid ? edge.targetId : edge.sourceId;
            if (!visitedNodes.has(other)) { visitedNodes.add(other); nextFrontier.add(other); }
          }
        }
      }
      frontier = nextFrontier;
      if (frontier.size === 0) break;
    }
    visitedNodes.delete(nodeId);
    const nodes = Array.from(visitedNodes).map(nid => this.nodes.get(nid)).filter((n): n is GraphNode => !!n);
    const edges = Array.from(visitedEdges).map(eid => this.edges.get(eid)).filter((e): e is GraphEdge => !!e);
    return { nodes, edges };
  }

  /** 按属性过滤查询 — JSONB @> (H1.4) */
  async queryByProperties(filter: Record<string, unknown>): Promise<GraphNode[]> {
    if (this.hasPg) {
      const rows = await this.dataStore!.query<DbNodeRow>(
        'SELECT * FROM knowledge_graph_nodes WHERE properties @> $1', [JSON.stringify(filter)]
      );
      return rows.map(dbRowToNode);
    }
    return Array.from(this.nodes.values()).filter(node => {
      for (const [key, value] of Object.entries(filter)) {
        if (JSON.stringify(node.properties[key]) !== JSON.stringify(value)) return false;
      }
      return true;
    });
  }

  // ==================== 告警关联分析 (H1.5) ====================

  /** 查找关联告警 (H1.5) */
  async findRelatedAlerts(alertNodeId: string): Promise<GraphNode[]> {
    if (this.hasPg) {
      const rows = await this.dataStore!.query<DbNodeRow>(
        `SELECT DISTINCT n.* FROM knowledge_graph_nodes n
         INNER JOIN knowledge_graph_edges e ON (e.source_id = n.id OR e.target_id = n.id)
         WHERE n.type = 'alert' AND n.id != $1
           AND (e.source_id = $1 OR e.target_id = $1)`,
        [alertNodeId]
      );
      return rows.map(dbRowToNode);
    }
    const related: GraphNode[] = [];
    const outgoing = this.adjacencyList.get(alertNodeId) || new Set();
    const incoming = this.reverseAdjacencyList.get(alertNodeId) || new Set();
    const seen = new Set<string>();
    for (const edgeId of [...outgoing, ...incoming]) {
      const edge = this.edges.get(edgeId);
      if (edge) {
        const otherId = edge.sourceId === alertNodeId ? edge.targetId : edge.sourceId;
        if (!seen.has(otherId)) {
          seen.add(otherId);
          const node = this.nodes.get(otherId);
          if (node && node.type === 'alert') related.push(node);
        }
      }
    }
    return related;
  }

  /** 根因定位 — 沿 triggers 边反向追溯 (H1.5) */
  async findRootCause(alertNodeId: string): Promise<GraphNode | null> {
    if (this.hasPg) {
      const rows = await this.dataStore!.query<DbNodeRow>(
        `WITH RECURSIVE cause_chain AS (
           SELECT n.*, 0 AS depth FROM knowledge_graph_nodes n WHERE n.id = $1
         UNION
           SELECT n2.*, cc.depth + 1
           FROM cause_chain cc
           INNER JOIN knowledge_graph_edges e ON e.target_id = cc.id AND e.type = 'triggers'
           INNER JOIN knowledge_graph_nodes n2 ON n2.id = e.source_id
           WHERE cc.depth < 10
        )
        SELECT * FROM cause_chain WHERE id != $1 ORDER BY depth DESC LIMIT 1`,
        [alertNodeId]
      );
      return rows.length > 0 ? dbRowToNode(rows[0]) : null;
    }
    const visited = new Set<string>([alertNodeId]);
    let current = alertNodeId;
    let rootCause: GraphNode | null = null;
    for (let depth = 0; depth < 10; depth++) {
      const incoming = this.reverseAdjacencyList.get(current) || new Set();
      let found = false;
      for (const edgeId of incoming) {
        const edge = this.edges.get(edgeId);
        if (edge && edge.type === 'triggers' && !visited.has(edge.sourceId)) {
          visited.add(edge.sourceId);
          current = edge.sourceId;
          const node = this.nodes.get(current);
          if (node) rootCause = node;
          found = true;
          break;
        }
      }
      if (!found) break;
    }
    return rootCause;
  }

  // ==================== TTL 清理 (H1.3) ====================

  /** 清理过期节点 (H1.3) */
  async cleanupExpiredNodes(): Promise<number> {
    if (this.hasPg) {
      return await this.dataStore!.transaction(async (tx) => {
        const expiredRows = await tx.query<{ id: string }>(
          'SELECT id FROM knowledge_graph_nodes WHERE expires_at IS NOT NULL AND expires_at <= NOW()'
        );
        if (expiredRows.length === 0) return 0;
        const expiredIds = expiredRows.map(r => r.id);
        await tx.execute(
          'DELETE FROM knowledge_graph_edges WHERE source_id = ANY($1) OR target_id = ANY($1)',
          [expiredIds]
        );
        const result = await tx.execute(
          'DELETE FROM knowledge_graph_nodes WHERE id = ANY($1)', [expiredIds]
        );
        for (const id of expiredIds) this.deleteNode(id);
        return result.rowCount;
      });
    }
    return this.pruneExpiredNodes();
  }

  // ==================== DB 辅助方法 ====================

  private async getNodeFromDb(nodeId: string): Promise<GraphNode | null> {
    const row = await this.dataStore!.queryOne<DbNodeRow>(
      'SELECT * FROM knowledge_graph_nodes WHERE id = $1', [nodeId]
    );
    return row ? dbRowToNode(row) : null;
  }

  private async getAllEdgesFromDb(): Promise<GraphEdge[]> {
    const rows = await this.dataStore!.query<DbEdgeRow>('SELECT * FROM knowledge_graph_edges');
    return rows.map(dbRowToEdge);
  }

  // ==================== 原有公共 API（向后兼容） ====================

  /** 发现拓扑 Requirements: 8.4.1, 13.1-13.5 */
  discoverTopology(): TopologyGraph {
    logger.info('Starting topology discovery');
    this.pruneExpiredNodes();
    try {
      const realGraph = topologyDiscoveryService.getTopologyGraph();
      if (realGraph && realGraph.nodes.size > 0) {
        const kgbGraph = toKnowledgeGraphFormat(realGraph);
        this.syncFromTopologyGraph(kgbGraph);
        this.emit('topologyDiscovered', kgbGraph);
        return kgbGraph;
      }
    } catch (error) {
      logger.warn('Failed to get topology from TopologyDiscoveryService, falling back to internal data', { error });
    }
    const graph: TopologyGraph = {
      nodes: Array.from(this.nodes.values()),
      edges: Array.from(this.edges.values()),
      lastUpdated: Date.now(),
      version: this.version,
    };
    this.emit('topologyDiscovered', graph);
    return graph;
  }

  private syncFromTopologyGraph(graph: TopologyGraph): void {
    for (const node of graph.nodes) {
      if (!this.nodes.has(node.id)) {
        this.nodes.set(node.id, node);
        this.adjacencyList.set(node.id, new Set());
        this.reverseAdjacencyList.set(node.id, new Set());
      } else {
        const existing = this.nodes.get(node.id)!;
        this.nodes.set(node.id, { ...existing, ...node, updatedAt: Date.now() });
      }
    }
    for (const edge of graph.edges) {
      if (!this.edges.has(edge.id)) {
        this.edges.set(edge.id, edge);
        this.adjacencyList.get(edge.sourceId)?.add(edge.id);
        this.reverseAdjacencyList.get(edge.targetId)?.add(edge.id);
      }
    }
    this.version++;
  }

  /** 清理过期节点 (内存模式 TTL) */
  public pruneExpiredNodes(): number {
    const now = Date.now();
    let prunedCount = 0;
    for (const [nodeId, node] of this.nodes.entries()) {
      const updatedAt = node.updatedAt ?? node.createdAt;
      const expired = node.expiresAt
        ? now >= node.expiresAt.getTime()
        : (now - updatedAt > this.config.nodeTTL);
      if (expired) { this.deleteNode(nodeId); prunedCount++; }
    }
    if (prunedCount > 0) {
      logger.info(`Pruned ${prunedCount} expired graph nodes (TTL: ${this.config.nodeTTL}ms)`);
    }
    return prunedCount;
  }

  /** 添加节点 */
  addNode(node: Omit<GraphNode, 'id' | 'createdAt' | 'updatedAt'>): GraphNode {
    if (this.nodes.size >= this.config.maxNodes) throw new Error('Maximum node limit reached');
    const now = Date.now();
    const fullNode: GraphNode = {
      ...node, id: `node_${++this.nodeIdCounter}_${now}`, createdAt: now, updatedAt: now,
    };
    this.nodes.set(fullNode.id, fullNode);
    this.adjacencyList.set(fullNode.id, new Set());
    this.reverseAdjacencyList.set(fullNode.id, new Set());
    this.version++;
    if (this.hasPg) {
      this.upsertNode(fullNode).catch(err => logger.warn('KGB: Failed to persist node to PG', { err }));
    }
    logger.debug('Node added', { nodeId: fullNode.id, type: fullNode.type });
    this.emit('nodeAdded', fullNode);
    return fullNode;
  }

  /** 更新节点 */
  updateNode(nodeId: string, updates: Partial<Omit<GraphNode, 'id' | 'createdAt'>>): GraphNode | null {
    const node = this.nodes.get(nodeId);
    if (!node) return null;
    const updatedNode: GraphNode = { ...node, ...updates, id: node.id, createdAt: node.createdAt, updatedAt: Date.now() };
    this.nodes.set(nodeId, updatedNode);
    this.version++;
    if (this.hasPg) {
      this.upsertNode(updatedNode).catch(err => logger.warn('KGB: Failed to persist node update to PG', { err }));
    }
    logger.debug('Node updated', { nodeId });
    this.emit('nodeUpdated', updatedNode);
    return updatedNode;
  }

  /** 删除节点（同步内存版本，向后兼容） */
  deleteNode(nodeId: string): boolean {
    if (!this.nodes.has(nodeId)) return false;
    const outgoingEdges = this.adjacencyList.get(nodeId) || new Set();
    const incomingEdges = this.reverseAdjacencyList.get(nodeId) || new Set();
    for (const edgeId of [...outgoingEdges, ...incomingEdges]) this.deleteEdge(edgeId);
    this.nodes.delete(nodeId);
    this.adjacencyList.delete(nodeId);
    this.reverseAdjacencyList.delete(nodeId);
    this.version++;
    logger.debug('Node deleted', { nodeId });
    this.emit('nodeDeleted', { nodeId });
    return true;
  }

  /** 添加边 */
  addEdge(edge: Omit<GraphEdge, 'id' | 'createdAt'>): GraphEdge {
    if (this.edges.size >= this.config.maxEdges) throw new Error('Maximum edge limit reached');
    if (!this.nodes.has(edge.sourceId) || !this.nodes.has(edge.targetId)) {
      throw new Error('Source or target node does not exist');
    }
    const now = Date.now();
    const fullEdge: GraphEdge = { ...edge, id: `edge_${++this.edgeIdCounter}_${now}`, createdAt: now };
    this.edges.set(fullEdge.id, fullEdge);
    this.adjacencyList.get(edge.sourceId)?.add(fullEdge.id);
    this.reverseAdjacencyList.get(edge.targetId)?.add(fullEdge.id);
    this.version++;
    if (this.hasPg) {
      this.upsertEdge(fullEdge).catch(err => logger.warn('KGB: Failed to persist edge to PG', { err }));
    }
    logger.debug('Edge added', { edgeId: fullEdge.id, type: fullEdge.type });
    this.emit('edgeAdded', fullEdge);
    return fullEdge;
  }

  /** 删除边（同步内存版本，向后兼容） */
  deleteEdge(edgeId: string): boolean {
    const edge = this.edges.get(edgeId);
    if (!edge) return false;
    this.adjacencyList.get(edge.sourceId)?.delete(edgeId);
    this.reverseAdjacencyList.get(edge.targetId)?.delete(edgeId);
    this.edges.delete(edgeId);
    this.version++;
    logger.debug('Edge deleted', { edgeId });
    this.emit('edgeDeleted', { edgeId });
    return true;
  }

  /** 更新图谱 Requirements: 8.4.2 */
  async updateGraph(changes: GraphChange[]): Promise<void> {
    await Promise.resolve();
    for (const change of changes) {
      switch (change.type) {
        case 'add_node':
          if (change.node) this.addNode(change.node as Omit<GraphNode, 'id' | 'createdAt' | 'updatedAt'>);
          break;
        case 'update_node':
          if (change.id && change.node) this.updateNode(change.id, change.node);
          break;
        case 'delete_node':
          if (change.id) this.deleteNode(change.id);
          break;
        case 'add_edge':
          if (change.edge) this.addEdge(change.edge as Omit<GraphEdge, 'id' | 'createdAt'>);
          break;
        case 'delete_edge':
          if (change.id) this.deleteEdge(change.id);
          break;
      }
    }
    this.emit('graphUpdated', { changeCount: changes.length, version: this.version });
  }

  /** 查询依赖 Requirements: 8.4.3 */
  queryDependencies(componentId: string, direction: 'upstream' | 'downstream' | 'both' = 'both'): DependencyResult {
    const upstream: GraphNode[] = [];
    const downstream: GraphNode[] = [];
    if (direction === 'upstream' || direction === 'both') this.traverseUpstream(componentId, upstream, new Set(), 0);
    if (direction === 'downstream' || direction === 'both') this.traverseDownstream(componentId, downstream, new Set(), 0);
    return {
      componentId, upstream, downstream,
      depth: Math.max(this.calculateDepth(componentId, 'upstream'), this.calculateDepth(componentId, 'downstream')),
    };
  }

  /** 分析影响范围 Requirements: 8.4.4 */
  analyzeImpact(componentId: string): ImpactAnalysis {
    const directImpact: GraphNode[] = [];
    const indirectImpact: GraphNode[] = [];
    const visited = new Set<string>();
    const outgoingEdges = this.adjacencyList.get(componentId) || new Set();
    for (const edgeId of outgoingEdges) {
      const edge = this.edges.get(edgeId);
      if (edge) {
        const targetNode = this.nodes.get(edge.targetId);
        if (targetNode && !visited.has(targetNode.id)) { directImpact.push(targetNode); visited.add(targetNode.id); }
      }
    }
    for (const node of directImpact) this.traverseDownstream(node.id, indirectImpact, visited, 0);
    const totalNodes = this.nodes.size;
    const impactedNodes = directImpact.length + indirectImpact.length;
    const impactScore = totalNodes > 0 ? impactedNodes / totalNodes : 0;
    let riskLevel: ImpactAnalysis['riskLevel'];
    if (impactScore > 0.5) riskLevel = 'critical';
    else if (impactScore > 0.3) riskLevel = 'high';
    else if (impactScore > 0.1) riskLevel = 'medium';
    else riskLevel = 'low';
    return { componentId, directImpact, indirectImpact, impactScore: Math.round(impactScore * 100) / 100, riskLevel };
  }

  getNode(nodeId: string): GraphNode | undefined { return this.nodes.get(nodeId); }
  getAllNodes(): GraphNode[] { return Array.from(this.nodes.values()); }
  getNodesByType(type: NodeType): GraphNode[] { return Array.from(this.nodes.values()).filter(n => n.type === type); }
  getEdge(edgeId: string): GraphEdge | undefined { return this.edges.get(edgeId); }
  getAllEdges(): GraphEdge[] { return Array.from(this.edges.values()); }

  getStats(): { nodeCount: number; edgeCount: number; version: number; nodesByType: Record<NodeType, number> } {
    const nodesByType: Record<string, number> = {};
    for (const node of this.nodes.values()) nodesByType[node.type] = (nodesByType[node.type] || 0) + 1;
    return { nodeCount: this.nodes.size, edgeCount: this.edges.size, version: this.version, nodesByType: nodesByType as Record<NodeType, number> };
  }

  /** 保存图谱 Requirements: 8.4.5 — PG 模式下为 no-op */
  async saveGraph(): Promise<void> {
    if (this.hasPg) { logger.debug('saveGraph: skipped (PostgreSQL persistence active)'); return; }
    try {
      await fs.mkdir(this.config.storagePath, { recursive: true });
      const data = { nodes: Array.from(this.nodes.values()), edges: Array.from(this.edges.values()), version: this.version, savedAt: Date.now() };
      const filepath = path.join(this.config.storagePath, 'graph.json');
      await fs.writeFile(filepath, JSON.stringify(data, null, 2));
      logger.debug('Graph saved', { filepath, nodeCount: data.nodes.length, edgeCount: data.edges.length });
    } catch (error) { logger.error('Failed to save graph', { error }); }
  }

  /** 加载图谱 — PG 模式下从 PostgreSQL 加载 */
  async loadGraph(): Promise<void> {
    if (this.hasPg) {
      try {
        const nodeRows = await this.dataStore!.query<DbNodeRow>('SELECT * FROM knowledge_graph_nodes');
        const edgeRows = await this.dataStore!.query<DbEdgeRow>('SELECT * FROM knowledge_graph_edges');
        this.nodes.clear(); this.edges.clear(); this.adjacencyList.clear(); this.reverseAdjacencyList.clear();
        for (const row of nodeRows) {
          const node = dbRowToNode(row);
          this.nodes.set(node.id, node);
          this.adjacencyList.set(node.id, new Set());
          this.reverseAdjacencyList.set(node.id, new Set());
        }
        for (const row of edgeRows) {
          const edge = dbRowToEdge(row);
          this.edges.set(edge.id, edge);
          this.adjacencyList.get(edge.sourceId)?.add(edge.id);
          this.reverseAdjacencyList.get(edge.targetId)?.add(edge.id);
        }
        logger.info('Graph loaded from PostgreSQL', { nodeCount: this.nodes.size, edgeCount: this.edges.size });
      } catch (error) { logger.error('Failed to load graph from PostgreSQL', { error }); }
      return;
    }
    try {
      const filepath = path.join(this.config.storagePath, 'graph.json');
      const content = await fs.readFile(filepath, 'utf-8');
      const data = JSON.parse(content) as { nodes?: GraphNode[]; edges?: GraphEdge[]; version?: number };
      this.nodes.clear(); this.edges.clear(); this.adjacencyList.clear(); this.reverseAdjacencyList.clear();
      for (const node of data.nodes || []) {
        this.nodes.set(node.id, node);
        this.adjacencyList.set(node.id, new Set());
        this.reverseAdjacencyList.set(node.id, new Set());
      }
      for (const edge of data.edges || []) {
        this.edges.set(edge.id, edge);
        this.adjacencyList.get(edge.sourceId)?.add(edge.id);
        this.reverseAdjacencyList.get(edge.targetId)?.add(edge.id);
      }
      this.version = data.version || 0;
      logger.info('Graph loaded', { nodeCount: this.nodes.size, edgeCount: this.edges.size });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') logger.error('Failed to load graph', { error });
    }
  }

  startAutoDiscovery(): void {
    if (this.discoveryTimer) return;
    this.discoveryTimer = setInterval(async () => {
      try { await this.discoverTopology(); } catch (error) { logger.error('Auto discovery failed', { error }); }
    }, this.config.discoveryInterval);
    logger.info('Auto discovery started', { interval: this.config.discoveryInterval });
  }

  stopAutoDiscovery(): void {
    if (this.discoveryTimer) { clearInterval(this.discoveryTimer); this.discoveryTimer = null; logger.info('Auto discovery stopped'); }
  }

  updateConfig(config: Partial<KnowledgeGraphConfig>): void {
    this.config = { ...this.config, ...config };
    logger.debug('KnowledgeGraphBuilder config updated', { config: this.config });
  }

  async shutdown(): Promise<void> {
    this.stopAutoDiscovery();
    this.stopCleanupTimer();
    await this.saveGraph();
    this.removeAllListeners();
    logger.info('KnowledgeGraphBuilder shutdown');
  }

  // ==================== 私有遍历方法 ====================

  private traverseUpstream(nodeId: string, result: GraphNode[], visited: Set<string>, depth: number): void {
    if (depth >= this.config.maxDependencyDepth || visited.has(nodeId)) return;
    visited.add(nodeId);
    const incomingEdges = this.reverseAdjacencyList.get(nodeId) || new Set();
    for (const edgeId of incomingEdges) {
      const edge = this.edges.get(edgeId);
      if (edge) {
        const sourceNode = this.nodes.get(edge.sourceId);
        if (sourceNode && !visited.has(sourceNode.id)) { result.push(sourceNode); this.traverseUpstream(sourceNode.id, result, visited, depth + 1); }
      }
    }
  }

  private traverseDownstream(nodeId: string, result: GraphNode[], visited: Set<string>, depth: number): void {
    if (depth >= this.config.maxDependencyDepth || visited.has(nodeId)) return;
    visited.add(nodeId);
    const outgoingEdges = this.adjacencyList.get(nodeId) || new Set();
    for (const edgeId of outgoingEdges) {
      const edge = this.edges.get(edgeId);
      if (edge) {
        const targetNode = this.nodes.get(edge.targetId);
        if (targetNode && !visited.has(targetNode.id)) { result.push(targetNode); this.traverseDownstream(targetNode.id, result, visited, depth + 1); }
      }
    }
  }

  private calculateDepth(nodeId: string, direction: 'upstream' | 'downstream'): number {
    return this.calculateDepthRecursive(nodeId, direction, new Set(), 0);
  }

  private calculateDepthRecursive(nodeId: string, direction: 'upstream' | 'downstream', visited: Set<string>, currentDepth: number): number {
    if (visited.has(nodeId) || currentDepth >= this.config.maxDependencyDepth) return currentDepth;
    visited.add(nodeId);
    const edges = direction === 'upstream' ? this.reverseAdjacencyList.get(nodeId) : this.adjacencyList.get(nodeId);
    if (!edges || edges.size === 0) return currentDepth;
    let maxDepth = currentDepth;
    for (const edgeId of edges) {
      const edge = this.edges.get(edgeId);
      if (edge) {
        const nextNodeId = direction === 'upstream' ? edge.sourceId : edge.targetId;
        maxDepth = Math.max(maxDepth, this.calculateDepthRecursive(nextNodeId, direction, visited, currentDepth + 1));
      }
    }
    return maxDepth;
  }
}

// 导出单例实例
export const knowledgeGraphBuilder = new KnowledgeGraphBuilder();
