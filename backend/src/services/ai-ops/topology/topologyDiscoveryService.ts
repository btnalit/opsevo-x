/**
 * TopologyDiscoveryService - 拓扑发现核心服务
 *
 * 实现 IManagedService 接口，单例模式
 * 分层轮询调度、完整发现流程、配置管理、持久化
 *
 * Requirements: 1-15 (全部需求)
 */

import { EventEmitter } from 'events';
import * as fs from 'fs/promises';
import * as path from 'path';
import { logger } from '../../../utils/logger';
import { IManagedService, HealthCheckResult } from '../serviceLifecycle';
import { RouterOSClient } from '../../routerosClient';
import type { DeviceManager } from '../../device/deviceManager';
import type { KnowledgeGraphBuilder } from '../knowledgeGraphBuilder';
import type { EventBus } from '../../eventBus';
import {
  TopologyGraph, TopologyDiff, TopologyChangeEvent, TopologyStats,
  TopologyDiscoveryConfig,
  DEFAULT_TOPOLOGY_CONFIG, createEmptyGraph, createEmptyStats,
  DiscoverySource, SerializedTopologyGraph, ManagedTopologyDevice,
} from './types';
import { collectAllDevicesData, collectDeviceData } from './dataCollector';
import { buildCandidateGraph } from './candidateGraphBuilder';
import { computeDiff, isDiffEmpty } from './diffEngine';
import { onEntitySeen, onEntityMissed } from './stateMachine';
import { SlidingWindow, DampeningTimer } from './dampeningEngine';
import { serializeGraph, deserializeGraph } from './graphSerializer';
import { calculateEdgeConfidence } from './edgeUtils';

// ==================== 路径常量 ====================

const DATA_DIR = path.join(process.cwd(), 'backend', 'data', 'ai-ops');
const CONFIG_FILE = path.join(DATA_DIR, 'topology-discovery-config.json');
const GRAPH_FILE = path.join(DATA_DIR, 'topology-graph.json');
const DIFF_HISTORY_FILE = path.join(DATA_DIR, 'topology-diff-history.json');

// ==================== 服务类 ====================

class TopologyDiscoveryService implements IManagedService {
  public readonly events = new EventEmitter();

  private config: TopologyDiscoveryConfig = { ...DEFAULT_TOPOLOGY_CONFIG };
  private graph: TopologyGraph = createEmptyGraph();
  private stats: TopologyStats = createEmptyStats();
  private diffHistory: TopologyDiff[] = [];
  private slidingWindow: SlidingWindow;
  private dampeningTimer: DampeningTimer;

  // 轮询定时器
  private fastPollTimer: NodeJS.Timeout | null = null;
  private mediumPollTimer: NodeJS.Timeout | null = null;
  private slowPollTimer: NodeJS.Timeout | null = null;

  // 依赖注入
  private getDevices: (() => Promise<ManagedTopologyDevice[]>) | null = null;
  private getConnection: ((tenantId: string, deviceId: string) => Promise<RouterOSClient>) | null = null;
  private onTopologyChange: ((event: TopologyChangeEvent) => void) | null = null;
  private deviceManager: DeviceManager | null = null;
  private eventBus: EventBus | null = null;
  private knowledgeGraph: KnowledgeGraphBuilder | null = null;

  private initialized = false;
  private running = false;
  private startedAt = 0;

  constructor() {
    this.slidingWindow = new SlidingWindow(this.config.slidingWindowSize);
    this.dampeningTimer = new DampeningTimer(this.config.dampeningTimerMs, (diff) => {
      this.publishDiff(diff);
    });
  }

  // ==================== 依赖注入 ====================

  setDeviceProvider(fn: () => Promise<ManagedTopologyDevice[]>): void {
    this.getDevices = fn;
  }

  setConnectionProvider(fn: (tenantId: string, deviceId: string) => Promise<RouterOSClient>): void {
    this.getConnection = fn;
  }

  setTopologyChangeHandler(fn: (event: TopologyChangeEvent) => void): void {
    this.onTopologyChange = fn;
  }

  /** H2.6: Wire DeviceManager for standardized data collection */
  setDeviceManager(dm: DeviceManager): void {
    this.deviceManager = dm;
  }

  /** H2.9: Wire EventBus for publishing topology_changed events */
  setEventBus(eb: EventBus): void {
    this.eventBus = eb;
  }

  /** H2.10: Wire KnowledgeGraphBuilder for topology sync */
  setKnowledgeGraphBuilder(kg: KnowledgeGraphBuilder): void {
    this.knowledgeGraph = kg;
  }

  // ==================== IManagedService 接口 ====================

  getName(): string { return 'topology-discovery'; }

  async initialize(): Promise<void> {
    if (this.initialized) return;
    await this.loadConfig();
    await this.loadGraph();
    await this.loadDiffHistory();
    this.initialized = true;
    logger.info('[topology] TopologyDiscoveryService initialized');
  }

  async start(): Promise<void> {
    if (!this.initialized) await this.initialize();
    if (this.running || !this.config.enabled) return;

    this.running = true;
    this.startedAt = Date.now();

    // FIX: 立即执行一次完整发现，避免首次加载时拓扑为空
    // 使用 slow tier 以采集所有数据源（ip-neighbor, arp, routing-table, interface-status）
    this.executeDiscovery('slow').catch(err => {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn(`[topology] Initial discovery failed: ${msg}`);
    });

    this.startPollingTimers();
    logger.info('[topology] TopologyDiscoveryService started');
  }


  async stop(): Promise<void> {
    this.running = false;
    this.stopPollingTimers();
    this.dampeningTimer.flush();
    this.dampeningTimer.stop();

    await this.saveGraph();
    await this.saveDiffHistory();
    logger.info('[topology] TopologyDiscoveryService stopped');
  }

  healthCheck(): Promise<HealthCheckResult> {
    const now = Date.now();
    const unhealthyThreshold = 3 * this.config.slowPollIntervalMs;
    const baseline = this.stats.lastDiscoveryAt ?? this.startedAt;
    const healthy = this.running && (now - baseline) < unhealthyThreshold;

    return Promise.resolve({
      healthy,
      message: healthy
        ? `Running. Nodes: ${this.stats.currentNodeCount}, Edges: ${this.stats.currentEdgeCount}`
        : `Unhealthy: no successful discovery in ${unhealthyThreshold}ms`,
      lastCheck: now,
      consecutiveFailures: healthy ? 0 : this.stats.failedRounds,
    });
  }

  // ==================== 配置管理 ====================

  getConfig(): TopologyDiscoveryConfig { return { ...this.config }; }

  async updateConfig(updates: Partial<TopologyDiscoveryConfig>): Promise<void> {
    const oldWindowSize = this.config.slidingWindowSize;
    const oldDampeningMs = this.config.dampeningTimerMs;
    this.config = { ...this.config, ...updates };
    // FIX: 只在 slidingWindowSize 实际变化时才重建 SlidingWindow
    if (this.config.slidingWindowSize !== oldWindowSize) {
      this.slidingWindow = new SlidingWindow(this.config.slidingWindowSize);
    }
    // FIX: dampeningTimerMs 变化时重建 DampeningTimer
    if (this.config.dampeningTimerMs !== oldDampeningMs) {
      this.dampeningTimer.flush();
      this.dampeningTimer.stop();
      this.dampeningTimer = new DampeningTimer(this.config.dampeningTimerMs, (diff) => {
        this.publishDiff(diff);
      });
    }
    await this.saveConfig();

    if (this.running) {
      this.stopPollingTimers();
      this.startPollingTimers();
    }
  }

  // ==================== 拓扑查询 ====================

  getTopologyGraph(): TopologyGraph { return this.graph; }

  getDiffHistory(limit = 20): TopologyDiff[] {
    return this.diffHistory.slice(-limit);
  }

  getStats(): TopologyStats {
    return {
      ...this.stats,
      currentNodeCount: this.graph.nodes.size,
      currentEdgeCount: this.graph.edges.size,
    };
  }

  resetStats(): void { this.stats = createEmptyStats(); }

  // ==================== 手动触发 ====================

  async triggerFullDiscovery(): Promise<void> {
    await this.executeDiscovery('slow');
  }

  async triggerDeviceUpdate(deviceId: string): Promise<void> {
    if (!this.getDevices || !this.getConnection) {
      logger.debug('[topology] No device/connection provider, skipping single-device update');
      return;
    }

    logger.info(`[topology] triggerDeviceUpdate: single-device update for ${deviceId}`);

    try {
      const devices = await this.getDevices();
      const device = devices.find(d => d.id === deviceId);
      if (!device) {
        logger.warn(`[topology] triggerDeviceUpdate: device ${deviceId} not found in device list`);
        return;
      }

      const client = await this.getConnection(device.tenantId, device.id);
      const sources = this.getSourcesForTier('medium');
      const rawData = await collectDeviceData(
        client,
        device.id,
        device.tenantId,
        sources,
        this.config.endpointDiscoveryEnabled,
        { name: device.name, host: device.host },
      );

      // 用单设备数据构建候选图
      const candidateGraph = buildCandidateGraph([rawData], this.graph, this.config);

      const oldGraph: TopologyGraph = {
        nodes: new Map(this.graph.nodes),
        edges: new Map(this.graph.edges),
        version: this.graph.version,
        lastUpdatedAt: this.graph.lastUpdatedAt,
      };

      // 状态机推进
      this.advanceStateMachine(candidateGraph, []);

      // 合并新节点/边
      // FIX: 新发现的节点/边 confirmCount 应为 1
      for (const [id, node] of candidateGraph.nodes) {
        if (!this.graph.nodes.has(id)) this.graph.nodes.set(id, { ...node, confirmCount: 1 });
      }
      for (const [id, edge] of candidateGraph.edges) {
        if (!this.graph.edges.has(id)) this.graph.edges.set(id, { ...edge, confirmCount: 1 });
      }

      this.graph.version++;
      this.graph.lastUpdatedAt = Date.now();

      const diff = computeDiff(oldGraph, this.graph);
      if (!isDiffEmpty(diff)) {
        this.stats.totalChangesDetected++;
        this.dampeningTimer.addDiff(diff);
        await this.saveGraph();
      }

      this.events.emit('topology-stats', this.getStats());
      logger.info(`[topology] triggerDeviceUpdate: ${deviceId} completed`);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      logger.warn(`[topology] triggerDeviceUpdate failed for ${deviceId}: ${msg}`);
    }
  }

  // ==================== 核心发现流程 ====================

  private async executeDiscovery(tier: 'fast' | 'medium' | 'slow'): Promise<void> {
    if (!this.getDevices || !this.getConnection) {
      logger.debug('[topology] No device/connection provider, skipping discovery');
      return;
    }

    const startTime = Date.now();
    this.stats.totalRounds++;

    try {
      const devices = await this.getDevices();
      if (devices.length === 0) {
        // FIX: devices 为空也算成功轮次，维持 totalRounds === successfulRounds + failedRounds
        this.stats.successfulRounds++;
        logger.info('[topology] No devices available, skipping discovery');
        return;
      }

      // 确定本轮采集的数据源
      const sources = this.getSourcesForTier(tier);

      // 采集数据
      const { data, skippedDeviceIds, errorCount } = await collectAllDevicesData(
        devices, this.getConnection, sources,
        this.config.endpointDiscoveryEnabled && tier !== 'fast',
        this.config.maxConcurrentDeviceQueries,
      );

      this.stats.deviceQueryErrors += errorCount;

      // 检查是否 degraded（超过 50% 设备查询失败）
      const activeDevices = devices.filter(d => !skippedDeviceIds.includes(d.id));
      const failedCount = activeDevices.length - data.length;
      if (activeDevices.length > 0 && failedCount / activeDevices.length > 0.5) {
        logger.warn(`[topology] Degraded round: ${failedCount}/${activeDevices.length} devices failed`);
      }

      // 构建候选图
      const candidateGraph = buildCandidateGraph(data, this.graph, this.config);

      // FIX: 先保存旧图快照，再推进状态机，最后用快照计算 diff
      // 这样 diff 反映的是状态机实际造成的变化，而非 candidateGraph 与 graph 的差异
      const oldGraph: TopologyGraph = {
        nodes: new Map(this.graph.nodes),
        edges: new Map(this.graph.edges),
        version: this.graph.version,
        lastUpdatedAt: this.graph.lastUpdatedAt,
      };

      // 状态机推进（修改 this.graph）
      this.advanceStateMachine(candidateGraph, skippedDeviceIds, tier);

      // 合并候选图中的新节点/边到 this.graph
      // FIX: 新发现的节点/边已经被本轮采集看到，confirmCount 应为 1 而非 0
      for (const [id, node] of candidateGraph.nodes) {
        if (!this.graph.nodes.has(id)) {
          this.graph.nodes.set(id, { ...node, confirmCount: 1 });
        }
      }
      for (const [id, edge] of candidateGraph.edges) {
        if (!this.graph.edges.has(id)) {
          this.graph.edges.set(id, { ...edge, confirmCount: 1 });
        }
      }

      // 滑动窗口更新（仅在 medium/slow 等级进行，因为 fast 不做邻居发现，避免错误稀释置信度）
      if (tier !== 'fast') {
        const presentEdgeIds = new Set(candidateGraph.edges.keys());
        this.slidingWindow.recordSnapshot(presentEdgeIds);

        // 清理 SlidingWindow 中已不存在的边记录
        this.slidingWindow.pruneAbsentEdges(this.graph.edges);
      }

      // 更新置信度（基于滑动窗口）
      for (const [edgeId, edge] of this.graph.edges) {
        const snapshots = this.slidingWindow.getSnapshots(edgeId);
        edge.confidence = calculateEdgeConfidence(edge.sources, this.config.edgeConfidenceWeights, snapshots);
      }

      // 更新图版本和时间戳
      this.graph.version++;
      this.graph.lastUpdatedAt = Date.now();

      // FIX: 用旧图快照和修改后的 this.graph 计算 diff（反映状态机实际变化）
      const diff = computeDiff(oldGraph, this.graph);

      if (!isDiffEmpty(diff)) {
        this.stats.totalChangesDetected++;

        // 添加到抑制定时器
        this.dampeningTimer.addDiff(diff);

        // FIX: 如果是首次有节点的图发现，立即通知前端以解除“暂无数据”等待
        if (oldGraph.nodes.size === 0 && this.graph.nodes.size > 0) {
          logger.info('[topology] First graph discovered, bypassing dampening timer');
          this.dampeningTimer.flush();
        }

        // 持久化
        await this.saveGraph();
      }

      const duration = Date.now() - startTime;
      this.stats.successfulRounds++;
      this.stats.lastDiscoveryAt = Date.now();
      this.stats.averageDurationMs = Math.round(
        ((this.stats.averageDurationMs * (this.stats.successfulRounds - 1)) + duration) / this.stats.successfulRounds
      );

      logger.info(`[topology] Discovery (${tier}) completed in ${duration}ms. Nodes: ${this.graph.nodes.size}, Edges: ${this.graph.edges.size}`);

      // 发送统计事件
      this.events.emit('topology-stats', this.getStats());

    } catch (error) {
      this.stats.failedRounds++;
      const msg = error instanceof Error ? error.message : String(error);
      logger.error(`[topology] Discovery (${tier}) failed: ${msg}`);
    }
  }

  private getSourcesForTier(tier: 'fast' | 'medium' | 'slow'): DiscoverySource[] {
    const enabled = this.config.enabledSources;
    switch (tier) {
      case 'fast': return enabled.filter(s => s === 'interface-status');
      case 'medium': return enabled.filter(s => ['ip-neighbor', 'arp', 'interface-status'].includes(s));
      case 'slow': return enabled;
    }
  }

  private advanceStateMachine(candidateGraph: TopologyGraph, skippedDeviceIds: string[], pollTier: 'fast' | 'medium' | 'slow' = 'slow'): void {
    const now = Date.now();

    // FIX: fast poll 只采集 interface-status，不包含邻居数据。
    // 如果节点/边是通过邻居发现的（sources 不含 interface-status），
    // fast poll 时不应该惩罚它们（不调用 onEntityMissed）。
    const isNeighborDiscoverable = (sources: string[] | undefined): boolean => {
      if (!sources || sources.length === 0) return true;
      // 如果节点的数据源全部来自非 interface-status，则只有 medium/slow 才能发现
      return !sources.includes('interface-status');
    };

    // 处理节点
    for (const [id, node] of this.graph.nodes) {
      // 跳过离线设备的节点
      if (node.deviceId && skippedDeviceIds.includes(node.deviceId)) continue;

      if (candidateGraph.nodes.has(id)) {
        const updated = onEntitySeen(node, node.stabilityTier, this.config, now);
        this.graph.nodes.set(id, { ...node, ...updated });
      } else {
        // FIX: fast poll 时跳过只能通过邻居发现的节点，避免误判为缺失
        if (pollTier === 'fast' && isNeighborDiscoverable(node.sources)) continue;

        const updated = onEntityMissed(node, node.stabilityTier, this.config, now);
        if (updated === null) {
          this.graph.nodes.delete(id);
        } else {
          this.graph.nodes.set(id, { ...node, ...updated });
        }
      }
    }

    // 处理边
    for (const [id, edge] of this.graph.edges) {
      // 跳过涉及离线设备的边
      const sourceNode = this.graph.nodes.get(edge.sourceId);
      const targetNode = this.graph.nodes.get(edge.targetId);
      if (sourceNode?.deviceId && skippedDeviceIds.includes(sourceNode.deviceId)) continue;
      if (targetNode?.deviceId && skippedDeviceIds.includes(targetNode.deviceId)) continue;

      const tier = sourceNode?.stabilityTier || targetNode?.stabilityTier || 'infrastructure';

      if (candidateGraph.edges.has(id)) {
        const updated = onEntitySeen(edge, tier, this.config, now);
        this.graph.edges.set(id, { ...edge, ...updated });
      } else {
        // FIX: fast poll 时跳过邻居发现的边
        if (pollTier === 'fast' && isNeighborDiscoverable(edge.sources)) continue;

        const updated = onEntityMissed(edge, tier, this.config, now);
        if (updated === null) {
          this.graph.edges.delete(id);
          this.slidingWindow.removeEdge(id);
        } else {
          this.graph.edges.set(id, { ...edge, ...updated });
        }
      }
    }

    // 引用完整性：移除孤立边
    for (const [id, edge] of this.graph.edges) {
      if (!this.graph.nodes.has(edge.sourceId) || !this.graph.nodes.has(edge.targetId)) {
        this.graph.edges.delete(id);
      }
    }
  }

  // ==================== 事件发布 ====================

  private publishDiff(diff: TopologyDiff): void {
    // 保存到历史
    this.diffHistory.push(diff);
    while (this.diffHistory.length > 100) {
      this.diffHistory.shift();
    }

    // 生成事件
    const event = this.createChangeEvent(diff);

    // 发送 SSE 事件
    this.events.emit('topology-update', event);

    // 通知外部处理器（大脑集成等）
    if (this.onTopologyChange) {
      try {
        this.onTopologyChange(event);
      } catch (error) {
        logger.warn('[topology] onTopologyChange handler failed:', error);
      }
    }

    // H2.9: 发布 topology_changed 事件到 EventBus
    if (this.eventBus) {
      try {
        this.eventBus.publish({
          type: 'internal',
          priority: event.severity === 'critical' ? 'critical' : 'medium',
          source: 'topology-discovery',
          schemaVersion: '1.0',
          payload: {
            event: 'topology_changed',
            diffSummary: event.diffSummary,
            severity: event.severity,
            nodesAdded: diff.nodesAdded.length,
            nodesRemoved: diff.nodesRemoved.length,
            edgesAdded: diff.edgesAdded.length,
            edgesRemoved: diff.edgesRemoved.length,
          },
        });
      } catch (err) {
        logger.warn('[topology] Failed to publish topology_changed to EventBus:', err);
      }
    }

    // H2.10: 同步拓扑变更到 KnowledgeGraphBuilder
    this.syncToKnowledgeGraph(diff).catch(e =>
      logger.warn('[topology] Failed to sync to KnowledgeGraphBuilder:', e)
    );

    this.saveDiffHistory().catch(e => logger.warn('[topology] Failed to save diff history:', e));
  }

  private createChangeEvent(diff: TopologyDiff): TopologyChangeEvent {
    let severity: 'info' | 'warning' | 'critical' = 'info';

    if (diff.edgesRemoved.length > this.config.criticalEdgeLossThreshold) {
      severity = 'critical';
    } else if (diff.edgesRemoved.length > 0) {
      const hasHighConfidence = diff.edgesRemoved.some(e => e.confidence >= 0.6);
      if (hasHighConfidence) severity = 'warning';
    }

    const parts: string[] = [];
    if (diff.nodesAdded.length > 0) parts.push(`+${diff.nodesAdded.length} nodes`);
    if (diff.nodesRemoved.length > 0) parts.push(`-${diff.nodesRemoved.length} nodes`);
    if (diff.edgesAdded.length > 0) parts.push(`+${diff.edgesAdded.length} edges`);
    if (diff.edgesRemoved.length > 0) parts.push(`-${diff.edgesRemoved.length} edges`);
    if (diff.edgesUpdated.length > 0) parts.push(`~${diff.edgesUpdated.length} edges`);

    return {
      id: `topo-event-${Date.now()}`,
      timestamp: Date.now(),
      source: 'topology',
      diffSummary: parts.join(', ') || 'no changes',
      diff,
      severity,
      metadata: { source: 'topology' },
    };
  }

  /** H2.10: 同步拓扑变更到 KnowledgeGraphBuilder 图谱 */
  private async syncToKnowledgeGraph(diff: TopologyDiff): Promise<void> {
    if (!this.knowledgeGraph) return;

    // Upsert new nodes as 'device' type in knowledge graph
    for (const node of diff.nodesAdded) {
      await this.knowledgeGraph.upsertNode({
        id: `topo-node-${node.id}`,
        type: 'device',
        name: node.hostname || node.id,
        label: node.hostname || node.id,
        properties: {
          deviceId: node.deviceId,
          ipAddresses: node.ipAddresses,
          deviceType: node.deviceType,
          macAddress: node.macAddress,
          stabilityTier: node.stabilityTier,
          source: 'topology-discovery',
        },
        createdAt: node.discoveredAt || Date.now(),
        updatedAt: Date.now(),
      });
    }

    // Upsert new edges as 'connected_to' type
    for (const edge of diff.edgesAdded) {
      await this.knowledgeGraph.upsertEdge({
        id: `topo-edge-${edge.id}`,
        sourceId: `topo-node-${edge.sourceId}`,
        targetId: `topo-node-${edge.targetId}`,
        type: 'connected_to',
        properties: {
          localInterface: edge.localInterface,
          remoteInterface: edge.remoteInterface,
          confidence: edge.confidence,
          source: 'topology-discovery',
        },
        weight: edge.confidence || 1.0,
        createdAt: edge.discoveredAt || Date.now(),
      });
    }

    // Remove deleted nodes (removeNode handles associated edges via transaction)
    for (const node of diff.nodesRemoved) {
      await this.knowledgeGraph.removeNode(`topo-node-${node.id}`).catch(() => {});
    }

    // Remove deleted edges
    for (const edge of diff.edgesRemoved) {
      await this.knowledgeGraph.removeEdge(`topo-edge-${edge.id}`).catch(() => {});
    }
  }

  // ==================== 轮询定时器 ====================

  /**
   * 启动轮询定时器（递归 setTimeout 模式）
   * 确保上一次任务完成后才调度下一次，避免 setInterval 的任务堆叠问题
   */
  private startPollingTimers(): void {
    const scheduleRecursive = (
      tier: 'fast' | 'medium' | 'slow',
      getInterval: () => number,
      setTimer: (t: NodeJS.Timeout | null) => void,
      getTimer: () => NodeJS.Timeout | null,
    ) => {
      const run = async () => {
        if (!this.running) return;
        try {
          await this.executeDiscovery(tier);
        } catch {
          // 错误已在 executeDiscovery 内部处理
        } finally {
          if (this.running) {
            const timer = setTimeout(run, getInterval());
            if (timer && typeof timer === 'object' && 'unref' in timer) timer.unref();
            setTimer(timer);
          }
        }
      };
      const timer = setTimeout(run, getInterval());
      if (timer && typeof timer === 'object' && 'unref' in timer) timer.unref();
      setTimer(timer);
    };

    scheduleRecursive(
      'fast',
      () => this.config.fastPollIntervalMs,
      t => { this.fastPollTimer = t; },
      () => this.fastPollTimer,
    );
    scheduleRecursive(
      'medium',
      () => this.config.mediumPollIntervalMs,
      t => { this.mediumPollTimer = t; },
      () => this.mediumPollTimer,
    );
    scheduleRecursive(
      'slow',
      () => this.config.slowPollIntervalMs,
      t => { this.slowPollTimer = t; },
      () => this.slowPollTimer,
    );
  }

  private stopPollingTimers(): void {
    if (this.fastPollTimer) { clearTimeout(this.fastPollTimer); this.fastPollTimer = null; }
    if (this.mediumPollTimer) { clearTimeout(this.mediumPollTimer); this.mediumPollTimer = null; }
    if (this.slowPollTimer) { clearTimeout(this.slowPollTimer); this.slowPollTimer = null; }
  }

  // ==================== 持久化 ====================

  private async loadConfig(): Promise<void> {
    try {
      const content = await fs.readFile(CONFIG_FILE, 'utf-8');
      const data = JSON.parse(content) as Partial<TopologyDiscoveryConfig>;
      this.config = { ...DEFAULT_TOPOLOGY_CONFIG, ...data };
    } catch {
      this.config = { ...DEFAULT_TOPOLOGY_CONFIG };
    }
  }

  private async saveConfig(): Promise<void> {
    try {
      await fs.mkdir(path.dirname(CONFIG_FILE), { recursive: true });
      await fs.writeFile(CONFIG_FILE, JSON.stringify(this.config, null, 2));
    } catch (error) {
      logger.error('[topology] Failed to save config:', error);
    }
  }

  private async loadGraph(): Promise<void> {
    try {
      const content = await fs.readFile(GRAPH_FILE, 'utf-8');
      const data = JSON.parse(content) as SerializedTopologyGraph;
      this.graph = deserializeGraph(data);
    } catch {
      this.graph = createEmptyGraph();
    }
  }

  private async saveGraph(): Promise<void> {
    try {
      await fs.mkdir(path.dirname(GRAPH_FILE), { recursive: true });
      await fs.writeFile(GRAPH_FILE, JSON.stringify(serializeGraph(this.graph), null, 2));
    } catch (error) {
      logger.error('[topology] Failed to save graph:', error);
    }
  }

  private async loadDiffHistory(): Promise<void> {
    try {
      const content = await fs.readFile(DIFF_HISTORY_FILE, 'utf-8');
      const data = JSON.parse(content) as { diffs?: TopologyDiff[] };
      this.diffHistory = data.diffs || [];
    } catch {
      this.diffHistory = [];
    }
  }

  private async saveDiffHistory(): Promise<void> {
    try {
      await fs.mkdir(path.dirname(DIFF_HISTORY_FILE), { recursive: true });
      await fs.writeFile(DIFF_HISTORY_FILE, JSON.stringify({ diffs: this.diffHistory, maxEntries: 100 }, null, 2));
    } catch (error) {
      logger.error('[topology] Failed to save diff history:', error);
    }
  }
}

// 导出单例
export const topologyDiscoveryService = new TopologyDiscoveryService();
