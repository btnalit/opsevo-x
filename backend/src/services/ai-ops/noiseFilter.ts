/**
 * NoiseFilter 四层噪声过滤服务
 *
 * Requirements: G2.5, G2.6, PG.3, PG.4
 * - G2.5: 四层过滤机制：维护窗口过滤 → 抖动检测 → 关联分析 → 优先级过滤
 * - G2.6: 通过 EventBus 发布 noise_filter_stats 事件
 * - PG.3: 维护窗口内不放行非 critical 告警
 * - PG.4: 同一来源频率超阈值时必定触发聚合
 *
 * 四层架构：
 * 1. 维护窗口过滤 — 在预定义维护时段内抑制非 critical 告警
 * 2. 抖动检测 — 同一来源告警频率超阈值时聚合为单条
 * 3. 关联分析 — 识别因果关联的告警并合并为告警组
 * 4. 优先级过滤 — 根据当前系统负载动态调整过滤阈值
 */

import { v4 as uuidv4 } from 'uuid';
import {
  UnifiedEvent,
  MaintenanceWindow,
  KnownIssue,
  FilterResult,
  FilterFeedback,
  FilterFeedbackStats,
  INoiseFilter,
  CreateMaintenanceWindowInput,
  UpdateMaintenanceWindowInput,
  CreateKnownIssueInput,
  UpdateKnownIssueInput,
} from '../../types/ai-ops';
import { logger } from '../../utils/logger';

// ─── EventBus 类型（避免循环依赖，使用鸭子类型） ───

interface EventBusLike {
  publish(event: {
    type: string;
    priority: string;
    source: string;
    payload: Record<string, unknown>;
  }): Promise<unknown>;
}

// ─── MetricsCollector 类型（可选依赖） ───

interface MetricsCollectorLike {
  getLatest(): Promise<{ system: { cpu: { usage: number } } } | null>;
}

// ─── 内部类型 ───

/** 抖动跟踪器 */
interface JitterTracker {
  timestamps: number[];
  aggregatedCount: number;
}

/** 关联组 */
interface CorrelationGroup {
  id: string;
  deviceId: string;
  categories: Set<string>;
  eventIds: string[];
  firstSeen: number;
  lastSeen: number;
}

/** 过滤统计 */
interface FilterStats {
  totalProcessed: number;
  totalFiltered: number;
  layerCounts: [number, number, number, number];
  aggregationCount: number;
}

// ─── 关联类别映射 ───

const RELATED_CATEGORIES: Record<string, string[]> = {
  interface: ['routing', 'traffic', 'link'],
  routing: ['interface', 'bgp', 'ospf'],
  cpu: ['memory', 'process', 'system'],
  memory: ['cpu', 'process', 'system'],
  disk: ['system', 'storage'],
  system: ['cpu', 'memory', 'disk', 'process'],
};


export class NoiseFilter implements INoiseFilter {
  // ─── 数据存储（内存） ───
  private maintenanceWindows: MaintenanceWindow[] = [];
  private knownIssues: KnownIssue[] = [];
  private initialized = false;

  // ─── 可选依赖（setter 注入） ───
  private eventBus: EventBusLike | null = null;
  private metricsCollector: MetricsCollectorLike | null = null;

  // ─── Layer 2: 抖动检测 ───
  private jitterTrackers: Map<string, JitterTracker> = new Map();
  private readonly JITTER_WINDOW_MS: number;
  private readonly JITTER_THRESHOLD: number;

  // ─── Layer 3: 关联分析 ───
  private correlationGroups: Map<string, CorrelationGroup> = new Map();
  private readonly CORRELATION_WINDOW_MS: number;

  // ─── Layer 4: 负载过滤 ───
  private currentLoadLevel: 'normal' | 'high' | 'critical' = 'normal';
  private eventQueueDepth = 0;

  // ─── 统计 ───
  private stats: FilterStats = {
    totalProcessed: 0,
    totalFiltered: 0,
    layerCounts: [0, 0, 0, 0],
    aggregationCount: 0,
  };

  // ─── 反馈 ───
  private feedbackStats: FilterFeedbackStats = {
    total: 0,
    falsePositives: 0,
    falseNegatives: 0,
  };

  // ─── 定时器 ───
  private cleanupTimer: NodeJS.Timeout | null = null;
  private statsTimer: NodeJS.Timeout | null = null;

  constructor(config?: {
    jitterWindowMs?: number;
    jitterThreshold?: number;
    correlationWindowMs?: number;
    statsIntervalMs?: number;
  }) {
    this.JITTER_WINDOW_MS = config?.jitterWindowMs ?? 30000;
    this.JITTER_THRESHOLD = config?.jitterThreshold ?? 3;
    this.CORRELATION_WINDOW_MS = config?.correlationWindowMs ?? 300000; // 5 min

    // 定期清理过期跟踪器
    this.cleanupTimer = setInterval(() => this.cleanup(), 10000);

    // 定期发布统计（G2.6）
    const statsInterval = config?.statsIntervalMs ?? 60000;
    this.statsTimer = setInterval(() => this.publishStats(), statsInterval);

    logger.info('NoiseFilter initialized (four-layer architecture)');
  }

  // ─── 依赖注入 ───

  setEventBus(eventBus: EventBusLike): void {
    this.eventBus = eventBus;
  }

  setMetricsCollector(metricsCollector: MetricsCollectorLike): void {
    this.metricsCollector = metricsCollector;
  }

  /** 停止所有定时器 */
  stopCleanupTimer(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
    if (this.statsTimer) {
      clearInterval(this.statsTimer);
      this.statsTimer = null;
    }
    logger.debug('NoiseFilter timers stopped');
  }

  /** 初始化（保持向后兼容） */
  async initialize(): Promise<void> {
    if (this.initialized) return;
    this.initialized = true;
    logger.info('NoiseFilter data loaded');
  }


  // ══════════════════════════════════════════════════════════
  // 主过滤逻辑 — 四层架构 (G2.5)
  // ══════════════════════════════════════════════════════════

  /**
   * 四层噪声过滤
   * Requirements: G2.5, PG.3, PG.4
   */
  async filter(event: UnifiedEvent): Promise<FilterResult> {
    await this.initialize();
    this.stats.totalProcessed++;

    // Pre-filter: 已知问题匹配（保持向后兼容）
    const knownIssue = this.matchesKnownIssue(event);
    if (knownIssue) {
      this.stats.totalFiltered++;
      logger.info(`[Pre-filter] Known issue match: ${event.id}, issue: ${knownIssue.description}`);
      return {
        filtered: true,
        reason: 'known_issue',
        details: `Matches known issue: ${knownIssue.description}`,
      };
    }

    // 层 1：维护窗口过滤（PG.3 — 非 critical 抑制）
    if (this.isInMaintenanceWindow(event) && event.severity !== 'critical') {
      this.stats.totalFiltered++;
      this.stats.layerCounts[0]++;
      logger.info(`[Layer1] Maintenance window filter: ${event.id}`);
      return {
        filtered: true,
        reason: 'maintenance_window',
        layer: 1,
        details: 'Alert suppressed during maintenance window (non-critical)',
      };
    }

    // 层 2：抖动检测（PG.4 — 频率超阈值聚合）
    const jitterResult = this.checkJitter(event);
    if (jitterResult) {
      this.stats.totalFiltered++;
      this.stats.layerCounts[1]++;
      this.stats.aggregationCount++;
      logger.info(`[Layer2] Jitter aggregated: ${event.id}`);
      return jitterResult;
    }

    // 层 3：关联分析
    const correlationResult = this.checkCorrelation(event);
    if (correlationResult) {
      this.stats.totalFiltered++;
      this.stats.layerCounts[2]++;
      logger.info(`[Layer3] Correlated: ${event.id}`);
      return correlationResult;
    }

    // 层 4：优先级过滤（动态阈值）
    const loadResult = this.checkLoadFilter(event);
    if (loadResult) {
      this.stats.totalFiltered++;
      this.stats.layerCounts[3]++;
      logger.info(`[Layer4] Load filtered: ${event.id}`);
      return loadResult;
    }

    return { filtered: false };
  }

  // ══════════════════════════════════════════════════════════
  // Layer 2: 抖动检测 (PG.4)
  // ══════════════════════════════════════════════════════════

  /**
   * 检查事件是否为抖动（任意来源，不限于接口事件）
   * 跟踪 deviceId + category 的事件频率
   */
  private checkJitter(event: UnifiedEvent): FilterResult | null {
    const sourceKey = `${event.deviceId || 'global'}:${event.category}`;
    let tracker = this.jitterTrackers.get(sourceKey);

    if (!tracker) {
      tracker = { timestamps: [], aggregatedCount: 0 };
      this.jitterTrackers.set(sourceKey, tracker);
    }

    const now = event.timestamp || Date.now();
    tracker.timestamps.push(now);

    // 清理窗口外的时间戳
    const cutoff = now - this.JITTER_WINDOW_MS;
    tracker.timestamps = tracker.timestamps.filter((t) => t >= cutoff);

    // 频率超阈值 → 聚合
    if (tracker.timestamps.length >= this.JITTER_THRESHOLD) {
      tracker.aggregatedCount++;
      return {
        filtered: true,
        reason: 'jitter_aggregated',
        layer: 2,
        details: `Source ${sourceKey} jittering: ${tracker.timestamps.length} events in ${this.JITTER_WINDOW_MS / 1000}s window (aggregated #${tracker.aggregatedCount})`,
      };
    }

    return null;
  }

  // ══════════════════════════════════════════════════════════
  // Layer 3: 关联分析
  // ══════════════════════════════════════════════════════════

  /**
   * 查找事件的关联组
   * 同一设备 + 时间窗口内 + 相关类别 → 合并
   */
  private checkCorrelation(event: UnifiedEvent): FilterResult | null {
    if (!event.deviceId) return null;

    const now = event.timestamp || Date.now();
    const cutoff = now - this.CORRELATION_WINDOW_MS;

    // 清理过期关联组
    for (const [id, group] of this.correlationGroups) {
      if (group.lastSeen < cutoff) {
        this.correlationGroups.delete(id);
      }
    }

    // 查找匹配的关联组
    for (const [, group] of this.correlationGroups) {
      if (group.deviceId !== event.deviceId) continue;
      if (group.lastSeen < cutoff) continue;

      // 检查类别是否关联
      if (this.areCategoriesRelated(event.category, group.categories)) {
        // 合并到组
        group.eventIds.push(event.id);
        group.categories.add(event.category);
        group.lastSeen = now;
        return {
          filtered: true,
          reason: 'correlated',
          layer: 3,
          details: `Correlated with group (${group.eventIds.length} events, categories: ${[...group.categories].join(', ')})`,
        };
      }
    }

    // 没有匹配的组 → 创建新组（不过滤当前事件）
    const groupId = uuidv4();
    this.correlationGroups.set(groupId, {
      id: groupId,
      deviceId: event.deviceId,
      categories: new Set([event.category]),
      eventIds: [event.id],
      firstSeen: now,
      lastSeen: now,
    });

    return null;
  }

  /** 检查两个类别是否关联 */
  private areCategoriesRelated(category: string, existingCategories: Set<string>): boolean {
    // 同类别直接关联
    if (existingCategories.has(category)) return true;

    // 查找预定义关联
    const related = RELATED_CATEGORIES[category];
    if (related) {
      for (const cat of existingCategories) {
        if (related.includes(cat)) return true;
      }
    }

    // 反向查找
    for (const cat of existingCategories) {
      const catRelated = RELATED_CATEGORIES[cat];
      if (catRelated && catRelated.includes(category)) return true;
    }

    return false;
  }

  // ══════════════════════════════════════════════════════════
  // Layer 4: 优先级过滤（动态阈值）
  // ══════════════════════════════════════════════════════════

  /**
   * 根据系统负载动态过滤低优先级事件
   * - normal: 不额外过滤
   * - high: 过滤 info 级别
   * - critical: 过滤 info + warning 级别
   */
  private checkLoadFilter(event: UnifiedEvent): FilterResult | null {
    const load = this.currentLoadLevel;

    if (load === 'high' && event.severity === 'info') {
      return {
        filtered: true,
        reason: 'load_filtered',
        layer: 4,
        details: 'Info-level event filtered due to high system load',
      };
    }

    if (load === 'critical') {
      if (event.severity === 'info' || event.severity === 'warning') {
        return {
          filtered: true,
          reason: 'load_filtered',
          layer: 4,
          details: `${event.severity}-level event filtered due to critical system load`,
        };
      }
    }

    return null;
  }

  /** 更新系统负载级别（可由外部调用或内部定期检测） */
  updateLoadLevel(level: 'normal' | 'high' | 'critical'): void {
    if (this.currentLoadLevel !== level) {
      logger.info(`NoiseFilter load level changed: ${this.currentLoadLevel} → ${level}`);
      this.currentLoadLevel = level;
    }
  }

  /** 设置事件队列深度（用于负载判断） */
  setEventQueueDepth(depth: number): void {
    this.eventQueueDepth = depth;
    // 自动调整负载级别
    if (depth > 1000) {
      this.updateLoadLevel('critical');
    } else if (depth > 500) {
      this.updateLoadLevel('high');
    } else {
      this.updateLoadLevel('normal');
    }
  }

  /** 获取当前负载级别 */
  getLoadLevel(): 'normal' | 'high' | 'critical' {
    return this.currentLoadLevel;
  }


  // ══════════════════════════════════════════════════════════
  // 统计发布 (G2.6)
  // ══════════════════════════════════════════════════════════

  /** 发布过滤统计到 EventBus */
  private publishStats(): void {
    if (!this.eventBus) return;

    const filterRate =
      this.stats.totalProcessed > 0
        ? this.stats.totalFiltered / this.stats.totalProcessed
        : 0;

    this.eventBus
      .publish({
        type: 'internal',
        priority: 'low',
        source: 'noise_filter',
        payload: {
          event: 'noise_filter_stats',
          stats: {
            totalProcessed: this.stats.totalProcessed,
            totalFiltered: this.stats.totalFiltered,
            filterRate: Math.round(filterRate * 10000) / 10000,
            layerCounts: {
              layer1_maintenance: this.stats.layerCounts[0],
              layer2_jitter: this.stats.layerCounts[1],
              layer3_correlation: this.stats.layerCounts[2],
              layer4_load: this.stats.layerCounts[3],
            },
            aggregationCount: this.stats.aggregationCount,
          },
        },
      })
      .catch((err) => logger.warn('Failed to publish noise_filter_stats:', err));
  }

  /** 获取过滤统计 */
  getFilterStats(): FilterStats {
    return { ...this.stats, layerCounts: [...this.stats.layerCounts] as [number, number, number, number] };
  }

  /** 重置统计 */
  resetStats(): void {
    this.stats = {
      totalProcessed: 0,
      totalFiltered: 0,
      layerCounts: [0, 0, 0, 0],
      aggregationCount: 0,
    };
  }

  // ══════════════════════════════════════════════════════════
  // 维护窗口管理（保持向后兼容）
  // ══════════════════════════════════════════════════════════

  /** 添加维护窗口 */
  addMaintenanceWindow(window: MaintenanceWindow): void {
    const existingIndex = this.maintenanceWindows.findIndex((w) => w.id === window.id);
    if (existingIndex >= 0) {
      this.maintenanceWindows[existingIndex] = window;
      logger.info(`Maintenance window updated: ${window.name}`);
    } else {
      this.maintenanceWindows.push(window);
      logger.info(`Maintenance window added: ${window.name}`);
    }
  }

  /** 创建维护窗口 */
  async createMaintenanceWindow(input: CreateMaintenanceWindowInput): Promise<MaintenanceWindow> {
    await this.initialize();
    const now = Date.now();
    const window: MaintenanceWindow = {
      id: uuidv4(),
      createdAt: now,
      updatedAt: now,
      ...input,
    };
    this.maintenanceWindows.push(window);
    logger.info(`Created maintenance window: ${window.name} (${window.id})`);
    return window;
  }

  /** 更新维护窗口 */
  async updateMaintenanceWindow(id: string, updates: UpdateMaintenanceWindowInput): Promise<MaintenanceWindow> {
    await this.initialize();
    const index = this.maintenanceWindows.findIndex((w) => w.id === id);
    if (index === -1) throw new Error(`Maintenance window not found: ${id}`);

    const updatedWindow: MaintenanceWindow = {
      ...this.maintenanceWindows[index],
      ...updates,
      updatedAt: Date.now(),
    };
    this.maintenanceWindows[index] = updatedWindow;
    logger.info(`Updated maintenance window: ${updatedWindow.name} (${id})`);
    return updatedWindow;
  }

  /** 移除维护窗口 */
  removeMaintenanceWindow(id: string): void {
    const index = this.maintenanceWindows.findIndex((w) => w.id === id);
    if (index >= 0) {
      const window = this.maintenanceWindows[index];
      this.maintenanceWindows.splice(index, 1);
      logger.info(`Maintenance window removed: ${window.name}`);
    }
  }

  /** 获取所有维护窗口 */
  getMaintenanceWindows(deviceId?: string): MaintenanceWindow[] {
    let windows = this.maintenanceWindows;
    if (deviceId) {
      windows = windows.filter((w) => !w.deviceId || w.deviceId === deviceId);
    }
    return [...windows];
  }

  /** 检查事件是否在维护窗口内 */
  isInMaintenanceWindow(event: UnifiedEvent): boolean {
    const now = event.timestamp || Date.now();
    const eventDeviceId = event.deviceId;
    const eventTenantId = event.tenantId;

    for (const window of this.maintenanceWindows) {
      if (window.tenantId && window.tenantId !== eventTenantId) continue;
      if (window.deviceId && window.deviceId !== eventDeviceId) continue;
      if (!this.isTimeInWindow(now, window)) continue;
      if (this.isResourceAffected(event, window)) return true;
    }
    return false;
  }

  private isTimeInWindow(timestamp: number, window: MaintenanceWindow): boolean {
    if (timestamp >= window.startTime && timestamp <= window.endTime) return true;
    if (window.recurring) return this.isTimeInRecurringWindow(timestamp, window);
    return false;
  }

  private isTimeInRecurringWindow(timestamp: number, window: MaintenanceWindow): boolean {
    if (!window.recurring) return false;

    const date = new Date(timestamp);
    const startDate = new Date(window.startTime);
    const endDate = new Date(window.endTime);

    const currentTimeMinutes = date.getHours() * 60 + date.getMinutes();
    const startTimeMinutes = startDate.getHours() * 60 + startDate.getMinutes();
    const endTimeMinutes = endDate.getHours() * 60 + endDate.getMinutes();

    if (currentTimeMinutes < startTimeMinutes || currentTimeMinutes > endTimeMinutes) return false;

    switch (window.recurring.type) {
      case 'daily':
        return true;
      case 'weekly':
        return window.recurring.dayOfWeek?.includes(date.getDay()) ?? false;
      case 'monthly':
        return window.recurring.dayOfMonth?.includes(date.getDate()) ?? false;
      default:
        return false;
    }
  }

  private isResourceAffected(event: UnifiedEvent, window: MaintenanceWindow): boolean {
    if (!window.resources || window.resources.length === 0) return true;

    const eventResources = this.extractEventResources(event);
    for (const eventResource of eventResources) {
      for (const windowResource of window.resources) {
        if (this.resourceMatches(eventResource, windowResource)) return true;
      }
    }
    return false;
  }

  private extractEventResources(event: UnifiedEvent): string[] {
    const resources: string[] = [];
    if (event.category) resources.push(event.category);
    if (event.metadata?.interfaceName) resources.push(event.metadata.interfaceName as string);
    if (event.alertRuleInfo?.metric) resources.push(event.alertRuleInfo.metric);
    if (event.deviceInfo?.hostname) resources.push(event.deviceInfo.hostname);
    if (event.deviceInfo?.ip) resources.push(event.deviceInfo.ip);
    const interfaceMatch = event.message.match(/interface[:\s]+(\S+)/i);
    if (interfaceMatch) resources.push(interfaceMatch[1]);
    return resources;
  }

  private resourceMatches(eventResource: string, windowResource: string): boolean {
    if (eventResource.toLowerCase() === windowResource.toLowerCase()) return true;
    if (windowResource.includes('*')) {
      const regex = new RegExp('^' + windowResource.replace(/\*/g, '.*') + '$', 'i');
      return regex.test(eventResource);
    }
    return false;
  }


  // ══════════════════════════════════════════════════════════
  // 已知问题管理（保持向后兼容）
  // ══════════════════════════════════════════════════════════

  addKnownIssue(issue: KnownIssue): void {
    const existingIndex = this.knownIssues.findIndex((i) => i.id === issue.id);
    if (existingIndex >= 0) {
      this.knownIssues[existingIndex] = issue;
      logger.info(`Known issue updated: ${issue.description}`);
    } else {
      this.knownIssues.push(issue);
      logger.info(`Known issue added: ${issue.description}`);
    }
  }

  async createKnownIssue(input: CreateKnownIssueInput): Promise<KnownIssue> {
    await this.initialize();
    const now = Date.now();
    const issue: KnownIssue = { id: uuidv4(), createdAt: now, updatedAt: now, ...input };
    this.knownIssues.push(issue);
    logger.info(`Created known issue: ${issue.description} (${issue.id})`);
    return issue;
  }

  async updateKnownIssue(id: string, updates: UpdateKnownIssueInput): Promise<KnownIssue> {
    await this.initialize();
    const index = this.knownIssues.findIndex((i) => i.id === id);
    if (index === -1) throw new Error(`Known issue not found: ${id}`);

    const updatedIssue: KnownIssue = { ...this.knownIssues[index], ...updates, updatedAt: Date.now() };
    this.knownIssues[index] = updatedIssue;
    logger.info(`Updated known issue: ${updatedIssue.description} (${id})`);
    return updatedIssue;
  }

  removeKnownIssue(id: string): void {
    const index = this.knownIssues.findIndex((i) => i.id === id);
    if (index >= 0) {
      const issue = this.knownIssues[index];
      this.knownIssues.splice(index, 1);
      logger.info(`Known issue removed: ${issue.description}`);
    }
  }

  getKnownIssues(): KnownIssue[] {
    return [...this.knownIssues];
  }

  matchesKnownIssue(event: UnifiedEvent): KnownIssue | null {
    const now = Date.now();
    for (const issue of this.knownIssues) {
      if (issue.tenantId && issue.tenantId !== event.tenantId) continue;
      if (issue.deviceId && issue.deviceId !== event.deviceId) continue;
      if (issue.expiresAt && issue.expiresAt < now) continue;

      try {
        const regex = new RegExp(issue.pattern, 'i');
        if (regex.test(event.message) || regex.test(event.category)) return issue;
      } catch {
        if (event.message.toLowerCase().includes(issue.pattern.toLowerCase())) return issue;
      }
    }
    return null;
  }

  // ══════════════════════════════════════════════════════════
  // 反馈管理（保持向后兼容，内存存储）
  // ══════════════════════════════════════════════════════════

  recordFeedback(feedback: Omit<FilterFeedback, 'id' | 'timestamp'>): void {
    this.feedbackStats.total++;
    if (feedback.userFeedback === 'false_positive') {
      this.feedbackStats.falsePositives++;
    } else if (feedback.userFeedback === 'false_negative') {
      this.feedbackStats.falseNegatives++;
    }
    logger.info(`Filter feedback recorded: type=${feedback.userFeedback}`);
  }

  getFeedbackStats(): FilterFeedbackStats {
    return { ...this.feedbackStats };
  }

  // ══════════════════════════════════════════════════════════
  // 工具方法
  // ══════════════════════════════════════════════════════════

  getStats(): {
    maintenanceWindowsCount: number;
    knownIssuesCount: number;
    flappingTrackersCount: number;
    feedbackStats: FilterFeedbackStats;
  } {
    return {
      maintenanceWindowsCount: this.maintenanceWindows.length,
      knownIssuesCount: this.knownIssues.length,
      flappingTrackersCount: this.jitterTrackers.size,
      feedbackStats: this.feedbackStats,
    };
  }

  async clearAll(): Promise<void> {
    this.maintenanceWindows = [];
    this.knownIssues = [];
    this.jitterTrackers.clear();
    this.correlationGroups.clear();
    this.currentLoadLevel = 'normal';
    this.eventQueueDepth = 0;
    this.feedbackStats = { total: 0, falsePositives: 0, falseNegatives: 0 };
    this.resetStats();
    logger.info('NoiseFilter data cleared');
  }

  async reload(): Promise<void> {
    this.initialized = false;
    await this.initialize();
    logger.info('NoiseFilter data reloaded');
  }

  /** 清理过期的跟踪器和关联组 */
  private cleanup(): void {
    const now = Date.now();

    // 清理抖动跟踪器
    const jitterCutoff = now - this.JITTER_WINDOW_MS;
    for (const [key, tracker] of this.jitterTrackers) {
      tracker.timestamps = tracker.timestamps.filter((t) => t >= jitterCutoff);
      if (tracker.timestamps.length === 0) {
        this.jitterTrackers.delete(key);
      }
    }

    // 清理关联组
    const correlationCutoff = now - this.CORRELATION_WINDOW_MS;
    for (const [id, group] of this.correlationGroups) {
      if (group.lastSeen < correlationCutoff) {
        this.correlationGroups.delete(id);
      }
    }
  }
}

// 导出单例实例
export const noiseFilter = new NoiseFilter();
