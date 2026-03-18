/**
 * 自动拓扑发现 - 类型定义
 *
 * Requirements: 1-15 (全部需求的类型基础)
 */

// ==================== 枚举与基础类型 ====================

/** 发现来源枚举 - RouterOS /ip/neighbor 已包含 LLDP/CDP */
export type DiscoverySource = 'ip-neighbor' | 'arp' | 'lldp' | 'cdp' | 'routing-table' | 'interface-status';

/** 节点/边状态 */
export type NodeState = 'pending' | 'confirmed' | 'stale';

/** 设备稳定性层级 */
export type StabilityTier = 'infrastructure' | 'endpoint';

/** 设备类型 */
export type DeviceType = 'router' | 'switch' | 'firewall' | 'server' | 'endpoint';

// ==================== 原始采集数据 ====================

export interface RawNeighborEntry {
  interface: string;
  address: string;
  macAddress: string;
  identity: string;
  platform: string;
  board: string;
  discoverySource: 'ip-neighbor';
}

export interface RawArpEntry {
  address: string;
  macAddress: string;
  interface: string;
  dynamic: boolean;
  discoverySource: 'arp';
}

export interface RawInterfaceEntry {
  name: string;
  type: string;
  macAddress: string;
  running: boolean;
  disabled: boolean;
  discoverySource: 'interface-status';
}

export interface RawRouteEntry {
  dstAddress: string;
  gateway: string;
  distance: number;
  active: boolean;
  discoverySource: 'routing-table';
}

export interface RawDhcpLeaseEntry {
  address: string;
  macAddress: string;
  hostName: string;
  clientId: string;
  status: string;
}

export interface ManagedTopologyDevice {
  id: string;
  tenantId: string;
  name?: string;
  host?: string;
}

export interface RawDiscoveryData {
  deviceId: string;
  tenantId: string;
  deviceName?: string;
  managementAddress?: string;
  timestamp: number;
  neighbors: RawNeighborEntry[];
  arpEntries: RawArpEntry[];
  interfaces: RawInterfaceEntry[];
  routes: RawRouteEntry[];
  dhcpLeases: RawDhcpLeaseEntry[];
  errors: { source: DiscoverySource; error: string }[];
}

// ==================== 拓扑图数据结构 ====================

export interface TopologyNode {
  id: string;
  deviceId?: string;
  hostname: string;
  ipAddresses: string[];
  macAddress: string;
  deviceType: DeviceType;
  stabilityTier: StabilityTier;
  state: NodeState;
  confirmCount: number;
  missCount: number;
  discoveredAt: number;
  lastSeenAt: number;
  sources: DiscoverySource[];
  connectedTo?: string;
  endpointInfo?: {
    displayName: string;
    dhcpHostname?: string;
    clientId?: string;
  };
}

export interface TopologyEdge {
  id: string;
  sourceId: string;
  targetId: string;
  localInterface: string;
  remoteInterface: string;
  confidence: number;
  sources: DiscoverySource[];
  state: NodeState;
  confirmCount: number;
  missCount: number;
  discoveredAt: number;
  lastSeenAt: number;
  localInterfaceRunning: boolean;
  remoteInterfaceRunning: boolean;
}

export interface TopologyGraph {
  nodes: Map<string, TopologyNode>;
  edges: Map<string, TopologyEdge>;
  version: number;
  lastUpdatedAt: number;
}

/** 序列化格式（用于 JSON 持久化） */
export interface SerializedTopologyGraph {
  nodes: TopologyNode[];
  edges: TopologyEdge[];
  version: number;
  lastUpdatedAt: number;
}

// ==================== 差分与事件 ====================

export interface TopologyDiff {
  id: string;
  timestamp: number;
  nodesAdded: TopologyNode[];
  nodesRemoved: TopologyNode[];
  edgesAdded: TopologyEdge[];
  edgesRemoved: TopologyEdge[];
  edgesUpdated: { edgeId: string; changes: Record<string, { old: unknown; new: unknown }> }[];
  nodesUpdated: { nodeId: string; changes: Record<string, { old: unknown; new: unknown }> }[];
}

export interface TopologyChangeEvent {
  id: string;
  timestamp: number;
  source: 'topology';
  diffSummary: string;
  diff: TopologyDiff;
  severity: 'info' | 'warning' | 'critical';
  metadata: { source: 'topology' };
}

// ==================== 统计与配置 ====================

export interface TopologyStats {
  totalRounds: number;
  successfulRounds: number;
  failedRounds: number;
  averageDurationMs: number;
  lastDiscoveryAt: number | null;
  currentNodeCount: number;
  currentEdgeCount: number;
  totalChangesDetected: number;
  deviceQueryErrors: number;
}

export interface TopologyDiscoveryConfig {
  enabled: boolean;
  fastPollIntervalMs: number;
  mediumPollIntervalMs: number;
  slowPollIntervalMs: number;
  infraConfirmCount: number;
  infraStaleThresholdCount: number;
  endpointConfirmCount: number;
  endpointStaleThresholdCount: number;
  staleExpiryMs: number;
  edgeConfidenceWeights: Record<DiscoverySource, number>;
  criticalEdgeLossThreshold: number;
  enabledSources: DiscoverySource[];
  dampeningTimerMs: number;
  slidingWindowSize: number;
  endpointDiscoveryEnabled: boolean;
  maxConcurrentDeviceQueries: number;
}

export const DEFAULT_TOPOLOGY_CONFIG: TopologyDiscoveryConfig = {
  enabled: true,
  fastPollIntervalMs: 60000,       // 1 分钟（原 15s 太激进，压垮路由器）
  mediumPollIntervalMs: 180000,    // 3 分钟（原 60s）
  slowPollIntervalMs: 600000,      // 10 分钟（原 5 分钟）
  infraConfirmCount: 5,
  infraStaleThresholdCount: 7,
  endpointConfirmCount: 3,
  endpointStaleThresholdCount: 3,
  staleExpiryMs: 600000,           // 与 slowPoll 对齐
  edgeConfidenceWeights: {
    'ip-neighbor': 0.4,
    'arp': 0.2,
    'lldp': 0.3,
    'cdp': 0.3,
    'routing-table': 0.1,
    'interface-status': 0.0,
  },
  criticalEdgeLossThreshold: 3,
  enabledSources: ['ip-neighbor', 'arp', 'routing-table', 'interface-status'],
  dampeningTimerMs: 30000,
  slidingWindowSize: 5,
  endpointDiscoveryEnabled: true,
  maxConcurrentDeviceQueries: 2,   // 原 5，降低并发避免路由器过载
};

/** 创建空拓扑图 */
export function createEmptyGraph(): TopologyGraph {
  return { nodes: new Map(), edges: new Map(), version: 0, lastUpdatedAt: Date.now() };
}

/** 创建空统计 */
export function createEmptyStats(): TopologyStats {
  return {
    totalRounds: 0, successfulRounds: 0, failedRounds: 0,
    averageDurationMs: 0, lastDiscoveryAt: null,
    currentNodeCount: 0, currentEdgeCount: 0,
    totalChangesDetected: 0, deviceQueryErrors: 0,
  };
}
