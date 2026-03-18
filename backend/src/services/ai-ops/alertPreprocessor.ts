/**
 * AlertPreprocessor 告警预处理服务
 * 负责事件归一化、聚合和上下文增强
 *
 * Requirements: 4.1, 4.2, 4.3, 4.4, 4.5, 4.6
 * - 4.1: 将不同来源的事件（Syslog、metrics-based alerts、manual）归一化为统一格式
 * - 4.2: 统一事件格式包含：source, timestamp, severity, category, message, rawData, metadata
 * - 4.3: 在时间窗口内将多个相关事件聚合为单个复合事件
 * - 4.4: 检测接口 flapping（状态频繁变化）并报告 flapping 频率
 * - 4.5: 创建复合事件时保留对所有原始事件的引用
 * - 4.6: 自动使用连接上下文中的设备信息增强事件
 */

import { v4 as uuidv4 } from 'uuid';
import {
  AlertEvent,
  SyslogEvent,
  UnifiedEvent,
  CompositeEvent,
  AggregationRule,
  DeviceInfo,
  AlertSeverity,
  IAlertPreprocessor,
  EventSource,
} from '../../types/ai-ops';
import { RouterOSClient } from '../routerosClient';
import { logger } from '../../utils/logger';

/**
 * 默认聚合规则
 */
const DEFAULT_AGGREGATION_RULES: AggregationRule[] = [
  {
    id: 'interface-flapping',
    name: 'Interface Flapping Detection',
    pattern: 'interface.*status|link.*up|link.*down',
    windowMs: 30000, // 30 seconds
    minCount: 2,
    category: 'interface',
  },
  {
    id: 'auth-failure',
    name: 'Authentication Failure Aggregation',
    pattern: 'login.*fail|auth.*fail|invalid.*password',
    windowMs: 60000, // 1 minute
    minCount: 3,
    category: 'security',
  },
  {
    id: 'connection-issues',
    name: 'Connection Issues Aggregation',
    pattern: 'connection.*lost|disconnect|timeout',
    windowMs: 60000, // 1 minute
    minCount: 2,
    category: 'network',
  },
];

/**
 * 事件缓冲区条目
 */
interface EventBufferEntry {
  event: UnifiedEvent;
  ruleId: string;
  addedAt: number;
}

/**
 * 接口状态跟踪
 */
interface InterfaceStateTracker {
  interfaceName: string;
  stateChanges: Array<{
    timestamp: number;
    state: 'up' | 'down';
    eventId: string;
  }>;
}

export class AlertPreprocessor implements IAlertPreprocessor {
  private aggregationRules: AggregationRule[] = [...DEFAULT_AGGREGATION_RULES];
  private eventBuffer: Map<string, EventBufferEntry[]> = new Map();
  private interfaceTrackers: Map<string, InterfaceStateTracker> = new Map();
  private deviceInfoCache: DeviceInfo | null = null;
  private deviceInfoCacheTime: number = 0;
  private readonly DEVICE_INFO_CACHE_TTL = 5 * 60 * 1000; // 5 minutes
  private cleanupTimer: NodeJS.Timeout | null = null;

  constructor() {
    // Start cleanup timer for event buffer
    this.cleanupTimer = setInterval(() => this.cleanupEventBuffer(), 10000); // Every 10 seconds
    logger.info('AlertPreprocessor initialized');
  }

  /**
   * 停止清理定时器
   * 用于测试环境清理
   */
  stopCleanupTimer(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
      logger.debug('AlertPreprocessor cleanup timer stopped');
    }
  }

  /**
   * 归一化事件 - 将不同来源的事件转换为统一格式
   * Requirements: 4.1, 4.2
   */
  normalize(event: SyslogEvent | AlertEvent): UnifiedEvent {
    // Check if it's a SyslogEvent
    if (this.isSyslogEvent(event)) {
      return this.normalizeSyslogEvent(event);
    }

    // It's an AlertEvent (metrics-based)
    return this.normalizeAlertEvent(event);
  }

  /**
   * 类型守卫：检查是否为 SyslogEvent
   */
  private isSyslogEvent(event: SyslogEvent | AlertEvent): event is SyslogEvent {
    return (event as SyslogEvent).source === 'syslog' && 'rawData' in event;
  }

  /**
   * 归一化 Syslog 事件
   */
  private normalizeSyslogEvent(event: SyslogEvent): UnifiedEvent {
    return {
      id: event.id,
      tenantId: event.tenantId,
      deviceId: event.deviceId,
      source: 'syslog',
      timestamp: event.timestamp,
      severity: event.severity,
      category: event.category,
      message: event.message,
      rawData: event.rawData,
      metadata: {
        ...event.metadata,
        originalSource: 'syslog',
      },
    };
  }

  /**
   * 归一化 AlertEvent（基于指标的告警）
   */
  private normalizeAlertEvent(event: AlertEvent): UnifiedEvent {
    return {
      id: event.id,
      tenantId: event.tenantId,
      deviceId: event.deviceId,
      source: 'metrics',
      timestamp: event.triggeredAt,
      severity: event.severity,
      category: this.mapMetricToCategory(event.metric),
      message: event.message,
      rawData: event,
      metadata: {
        originalSource: 'metrics',
        ruleId: event.ruleId,
        ruleName: event.ruleName,
        metric: event.metric,
        currentValue: event.currentValue,
        threshold: event.threshold,
        status: event.status,
      },
      alertRuleInfo: {
        ruleId: event.ruleId,
        ruleName: event.ruleName,
        metric: event.metric,
        threshold: event.threshold,
        currentValue: event.currentValue,
      },
      // Propagate system association configuration (Requirements: System Association Issue #2)
      notifyChannels: event.notifyChannels,
      autoResponseConfig: event.autoResponseConfig,
    };
  }

  /**
   * 将指标类型映射到事件类别
   */
  private mapMetricToCategory(metric: string): string {
    const categoryMap: Record<string, string> = {
      cpu: 'system',
      memory: 'system',
      disk: 'system',
      interface_status: 'interface',
      interface_traffic: 'interface',
    };
    return categoryMap[metric] || 'unknown';
  }

  /**
   * 尝试聚合事件
   * Requirements: 4.3, 4.4, 4.5
   */
  aggregate(event: UnifiedEvent): UnifiedEvent | CompositeEvent {
    // Check for interface flapping first
    const flappingResult = this.checkInterfaceFlapping(event);
    if (flappingResult) {
      return flappingResult;
    }

    // Check against aggregation rules
    for (const rule of this.aggregationRules) {
      if (this.matchesAggregationRule(event, rule)) {
        const compositeEvent = this.tryAggregate(event, rule);
        if (compositeEvent) {
          return compositeEvent;
        }
      }
    }

    return event;
  }

  /**
   * 检查接口 flapping
   * Requirements: 4.4
   */
  private checkInterfaceFlapping(event: UnifiedEvent): CompositeEvent | null {
    // Only check interface-related events
    if (event.category !== 'interface') {
      return null;
    }

    // Extract interface name from event
    const interfaceName = this.extractInterfaceName(event);
    if (!interfaceName) {
      return null;
    }

    // Get or create tracker
    let tracker = this.interfaceTrackers.get(interfaceName);
    if (!tracker) {
      tracker = {
        interfaceName,
        stateChanges: [],
      };
      this.interfaceTrackers.set(interfaceName, tracker);
    }

    // Determine state from event
    const state = this.extractInterfaceState(event);
    if (!state) {
      return null;
    }

    // Add state change
    tracker.stateChanges.push({
      timestamp: event.timestamp,
      state,
      eventId: event.id,
    });

    // Clean up old state changes (older than 30 seconds)
    const cutoffTime = Date.now() - 30000;
    tracker.stateChanges = tracker.stateChanges.filter(
      (sc) => sc.timestamp >= cutoffTime
    );

    // Check for flapping (2+ state changes in 30 seconds)
    if (tracker.stateChanges.length >= 2) {
      const childEventIds = tracker.stateChanges.map((sc) => sc.eventId);
      const firstSeen = Math.min(...tracker.stateChanges.map((sc) => sc.timestamp));
      const lastSeen = Math.max(...tracker.stateChanges.map((sc) => sc.timestamp));

      // Create composite event for flapping
      const compositeEvent: CompositeEvent = {
        id: uuidv4(),
        tenantId: event.tenantId,
        deviceId: event.deviceId,
        source: event.source,
        timestamp: event.timestamp,
        severity: this.escalateSeverity(event.severity),
        category: 'interface',
        message: `Interface ${interfaceName} flapping detected: ${tracker.stateChanges.length} state changes in ${Math.round((lastSeen - firstSeen) / 1000)}s`,
        rawData: event.rawData,
        metadata: {
          ...event.metadata,
          flapping: true,
          interfaceName,
          stateChangeCount: tracker.stateChanges.length,
        },
        isComposite: true,
        childEvents: childEventIds,
        aggregation: {
          count: tracker.stateChanges.length,
          firstSeen,
          lastSeen,
          pattern: 'interface-flapping',
        },
      };

      // Clear tracker after creating composite event
      tracker.stateChanges = [];

      logger.info(
        `Interface flapping detected: ${interfaceName}, ${compositeEvent.aggregation.count} state changes`
      );

      return compositeEvent;
    }

    return null;
  }

  /**
   * 从事件中提取接口名称
   */
  private extractInterfaceName(event: UnifiedEvent): string | null {
    // Check metadata first
    if (event.metadata?.interfaceName) {
      return event.metadata.interfaceName as string;
    }

    // Check alertRuleInfo for metrics-based events
    if (event.alertRuleInfo?.metric === 'interface_status') {
      // Try to extract from rawData
      const rawData = event.rawData as AlertEvent;
      if (rawData && typeof rawData === 'object') {
        // Look for metricLabel in the original alert rule
        const message = event.message;
        const match = message.match(/\(([^)]+)\)/);
        if (match) {
          return match[1];
        }
      }
    }

    // Try to extract from message
    const patterns = [
      /interface[:\s]+(\S+)/i,
      /link[:\s]+(\S+)/i,
      /(\S+)\s+(?:is\s+)?(?:up|down)/i,
    ];

    for (const pattern of patterns) {
      const match = event.message.match(pattern);
      if (match) {
        return match[1];
      }
    }

    return null;
  }

  /**
   * 从事件中提取接口状态
   */
  private extractInterfaceState(event: UnifiedEvent): 'up' | 'down' | null {
    const message = event.message.toLowerCase();

    // Check for explicit state mentions
    if (message.includes('down') || message.includes('断开') || message.includes('disconnected')) {
      return 'down';
    }
    if (message.includes('up') || message.includes('连接') || message.includes('connected')) {
      return 'up';
    }

    // Check metadata
    if (event.metadata?.currentValue !== undefined) {
      return event.metadata.currentValue === 1 ? 'up' : 'down';
    }

    return null;
  }

  /**
   * 升级严重级别
   */
  private escalateSeverity(severity: AlertSeverity): AlertSeverity {
    const severityOrder: AlertSeverity[] = ['info', 'warning', 'critical', 'emergency'];
    const currentIndex = severityOrder.indexOf(severity);
    if (currentIndex < severityOrder.length - 1) {
      return severityOrder[currentIndex + 1];
    }
    return severity;
  }

  /**
   * 检查事件是否匹配聚合规则
   */
  private matchesAggregationRule(event: UnifiedEvent, rule: AggregationRule): boolean {
    try {
      const regex = new RegExp(rule.pattern, 'i');
      return regex.test(event.message) || regex.test(event.category);
    } catch {
      // Invalid regex pattern
      return false;
    }
  }

  /**
   * 尝试将事件聚合到现有缓冲区
   */
  private tryAggregate(event: UnifiedEvent, rule: AggregationRule): CompositeEvent | null {
    const bufferKey = rule.id;
    let buffer = this.eventBuffer.get(bufferKey);

    if (!buffer) {
      buffer = [];
      this.eventBuffer.set(bufferKey, buffer);
    }

    // Add event to buffer
    buffer.push({
      event,
      ruleId: rule.id,
      addedAt: Date.now(),
    });

    // Clean up old entries
    const cutoffTime = Date.now() - rule.windowMs;
    buffer = buffer.filter((entry) => entry.addedAt >= cutoffTime);
    this.eventBuffer.set(bufferKey, buffer);

    // Check if we have enough events to aggregate
    if (buffer.length >= rule.minCount) {
      const childEvents = buffer.map((entry) => entry.event.id);
      const timestamps = buffer.map((entry) => entry.event.timestamp);
      const firstSeen = Math.min(...timestamps);
      const lastSeen = Math.max(...timestamps);

      // Create composite event
      const compositeEvent: CompositeEvent = {
        id: uuidv4(),
        tenantId: event.tenantId,
        deviceId: event.deviceId,
        source: event.source,
        timestamp: event.timestamp,
        severity: this.escalateSeverity(event.severity),
        category: rule.category,
        message: `Aggregated ${buffer.length} ${rule.name} events`,
        rawData: buffer.map((entry) => entry.event.rawData),
        metadata: {
          aggregationRule: rule.id,
          aggregationRuleName: rule.name,
          eventCount: buffer.length,
        },
        isComposite: true,
        childEvents,
        aggregation: {
          count: buffer.length,
          firstSeen,
          lastSeen,
          pattern: rule.pattern,
        },
      };

      // Clear buffer after aggregation
      this.eventBuffer.set(bufferKey, []);

      logger.info(
        `Events aggregated by rule ${rule.name}: ${compositeEvent.aggregation.count} events`
      );

      return compositeEvent;
    }

    return null;
  }

  /**
   * 清理过期的事件缓冲区
   */
  private cleanupEventBuffer(): void {
    const now = Date.now();

    for (const [ruleId, buffer] of this.eventBuffer) {
      const rule = this.aggregationRules.find((r) => r.id === ruleId);
      if (!rule) {
        this.eventBuffer.delete(ruleId);
        continue;
      }

      const cutoffTime = now - rule.windowMs;
      const filtered = buffer.filter((entry) => entry.addedAt >= cutoffTime);

      if (filtered.length !== buffer.length) {
        this.eventBuffer.set(ruleId, filtered);
      }
    }

    // Clean up interface trackers
    for (const [interfaceName, tracker] of this.interfaceTrackers) {
      const cutoffTime = now - 30000; // 30 seconds
      tracker.stateChanges = tracker.stateChanges.filter(
        (sc) => sc.timestamp >= cutoffTime
      );

      if (tracker.stateChanges.length === 0) {
        this.interfaceTrackers.delete(interfaceName);
      }
    }
  }

  private devicePool: any | null = null; // Store DevicePool instance

  /**
   * 设置设备连接池
   */
  setDevicePool(devicePool: any): void {
    this.devicePool = devicePool;
    logger.debug('AlertPreprocessor device pool set');
  }

  /**
   * 增强上下文 - 添加设备信息
   * Requirements: 4.6
   */
  async enrichContext(event: UnifiedEvent): Promise<UnifiedEvent> {
    const deviceId = event.deviceId;
    const tenantId = event.tenantId;

    if (!deviceId) {
      return event;
    }

    try {
      const deviceInfo = await this.getDeviceInfo(deviceId, tenantId);
      if (deviceInfo) {
        return {
          ...event,
          deviceInfo,
        };
      }
    } catch (error) {
      logger.warn(`Failed to enrich event ${event.id} with device info for ${deviceId}:`, error);
    }

    return event;
  }

  /**
   * 获取设备信息（带缓存）
   */
  private async getDeviceInfo(deviceId: string, tenantId?: string): Promise<DeviceInfo | null> {
    // Check cache (simplification: we might need per-device cache, but TTL is short)
    if (
      this.deviceInfoCache &&
      this.deviceInfoCache.ip && // Hacky check if it matches current device, but we should really have per-device cache
      Date.now() - this.deviceInfoCacheTime < this.DEVICE_INFO_CACHE_TTL
    ) {
      // For multi-device, we should ideally have a Map for cache.
      // But let's simplify or just fetch fresh if not using a Map.
    }

    if (!this.devicePool) {
      return null;
    }

    try {
      // Get connection from pool
      const client = await this.devicePool.getConnection(tenantId || 'default', deviceId);
      if (!client || !client.isConnected()) {
        return null;
      }

      // Get system identity
      const identityResult = await (client as RouterOSClient).print<{ name: string }>(
        '/system/identity'
      );
      const hostname = identityResult[0]?.name || 'unknown';

      // Get system resource info
      const resourceResult = await (client as RouterOSClient).print<{
        'board-name'?: string;
        version?: string;
        'architecture-name'?: string;
      }>('/system/resource');
      const resource = resourceResult[0] || {};

      // Get connection config for IP
      const config = client.getConfig();
      const ip = config?.host || 'unknown';

      const deviceInfo: DeviceInfo = {
        hostname,
        model: resource['board-name'] || resource['architecture-name'] || 'unknown',
        version: resource.version || 'unknown',
        ip,
      };

      // Optional: update cache for this device?
      // this.deviceInfoCache = deviceInfo;
      // this.deviceInfoCacheTime = Date.now();

      return deviceInfo;
    } catch (error) {
      logger.warn(`Failed to get device info for ${deviceId}:`, error);
      return null;
    }
  }

  /**
   * 处理事件 - 完整的预处理流程
   * 归一化 → 聚合 → 上下文增强
   */
  async process(event: SyslogEvent | AlertEvent): Promise<UnifiedEvent | CompositeEvent> {
    // Step 1: Normalize
    const normalizedEvent = this.normalize(event);

    // Step 2: Aggregate
    const aggregatedEvent = this.aggregate(normalizedEvent);

    // Step 3: Enrich context
    const enrichedEvent = await this.enrichContext(aggregatedEvent);

    return enrichedEvent;
  }

  /**
   * 添加聚合规则
   */
  addAggregationRule(rule: AggregationRule): void {
    // Check for duplicate ID
    const existingIndex = this.aggregationRules.findIndex((r) => r.id === rule.id);
    if (existingIndex >= 0) {
      this.aggregationRules[existingIndex] = rule;
      logger.info(`Aggregation rule updated: ${rule.name}`);
    } else {
      this.aggregationRules.push(rule);
      logger.info(`Aggregation rule added: ${rule.name}`);
    }
  }

  /**
   * 移除聚合规则
   */
  removeAggregationRule(id: string): void {
    const index = this.aggregationRules.findIndex((r) => r.id === id);
    if (index >= 0) {
      const rule = this.aggregationRules[index];
      this.aggregationRules.splice(index, 1);
      this.eventBuffer.delete(id);
      logger.info(`Aggregation rule removed: ${rule.name}`);
    }
  }

  /**
   * 获取所有聚合规则
   */
  getAggregationRules(): AggregationRule[] {
    return [...this.aggregationRules];
  }

  /**
   * 创建手动事件
   * 用于 API 创建的告警
   */
  createManualEvent(params: {
    severity: AlertSeverity;
    category: string;
    message: string;
    metadata?: Record<string, unknown>;
  }): UnifiedEvent {
    return {
      id: uuidv4(),
      source: 'manual',
      timestamp: Date.now(),
      severity: params.severity,
      category: params.category,
      message: params.message,
      rawData: params,
      metadata: {
        ...params.metadata,
        originalSource: 'manual',
      },
    };
  }

  /**
   * 创建 API 事件
   * 用于外部系统通过 API 推送的告警
   */
  createApiEvent(params: {
    severity: AlertSeverity;
    category: string;
    message: string;
    rawData?: unknown;
    metadata?: Record<string, unknown>;
  }): UnifiedEvent {
    return {
      id: uuidv4(),
      source: 'api',
      timestamp: Date.now(),
      severity: params.severity,
      category: params.category,
      message: params.message,
      rawData: params.rawData || params,
      metadata: {
        ...params.metadata,
        originalSource: 'api',
      },
    };
  }

  /**
   * 获取统计信息
   */
  getStats(): {
    aggregationRulesCount: number;
    eventBufferSize: number;
    interfaceTrackersCount: number;
    deviceInfoCached: boolean;
  } {
    let totalBufferSize = 0;
    for (const buffer of this.eventBuffer.values()) {
      totalBufferSize += buffer.length;
    }

    return {
      aggregationRulesCount: this.aggregationRules.length,
      eventBufferSize: totalBufferSize,
      interfaceTrackersCount: this.interfaceTrackers.size,
      deviceInfoCached: this.deviceInfoCache !== null,
    };
  }

  /**
   * 清空缓冲区
   */
  clearBuffers(): void {
    this.eventBuffer.clear();
    this.interfaceTrackers.clear();
    logger.info('AlertPreprocessor buffers cleared');
  }

  /**
   * 清空设备信息缓存
   */
  clearDeviceInfoCache(): void {
    this.deviceInfoCache = null;
    this.deviceInfoCacheTime = 0;
    logger.info('AlertPreprocessor device info cache cleared');
  }
}

// 导出单例实例
export const alertPreprocessor = new AlertPreprocessor();
