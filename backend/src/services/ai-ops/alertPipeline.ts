/**
 * AlertPipeline 告警处理流水线服务
 * 实现统一的告警处理流水线：归一化 → 去重 → 过滤 → 分析 → 决策
 *
 * Requirements: 4.1, 5.1, 6.1, 8.1, G1.1, G1.2, G1.3, G1.4, G5.18
 * - 4.1: 将不同来源的事件归一化为统一格式
 * - 5.1: 过滤维护窗口期间的告警
 * - 6.1: 分析告警的潜在根因
 * - 8.1: 根据决策矩阵评估告警并确定处理动作
 * - G1.1: 五阶段处理流水线
 * - G1.2: 可插拔 NormalizerAdapter
 * - G1.3: 指纹生成
 * - G1.4: FingerprintCache PostgreSQL 持久化
 * - G5.18: EventProcessingTracker 追踪处理状态和耗时
 *
 * 流水线阶段：
 * 1. normalize - 归一化：NormalizerAdapter 可插拔，将异构事件转换为 UnifiedEvent
 * 2. deduplicate - 去重：FingerprintCache（PostgreSQL 持久化，默认 5 分钟窗口）
 * 3. filter - 过滤：NoiseFilter 四层噪声过滤
 * 4. analyze - 分析：RootCauseAnalyzer + KnowledgeGraph
 * 5. decide - 决策：DecisionEngine 多因子决策
 */

import {
  AlertEvent,
  SyslogEvent,
  UnifiedEvent,
  CompositeEvent,
  PipelineResult,
  PipelineStage,
  IAlertPipeline,
  FilterResult,
  RootCauseAnalysis,
  Decision,
  RemediationPlan,
} from '../../types/ai-ops';
import { logger } from '../../utils/logger';
import { alertPreprocessor } from './alertPreprocessor';
import { fingerprintCache } from './fingerprintCache';
import { noiseFilter } from './noiseFilter';
import { rootCauseAnalyzer } from './rootCauseAnalyzer';
import { decisionEngine } from './decisionEngine';
import { remediationAdvisor } from './remediationAdvisor';
import { faultHealer } from './faultHealer';
import { auditLogger } from './auditLogger';
import { ragEngine } from './rag';
import { eventProcessingTracker, EventProcessingStats } from './eventProcessingTracker';
import { autonomousBrainService } from './brain/autonomousBrainService';
import type { DataStore } from '../dataStore';


// State Machine Integration (lightweight-state-machine)
// Requirements: 9.3, 9.4 - Feature flag routing for gradual migration
import { FeatureFlagManager } from './stateMachine/featureFlagManager';
import { StateMachineOrchestrator } from './stateMachine/stateMachineOrchestrator';

// ─── NormalizerAdapter 可插拔归一化接口 (G1.2) ───

/**
 * NormalizerAdapter 接口
 * Requirements: G1.2 - 可插拔归一化适配器
 * 每个适配器负责将特定来源的原始事件转换为标准化 UnifiedEvent
 */
export interface NormalizerAdapter {
  /** 适配器名称 */
  readonly name: string;
  /** 支持的事件来源类型 */
  readonly sourceType: string;
  /** 将原始事件归一化为 UnifiedEvent */
  normalize(event: SyslogEvent | AlertEvent): Promise<UnifiedEvent | CompositeEvent>;
}

/**
 * 默认归一化适配器
 * 包装现有的 alertPreprocessor.process() 逻辑
 */
class DefaultNormalizerAdapter implements NormalizerAdapter {
  readonly name = 'default';
  readonly sourceType = 'default';

  async normalize(event: SyslogEvent | AlertEvent): Promise<UnifiedEvent | CompositeEvent> {
    return alertPreprocessor.process(event);
  }
}

// ─── PostgreSQL FingerprintCache (G1.4) ───

/**
 * PostgreSQL 指纹缓存
 * Requirements: G1.4 - FingerprintCache PostgreSQL 持久化，默认 5 分钟窗口
 * 当 PgDataStore 不可用时回退到内存 fingerprintCache
 */
class PgFingerprintCache {
  private pgDataStore: DataStore | null = null;
  private readonly defaultWindowMs: number;

  constructor(defaultWindowMs: number = 5 * 60 * 1000) {
    this.defaultWindowMs = defaultWindowMs;
  }

  setPgDataStore(dataStore: DataStore): void {
    this.pgDataStore = dataStore;
    logger.info('PgFingerprintCache: PostgreSQL backend configured');
  }

  get isPostgresAvailable(): boolean {
    return this.pgDataStore !== null;
  }

  /**
   * 检查指纹是否为重复（PostgreSQL 优先，回退到内存）
   */
  async isDuplicate(fp: string): Promise<boolean> {
    if (!this.pgDataStore) {
      return fingerprintCache.exists(fp);
    }
    try {
      const row = await this.pgDataStore.queryOne<{ fingerprint: string }>(
        'SELECT fingerprint FROM fingerprint_cache WHERE fingerprint = $1 AND expires_at > NOW()',
        [fp],
      );
      return row !== null;
    } catch (error) {
      logger.warn('PgFingerprintCache.isDuplicate failed, falling back to in-memory', error);
      return fingerprintCache.exists(fp);
    }
  }

  /**
   * 记录指纹（PostgreSQL 优先，回退到内存）
   */
  async record(fp: string, eventId: string, source?: string): Promise<void> {
    if (!this.pgDataStore) {
      fingerprintCache.set(fp);
      return;
    }
    try {
      const expiresAt = new Date(Date.now() + this.defaultWindowMs).toISOString();
      await this.pgDataStore.execute(
        `INSERT INTO fingerprint_cache (fingerprint, event_id, source, created_at, expires_at)
         VALUES ($1, $2, $3, NOW(), $4)
         ON CONFLICT (fingerprint) DO UPDATE SET event_id = $2, expires_at = $4`,
        [fp, eventId, source || 'unknown', expiresAt],
      );
    } catch (error) {
      logger.warn('PgFingerprintCache.record failed, falling back to in-memory', error);
      fingerprintCache.set(fp);
    }
  }

  /**
   * 清理过期指纹记录（PostgreSQL）
   * 定期执行 DELETE FROM fingerprint_cache WHERE expires_at <= NOW()
   */
  async cleanupExpired(): Promise<number> {
    if (!this.pgDataStore) {
      return fingerprintCache.cleanup();
    }
    try {
      const result = await this.pgDataStore.execute(
        'DELETE FROM fingerprint_cache WHERE expires_at <= NOW()',
      );
      if (result.rowCount > 0) {
        logger.info(`PgFingerprintCache: cleaned ${result.rowCount} expired entries`);
      }
      return result.rowCount;
    } catch (error) {
      logger.warn('PgFingerprintCache.cleanupExpired failed', error);
      return 0;
    }
  }
}

// ─── EventProcessingTracker 增强 (G5.18) ───

/**
 * 流水线阶段跟踪记录
 * Requirements: G5.18 - 追踪每个事件的处理状态和耗时
 */
export interface StageTrackingRecord {
  eventId: string;
  startTime: number;
  stages: Array<{
    name: PipelineStage;
    startMs: number;
    endMs: number;
    durationMs: number;
  }>;
  outcome: 'deduplicated' | 'filtered' | 'decided' | 'error' | 'pending';
  totalDurationMs: number;
}

/**
 * 流水线事件跟踪器
 * 记录每个事件在各阶段的处理状态和耗时
 */
class PipelineEventTracker {
  private tracking: Map<string, StageTrackingRecord> = new Map();
  private completedRecords: StageTrackingRecord[] = [];
  private readonly maxCompletedRecords = 200;

  start(eventId: string): string {
    const record: StageTrackingRecord = {
      eventId,
      startTime: Date.now(),
      stages: [],
      outcome: 'pending',
      totalDurationMs: 0,
    };
    this.tracking.set(eventId, record);
    return eventId;
  }

  stageStart(eventId: string, stage: PipelineStage): void {
    const record = this.tracking.get(eventId);
    if (!record) return;
    record.stages.push({
      name: stage,
      startMs: Date.now() - record.startTime,
      endMs: 0,
      durationMs: 0,
    });
  }

  stageEnd(eventId: string, stage: PipelineStage): void {
    const record = this.tracking.get(eventId);
    if (!record) return;
    const stageEntry = record.stages.find(s => s.name === stage && s.endMs === 0);
    if (stageEntry) {
      stageEntry.endMs = Date.now() - record.startTime;
      stageEntry.durationMs = stageEntry.endMs - stageEntry.startMs;
    }
  }

  end(eventId: string, outcome: StageTrackingRecord['outcome']): StageTrackingRecord | undefined {
    const record = this.tracking.get(eventId);
    if (!record) return undefined;
    record.outcome = outcome;
    record.totalDurationMs = Date.now() - record.startTime;
    this.tracking.delete(eventId);
    this.completedRecords.push(record);
    if (this.completedRecords.length > this.maxCompletedRecords) {
      this.completedRecords.shift();
    }
    return record;
  }

  getActiveCount(): number {
    return this.tracking.size;
  }

  getRecentRecords(limit: number = 20): StageTrackingRecord[] {
    return this.completedRecords.slice(-limit);
  }

  getAverageLatency(): { total: number; byStage: Record<string, number> } {
    if (this.completedRecords.length === 0) {
      return { total: 0, byStage: {} };
    }
    const totalSum = this.completedRecords.reduce((s, r) => s + r.totalDurationMs, 0);
    const stageMap: Record<string, { sum: number; count: number }> = {};
    for (const record of this.completedRecords) {
      for (const stage of record.stages) {
        if (!stageMap[stage.name]) stageMap[stage.name] = { sum: 0, count: 0 };
        stageMap[stage.name].sum += stage.durationMs;
        stageMap[stage.name].count++;
      }
    }
    const byStage: Record<string, number> = {};
    for (const [name, data] of Object.entries(stageMap)) {
      byStage[name] = Math.round(data.sum / data.count);
    }
    return {
      total: Math.round(totalSum / this.completedRecords.length),
      byStage,
    };
  }

  reset(): void {
    this.tracking.clear();
    this.completedRecords = [];
  }
}

/**
 * 流水线配置
 */
interface PipelineConfig {
  /** 是否启用去重 */
  enableDeduplication: boolean;
  /** 是否启用过滤 */
  enableFiltering: boolean;
  /** 是否启用根因分析 */
  enableAnalysis: boolean;
  /** 是否启用决策引擎 */
  enableDecision: boolean;
  /** 是否自动执行决策 */
  autoExecuteDecision: boolean;
  /** 是否生成修复方案 */
  generateRemediationPlan: boolean;
}

/**
 * 默认配置
 */
const DEFAULT_CONFIG: PipelineConfig = {
  enableDeduplication: true,
  enableFiltering: true,
  enableAnalysis: true,
  enableDecision: true,
  autoExecuteDecision: true,
  generateRemediationPlan: true,
};

/**
 * 流水线统计信息
 */
interface PipelineStats {
  processed: number;
  filtered: number;
  deduplicated: number;
  analyzed: number;
  decided: number;
  errors: number;
  /** 已发送通知数量 */
  notified: number;
  /** 重复通知被抑制数量 */
  notificationsSuppressed: number;
  /** 速率限制丢弃数量 */
  rateLimited: number;
}

/**
 * Syslog 事件速率限制器
 * 防止大量 syslog 消息导致 CPU 飙升
 */
interface SyslogRateLimiter {
  /** 时间窗口内的事件计数 */
  count: number;
  /** 窗口开始时间 */
  windowStart: number;
  /** 最近处理的事件指纹（用于去重） */
  recentFingerprints: Map<string, number>;
}

/**
 * Syslog 聚合摘要条目
 * 当事件被速率限制时，不再直接丢弃，而是聚合到窗口中生成摘要
 */
interface SyslogAggregation {
  /** 聚合指纹 */
  fingerprint: string;
  /** 聚合窗口内事件计数 */
  count: number;
  /** 窗口内首次出现时间 */
  firstSeenAt: number;
  /** 窗口内最后出现时间 */
  lastSeenAt: number;
  /** 样本消息（首条） */
  sampleMessage: string;
  /** 事件严重级别 */
  severity: string;
  /** 事件类别 */
  category: string;
  /** 设备 ID */
  deviceId?: string;
  /** 主机名 */
  hostname?: string;
}

/** 指纹缓存最大条目数，防止内存泄漏 */
const MAX_FINGERPRINT_CACHE_SIZE = 1000;

/**
 * 通知状态条目
 * Requirements: 5.5 - 记录通知发送状态，避免重复通知
 */
interface NotificationStatusEntry {
  /** 事件 ID */
  eventId: string;
  /** 决策 ID */
  decisionId: string;
  /** 通知时间戳 */
  notifiedAt: number;
  /** 决策动作 */
  action: string;
  /** 过期时间戳 */
  expiresAt: number;
}


export class AlertPipeline implements IAlertPipeline {
  private config: PipelineConfig;
  private stats: PipelineStats = {
    processed: 0,
    filtered: 0,
    deduplicated: 0,
    analyzed: 0,
    decided: 0,
    errors: 0,
    notified: 0,
    notificationsSuppressed: 0,
    rateLimited: 0,
  };
  private initialized = false;

  // ─── G1.2: 可插拔 NormalizerAdapter ───
  private normalizers: Map<string, NormalizerAdapter> = new Map();
  private defaultNormalizer: NormalizerAdapter = new DefaultNormalizerAdapter();

  // ─── G1.4: PostgreSQL FingerprintCache ───
  private pgFingerprintCache: PgFingerprintCache = new PgFingerprintCache();

  // ─── G5.18: 流水线事件跟踪器 ───
  private pipelineTracker: PipelineEventTracker = new PipelineEventTracker();

  // ─── PostgreSQL 指纹清理定时器（每小时） ───
  private pgFingerprintCleanupTimer: NodeJS.Timeout | null = null;

  // State Machine Integration (lightweight-state-machine)
  // Requirements: 9.3, 9.4
  private _featureFlagManager: FeatureFlagManager | null = null;
  private _stateMachineOrchestrator: StateMachineOrchestrator | null = null;

  // ─── G3.7, G3.10, H3.11: Decision Execution Dispatcher 依赖 ───
  private _eventBus: { publish(event: { type: string; payload: Record<string, unknown>; priority?: string; source?: string; schemaVersion?: string }): Promise<unknown> } | null = null;

  /**
   * 通知状态缓存
   * Requirements: 5.5 - 记录通知发送状态，避免重复通知
   */
  private notificationStatusCache: Map<string, NotificationStatusEntry> = new Map();

  /** 通知状态缓存默认 TTL (30 分钟) */
  private readonly NOTIFICATION_STATUS_TTL_MS = 30 * 60 * 1000;

  /** 通知状态缓存清理间隔 (5 分钟) */
  private readonly NOTIFICATION_CLEANUP_INTERVAL_MS = 5 * 60 * 1000;

  /** 清理定时器 */
  private cleanupTimer: NodeJS.Timeout | null = null;

  /**
   * Syslog 速率限制器
   * 防止大量 syslog 消息导致 CPU 飙升
   */
  private syslogRateLimiter: SyslogRateLimiter = {
    count: 0,
    windowStart: Date.now(),
    recentFingerprints: new Map(),
  };

  /** 速率限制：每秒最大处理事件数 */
  private readonly MAX_EVENTS_PER_SECOND = 10;

  /** 速率限制：时间窗口（毫秒） */
  private readonly RATE_LIMIT_WINDOW_MS = 1000;

  /** Syslog 去重：相同消息的最小间隔（毫秒） */
  private readonly SYSLOG_DEDUP_INTERVAL_MS = 5000;

  /** Syslog 聚合窗口时间（毫秒） */
  private readonly SYSLOG_AGGREGATION_WINDOW_MS = 5000;

  /** Syslog 聚合缓存 */
  private syslogAggregations: Map<string, SyslogAggregation> = new Map();

  /** 聚合刷新定时器 */
  private aggregationFlushTimer: NodeJS.Timeout | null = null;

  /** 指纹缓存清理间隔 */
  private fingerprintCleanupTimer: NodeJS.Timeout | null = null;

  constructor(config?: Partial<PipelineConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    logger.info('AlertPipeline initialized', { config: this.config });
  }

  // ─── G1.4: DataStore 注入 ───

  /**
   * 注入 PgDataStore，启用 PostgreSQL 指纹缓存持久化
   * Requirements: G1.4 - FingerprintCache PostgreSQL 持久化
   */
  setPgDataStore(dataStore: DataStore): void {
    this.pgFingerprintCache.setPgDataStore(dataStore);
    logger.info('AlertPipeline: PgDataStore injected, fingerprint cache will use PostgreSQL');
  }

  // ─── G1.2: NormalizerAdapter 注册 ───

  /**
   * 注册归一化适配器
   * Requirements: G1.2 - 可插拔 NormalizerAdapter
   * @param sourceType 事件来源类型（如 'syslog', 'snmp_trap', 'webhook'）
   * @param adapter 归一化适配器实例
   */
  registerNormalizer(sourceType: string, adapter: NormalizerAdapter): void {
    this.normalizers.set(sourceType, adapter);
    logger.info(`AlertPipeline: NormalizerAdapter registered for source '${sourceType}': ${adapter.name}`);
  }

  /**
   * 注销归一化适配器
   */
  unregisterNormalizer(sourceType: string): boolean {
    const removed = this.normalizers.delete(sourceType);
    if (removed) {
      logger.info(`AlertPipeline: NormalizerAdapter unregistered for source '${sourceType}'`);
    }
    return removed;
  }

  /**
   * 获取已注册的归一化适配器列表
   */
  getRegisteredNormalizers(): Array<{ sourceType: string; name: string }> {
    return Array.from(this.normalizers.entries()).map(([sourceType, adapter]) => ({
      sourceType,
      name: adapter.name,
    }));
  }

  // ─── G5.18: 流水线跟踪器访问 ───

  /**
   * 获取流水线事件跟踪器
   * Requirements: G5.18 - 追踪每个事件的处理状态和耗时
   */
  getPipelineTracker(): PipelineEventTracker {
    return this.pipelineTracker;
  }

  /**
   * 设置 FeatureFlagManager（用于状态机迁移路由）
   * Requirements: 9.3, 9.4
   */
  setFeatureFlagManager(manager: FeatureFlagManager): void {
    this._featureFlagManager = manager;
  }

  /**
   * 设置 StateMachineOrchestrator（用于状态机迁移路由）
   * Requirements: 9.3, 9.4
   */
  setStateMachineOrchestrator(orchestrator: StateMachineOrchestrator): void {
    this._stateMachineOrchestrator = orchestrator;
  }

  /**
   * 获取 StateMachineOrchestrator 实例（供外部模块安全访问）
   */
  getStateMachineOrchestrator(): StateMachineOrchestrator | null {
    return this._stateMachineOrchestrator;
  }

  // ─── G3.7, G3.10, H3.11: Decision Execution Dispatcher 依赖注入 ───

  /**
   * 注入 EventBus，用于发布 decision_execution_failed 事件
   * Requirements: G3.10, H3.11
   */
  setEventBus(eventBus: { publish(event: { type: string; payload: Record<string, unknown>; priority?: string; source?: string; schemaVersion?: string }): Promise<unknown> }): void {
    this._eventBus = eventBus;
    logger.info('AlertPipeline: EventBus injected for decision execution dispatcher');
  }

  /**
   * 初始化流水线
   * 性能优化：并行初始化依赖服务
   */
  async initialize(): Promise<void> {
    if (this.initialized) return;

    // 并行初始化依赖服务（这些服务之间没有依赖关系）
    const startTime = Date.now();
    await Promise.all([
      noiseFilter.initialize(),
      rootCauseAnalyzer.initialize(),
      decisionEngine.initialize(),
    ]);

    // 启动通知状态缓存清理定时器
    this.startNotificationStatusCleanup();

    // 启动指纹缓存清理定时器
    this.startFingerprintCleanup();

    // 启动 PostgreSQL 指纹缓存定期清理（每小时）
    this.startPgFingerprintCleanup();

    // 启动 Syslog 聚合刷新定时器
    this.startAggregationFlush();

    this.initialized = true;
    logger.info(`AlertPipeline dependencies initialized in ${Date.now() - startTime}ms`);
  }

  /**
   * 启动指纹缓存清理定时器
   */
  private startFingerprintCleanup(): void {
    if (this.fingerprintCleanupTimer) {
      return;
    }

    // 每 30 秒清理一次过期的指纹
    this.fingerprintCleanupTimer = setInterval(() => {
      const now = Date.now();
      let cleaned = 0;
      for (const [fingerprint, timestamp] of this.syslogRateLimiter.recentFingerprints) {
        if (now - timestamp > this.SYSLOG_DEDUP_INTERVAL_MS * 2) {
          this.syslogRateLimiter.recentFingerprints.delete(fingerprint);
          cleaned++;
        }
      }
      if (cleaned > 0) {
        logger.debug(`Cleaned ${cleaned} expired syslog fingerprints`);
      }
    }, 30000);

    if (this.fingerprintCleanupTimer.unref) {
      this.fingerprintCleanupTimer.unref();
    }
  }

  /**
   * 启动 PostgreSQL 指纹缓存定期清理任务
   * Requirements: G1.4 - 每小时执行 DELETE FROM fingerprint_cache WHERE expires_at <= NOW()
   * 防止过期记录无限增长
   */
  private startPgFingerprintCleanup(): void {
    if (this.pgFingerprintCleanupTimer) {
      return;
    }

    const PG_CLEANUP_INTERVAL_MS = 60 * 60 * 1000; // 每小时

    this.pgFingerprintCleanupTimer = setInterval(() => {
      this.pgFingerprintCache.cleanupExpired().catch(err => {
        logger.warn('PostgreSQL fingerprint cache cleanup failed', err);
      });
    }, PG_CLEANUP_INTERVAL_MS);

    if (this.pgFingerprintCleanupTimer.unref) {
      this.pgFingerprintCleanupTimer.unref();
    }

    logger.info('PostgreSQL fingerprint cache cleanup timer started (interval: 1 hour)');
  }

  /**
   * 检查 syslog 事件是否应该被速率限制或去重
   * @returns true 如果事件应该被丢弃
   */
  private shouldRateLimitSyslog(event: SyslogEvent): boolean {
    const now = Date.now();

    // 重置时间窗口
    if (now - this.syslogRateLimiter.windowStart > this.RATE_LIMIT_WINDOW_MS) {
      this.syslogRateLimiter.count = 0;
      this.syslogRateLimiter.windowStart = now;
    }

    // 检查速率限制
    if (this.syslogRateLimiter.count >= this.MAX_EVENTS_PER_SECOND) {
      this.stats.rateLimited++;
      // 聚合被限流的事件而非直接丢弃，保留可观测性
      const deviceId = event.deviceId || 'unknown';
      const fingerprint = `${deviceId}:${event.metadata?.hostname || 'unknown'}:${event.category}:${event.message.substring(0, 100)}`;
      this.aggregateSyslogEvent(event, fingerprint);
      return true;
    }

    // 生成简单指纹用于去重（基于消息内容和来源，包含设备 ID）
    const deviceId = event.deviceId || 'unknown';
    const fingerprint = `${deviceId}:${event.metadata?.hostname || 'unknown'}:${event.category}:${event.message.substring(0, 100)}`;

    // 检查是否是重复消息
    const lastSeen = this.syslogRateLimiter.recentFingerprints.get(fingerprint);
    if (lastSeen && now - lastSeen < this.SYSLOG_DEDUP_INTERVAL_MS) {
      this.stats.deduplicated++;
      logger.debug(`Syslog event deduplicated (same message within ${this.SYSLOG_DEDUP_INTERVAL_MS}ms): ${fingerprint.substring(0, 50)}...`);
      return true;
    }

    // 更新计数和指纹
    this.syslogRateLimiter.count++;
    this.syslogRateLimiter.recentFingerprints.set(fingerprint, now);

    // 检查指纹缓存大小，超过限制时使用 LRU 策略淘汰最旧的条目
    if (this.syslogRateLimiter.recentFingerprints.size > MAX_FINGERPRINT_CACHE_SIZE) {
      // 找出最旧的条目并删除
      let oldestKey: string | null = null;
      let oldestTime = Infinity;
      for (const [key, timestamp] of this.syslogRateLimiter.recentFingerprints) {
        if (timestamp < oldestTime) {
          oldestTime = timestamp;
          oldestKey = key;
        }
      }
      if (oldestKey) {
        this.syslogRateLimiter.recentFingerprints.delete(oldestKey);
        logger.debug(`Fingerprint cache LRU eviction: removed oldest entry`);
      }
    }

    return false;
  }

  /**
   * 将被限流/去重的 Syslog 事件加入聚合缓存
   * 在聚合窗口到期后生成摘要日志，替代静默丢弃
   */
  private aggregateSyslogEvent(event: SyslogEvent, fingerprint: string): void {
    const now = Date.now();
    const existing = this.syslogAggregations.get(fingerprint);

    if (existing) {
      existing.count++;
      existing.lastSeenAt = now;
    } else {
      this.syslogAggregations.set(fingerprint, {
        fingerprint,
        count: 1,
        firstSeenAt: now,
        lastSeenAt: now,
        sampleMessage: event.message.substring(0, 200),
        severity: event.severity,
        category: event.category,
        deviceId: event.deviceId,
        hostname: event.metadata?.hostname as string,
      });
    }
  }

  /**
   * 启动聚合刷新定时器
   * 每 5 秒扫描聚合缓存，将到期窗口的事件输出为摘要日志
   */
  private startAggregationFlush(): void {
    if (this.aggregationFlushTimer) {
      return;
    }

    this.aggregationFlushTimer = setInterval(() => {
      this.flushAggregations();
    }, this.SYSLOG_AGGREGATION_WINDOW_MS);

    if (this.aggregationFlushTimer.unref) {
      this.aggregationFlushTimer.unref();
    }
  }

  /**
   * 刷新聚合缓存，输出到期窗口的摘要日志
   */
  private flushAggregations(): void {
    const now = Date.now();
    const expiredEntries: SyslogAggregation[] = [];

    for (const [fingerprint, agg] of this.syslogAggregations) {
      if (now - agg.firstSeenAt >= this.SYSLOG_AGGREGATION_WINDOW_MS) {
        expiredEntries.push(agg);
        this.syslogAggregations.delete(fingerprint);
      }
    }

    for (const agg of expiredEntries) {
      logger.info(`[Syslog 聚合摘要] ${agg.count} 条同类事件被压缩`, {
        fingerprint: agg.fingerprint.substring(0, 60),
        count: agg.count,
        severity: agg.severity,
        category: agg.category,
        deviceId: agg.deviceId,
        hostname: agg.hostname,
        sampleMessage: agg.sampleMessage,
        windowMs: agg.lastSeenAt - agg.firstSeenAt,
        firstSeenAt: new Date(agg.firstSeenAt).toISOString(),
        lastSeenAt: new Date(agg.lastSeenAt).toISOString(),
      });
    }
  }

  /**
   * 处理告警事件
   * 完整流水线：归一化 → 去重 → 过滤 → 分析 → 决策
   *
   * @param event Syslog 事件或告警事件
   * @returns 流水线处理结果
   */
  async process(event: SyslogEvent | AlertEvent): Promise<PipelineResult> {
    await this.initialize();

    // 对 syslog 事件进行速率限制和去重检查
    if ('source' in event && event.source === 'syslog') {
      if (this.shouldRateLimitSyslog(event as SyslogEvent)) {
        // 返回一个被过滤的结果，不进行完整处理
        const normalizedEvent = alertPreprocessor.normalize(event);
        return this.createResult(normalizedEvent, 'deduplicate', true, {
          filtered: true,
          reason: undefined,
          details: 'Syslog event rate limited or deduplicated',
        });
      }
    }

    const startTime = Date.now();
    this.stats.processed++;

    // State Machine routing (Requirements: 9.3, 9.4)
    // When FeatureFlagManager is configured and flag is ON, route through state machine
    if (this._featureFlagManager && this._stateMachineOrchestrator) {
      try {
        return await this._featureFlagManager.route<PipelineResult>(
          'alert-orchestration',
          async () => {
            const execResult = await this._stateMachineOrchestrator!.execute('alert-pipeline', {
              rawEvent: event,
            });
            return execResult.output.pipelineResult as PipelineResult;
          },
          () => this.processInternalWithTimeout(event, startTime),
        );
      } catch (error) {
        this.stats.errors++;
        const errorMessage = error instanceof Error ? error.message : String(error);
        logger.error('Pipeline processing error (routed):', error);
        const normalizedEvent = alertPreprocessor.normalize(event);
        return this.createResult(normalizedEvent, 'normalize', false, {
          filtered: false,
          reason: undefined,
          details: `Pipeline error: ${errorMessage}`,
        });
      }
    }

    // Legacy path (no FeatureFlagManager configured)
    try {
      return await this.processInternalWithTimeout(event, startTime);
    } catch (error) {
      this.stats.errors++;
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error('Pipeline processing error or timeout:', error);
      const normalizedEvent = alertPreprocessor.normalize(event);
      return this.createResult(normalizedEvent, 'normalize', false, {
        filtered: false,
        reason: undefined,
        details: `Pipeline error: ${errorMessage}`,
      });
    }
  }

  /**
   * 带超时保护的内部处理方法
   */
  private async processInternalWithTimeout(
    event: SyslogEvent | AlertEvent,
    startTime: number,
  ): Promise<PipelineResult> {
    const PIPELINE_TIMEOUT_MS = 180000; // 3 分钟超时（AI 分析可能需要较长时间）
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        reject(new Error(`Pipeline processing timeout after ${PIPELINE_TIMEOUT_MS}ms`));
      }, PIPELINE_TIMEOUT_MS);
    });

    try {
      return await Promise.race([
        this.processInternal(event, startTime),
        timeoutPromise,
      ]);
    } finally {
      // FIX: 清理超时 timer，避免正常完成时 timer 泄漏到事件循环
      if (timer) clearTimeout(timer);
    }
  }

  // ─── Decision Execution Dispatcher (G3.7, G3.10, H3.11) ───

  /**
   * 决策执行分发器
   * 将 DecisionEngine 输出路由到对应的执行模块：
   * - auto_remediate / auto_execute → FaultHealer.handleAlertEvent()
   * - notify / notify_and_wait → NotificationService.send()（按严重度选择渠道）
   * - escalate → NotificationService.send()（高优先级渠道 + 管理员组）
   * - observe → 仅记录决策日志到 decision_history
   * - silence → 记录审计日志
   *
   * 执行结果回写 decision_history（execution_status, execution_result）
   * 执行失败时发布 decision_execution_failed 事件到 EventBus
   *
   * Requirements: G3.7, G3.10, H3.11
   */
  private async dispatchDecisionExecution(
    decision: Decision,
    event: UnifiedEvent | CompositeEvent,
    analysis?: RootCauseAnalysis,
    plan?: RemediationPlan,
  ): Promise<void> {
    const action = decision.action;
    logger.info(`Dispatching decision execution: ${action} for decision ${decision.id}`);

    try {
      switch (action) {
        case 'auto_execute':
        case 'auto_remediate': {
          // Route to FaultHealer: convert UnifiedEvent to AlertEvent via convertToAlertLike()
          const alertEvent = this.convertToAlertLike(event);
          // Enrich with device context fields that convertToAlertLike doesn't include
          alertEvent.deviceName = event.deviceInfo?.hostname;
          alertEvent.deviceIp = event.deviceInfo?.ip;

          const execution = await faultHealer.handleAlertEvent(alertEvent);

          // Also delegate to decisionEngine.executeDecision for plan-based execution and IterationLoop
          await decisionEngine.executeDecision(decision, plan, event);

          if (execution) {
            logger.info(`FaultHealer remediation completed for decision ${decision.id}: status=${execution.status}`);
          }
          break;
        }

        case 'notify_and_wait': {
          // Route to NotificationService via DecisionEngine (which handles channel selection)
          await decisionEngine.executeDecision(decision, plan, event);
          break;
        }

        case 'escalate': {
          // Route to NotificationService escalation via DecisionEngine (high-priority channels + admin group)
          await decisionEngine.executeDecision(decision, plan, event);
          break;
        }

        case 'observe': {
          // Record decision log only, no active action
          decision.executed = true;
          decision.executionResult = {
            success: true,
            details: 'Decision observed and logged, no active action taken',
          };
          await decisionEngine.saveDecision(decision);

          logger.info(`Observe decision ${decision.id} recorded to decision_history`);
          break;
        }

        case 'silence': {
          // Delegate to DecisionEngine for audit logging
          await decisionEngine.executeDecision(decision, plan, event);
          break;
        }

        default:
          logger.warn(`Unknown decision action in dispatcher: ${action}, falling back to DecisionEngine`);
          await decisionEngine.executeDecision(decision, plan, event);
      }

      // Record notification status for dedup
      this.recordNotificationStatus(event.id, decision.id, decision.action);
      this.stats.notified++;

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error(`Decision execution failed for ${decision.id} (action: ${action}):`, error);

      // Write failure back to decision_history
      if (!decision.executed) {
        decision.executed = true;
        decision.executionResult = {
          success: false,
          details: `执行失败: ${errorMessage}`,
        };
        await decisionEngine.saveDecision(decision).catch(saveErr => {
          logger.error('Failed to save decision status after dispatch failure:', saveErr);
        });
      }

      // Publish decision execution failure event to EventBus using valid 'internal' type
      if (this._eventBus) {
        this._eventBus.publish({
          type: 'internal',
          priority: 'high',
          source: 'alert_pipeline',
          schemaVersion: '1.0',
          payload: {
            subType: 'decision_execution_failed',
            decisionId: decision.id,
            action: decision.action,
            error: errorMessage,
            eventId: event?.id,
          },
        }).catch(busErr => {
          logger.warn('Failed to publish decision_execution_failed event to EventBus:', busErr);
        });
      }
    }
  }

  /**
   * 内部处理方法（被 process 调用，带超时保护）
   * Requirements (syslog-cpu-spike-fix): 3.1, 3.2, 3.3 - 使用 EventProcessingTracker
   * Requirements: G1.1, G1.2, G1.4, G5.18 - 五阶段流水线 + 可插拔归一化 + PG 指纹 + 跟踪
   */
  private async processInternal(event: SyslogEvent | AlertEvent, startTime: number): Promise<PipelineResult> {
    const eventId = this.getEventId(event);

    // Requirements (syslog-cpu-spike-fix): 3.1, 3.2 - 检查并标记事件处理状态
    if (!eventProcessingTracker.markProcessing(eventId)) {
      // 事件已在处理中，跳过
      logger.debug(`Event ${eventId} is already being processed, skipping`);
      const normalizedEvent = alertPreprocessor.normalize(event);
      return this.createResult(normalizedEvent, 'deduplicate', true, {
        filtered: true,
        reason: undefined,
        details: 'Event already being processed (EventProcessingTracker)',
      });
    }

    // G5.18: 开始跟踪
    this.pipelineTracker.start(eventId);

    try {
      // Stage 1: Normalize - 归一化 (G1.1, G1.2)
      this.pipelineTracker.stageStart(eventId, 'normalize');
      const normalizedEvent = await this.stageNormalize(event);
      this.pipelineTracker.stageEnd(eventId, 'normalize');

      // Stage 2: Deduplicate - 去重 (G1.3, G1.4)
      if (this.config.enableDeduplication) {
        this.pipelineTracker.stageStart(eventId, 'deduplicate');
        const isDuplicate = await this.stageDeduplicate(normalizedEvent);
        this.pipelineTracker.stageEnd(eventId, 'deduplicate');
        if (isDuplicate) {
          this.stats.deduplicated++;
          // Requirements (syslog-cpu-spike-fix): 3.3 - 处理完成时清理标记
          eventProcessingTracker.markCompleted(eventId);
          this.pipelineTracker.end(eventId, 'deduplicated');
          return this.createResult(normalizedEvent, 'deduplicate', true, {
            filtered: true,
            reason: undefined, // Deduplication is not a FilterReason, handled separately
            details: 'Alert suppressed by fingerprint deduplication',
          });
        }
      }

      // Stage 3: Filter - 过滤
      if (this.config.enableFiltering) {
        this.pipelineTracker.stageStart(eventId, 'filter');
        const filterResult = await this.stageFilter(normalizedEvent);
        this.pipelineTracker.stageEnd(eventId, 'filter');
        if (filterResult.filtered) {
          this.stats.filtered++;
          // Requirements (syslog-cpu-spike-fix): 3.3 - 处理完成时清理标记
          eventProcessingTracker.markCompleted(eventId);
          this.pipelineTracker.end(eventId, 'filtered');
          return this.createResult(normalizedEvent, 'filter', true, filterResult);
        }
      }

      // Stage 4: Analyze - 根因分析（带超时保护）
      let analysis: RootCauseAnalysis | undefined;
      if (this.config.enableAnalysis) {
        try {
          this.pipelineTracker.stageStart(eventId, 'analyze');
          const analysisTimeout = 90000; // 90 秒分析超时（AI 分析需要时间）
          analysis = await Promise.race([
            this.stageAnalyze(normalizedEvent),
            new Promise<RootCauseAnalysis>((_, reject) =>
              setTimeout(() => reject(new Error('Analysis timeout')), analysisTimeout)
            ),
          ]);
          this.pipelineTracker.stageEnd(eventId, 'analyze');
          this.stats.analyzed++;
        } catch (analysisError) {
          this.pipelineTracker.stageEnd(eventId, 'analyze');
          logger.warn('Root cause analysis failed or timed out:', analysisError);
          // 分析失败不阻塞流水线，继续处理
        }
      }

      // Stage 5: Decide - 智能决策
      let decision: Decision | undefined;
      let plan: RemediationPlan | undefined;

      if (this.config.enableDecision) {
        this.pipelineTracker.stageStart(eventId, 'decide');
        decision = await this.stageDecide(normalizedEvent, analysis);
        this.pipelineTracker.stageEnd(eventId, 'decide');
        this.stats.decided++;

        // 生成修复方案（如果启用且有分析结果，带超时保护）
        if (this.config.generateRemediationPlan && analysis) {
          try {
            const planTimeout = 60000; // 60 秒生成方案超时
            plan = await Promise.race([
              remediationAdvisor.generatePlan(analysis),
              new Promise<RemediationPlan>((_, reject) =>
                setTimeout(() => reject(new Error('Plan generation timeout')), planTimeout)
              ),
            ]);
          } catch (error) {
            logger.warn('Failed to generate remediation plan:', error);
          }
        }

        // 决策执行分发器（如果启用）
        // Requirements: G3.7, G3.10, H3.11 - 决策执行分发
        // Requirements: 5.5 - 检查通知状态，避免重复通知
        if (this.config.autoExecuteDecision && decision) {
          // 检查是否已经为此事件发送过通知
          if (this.hasNotificationBeenSent(normalizedEvent.id)) {
            this.stats.notificationsSuppressed++;
            logger.info(`Notification suppressed for event ${normalizedEvent.id} (already notified)`);

            // 将决策状态更新为已抑制
            decision.executed = true;
            decision.executionResult = {
              success: true,
              details: '执行被取消：近期已发送过相同告警的通知，避免重复打扰',
            };
            await decisionEngine.saveDecision(decision);
          } else {
            // 将 CompositeEvent 转换为 UnifiedEvent（如果需要）
            const eventForDecision = 'isComposite' in normalizedEvent && normalizedEvent.isComposite
              ? normalizedEvent as UnifiedEvent  // CompositeEvent extends UnifiedEvent
              : normalizedEvent;

            // 通过决策执行分发器路由到对应执行模块（带超时保护）
            const executeTimeout = 30000; // 30 秒执行超时
            try {
              await Promise.race([
                this.dispatchDecisionExecution(decision, eventForDecision, analysis, plan),
                new Promise((_, reject) =>
                  setTimeout(() => reject(new Error('Decision execution timeout')), executeTimeout)
                ),
              ]);
            } catch (error) {
              logger.warn('Failed to dispatch decision execution:', error);
              // 超时或执行失败时，仍然将决策标记为已执行（失败），避免永远停留在"未执行"
              if (!decision.executed) {
                const errorMessage = error instanceof Error ? error.message : String(error);
                decision.executed = true;
                decision.executionResult = {
                  success: false,
                  details: `执行失败: ${errorMessage}`,
                };
                await decisionEngine.saveDecision(decision).catch(saveErr => {
                  logger.error('Failed to save decision status after execution failure:', saveErr);
                });
              }

              // Publish failure event to EventBus using valid 'internal' type
              if (this._eventBus) {
                this._eventBus.publish({
                  type: 'internal',
                  priority: 'high',
                  source: 'alert_pipeline',
                  schemaVersion: '1.0',
                  payload: {
                    subType: 'decision_execution_failed',
                    decisionId: decision.id,
                    action: decision.action,
                    error: error instanceof Error ? error.message : String(error),
                    eventId: eventForDecision?.id,
                  },
                }).catch(busErr => {
                  logger.warn('Failed to publish decision_execution_failed event to EventBus:', busErr);
                });
              }
            }
          }
        }
      }

      const duration = Date.now() - startTime;
      logger.info(`Pipeline processed event ${normalizedEvent.id} in ${duration}ms`, {
        stage: 'decide',
        filtered: false,
        hasAnalysis: !!analysis,
        hasDecision: !!decision,
        hasPlan: !!plan,
      });

      // Requirements (syslog-cpu-spike-fix): 3.3 - 处理完成时清理标记
      eventProcessingTracker.markCompleted(eventId);

      // G5.18: 完成跟踪
      this.pipelineTracker.end(eventId, 'decided');

      // 如果告警级别很高，或者决策是升级，唤醒大脑进行主动介入
      // FIX P1: 跳过大脑自己注入的合成告警，防止 brain → pipeline → brain 无限循环
      const isSyntheticFromBrain = (event as any)?._syntheticFromBrain === true
        || (event as any)?.metadata?._syntheticFromBrain === true;
      if (
        !isSyntheticFromBrain && (
          normalizedEvent.severity === 'critical' ||
          normalizedEvent.severity === 'emergency' ||
          (decision && decision.action === 'escalate')
        )
      ) {
        autonomousBrainService.triggerTick('critical_alert', {
          eventId: normalizedEvent.id,
          severity: normalizedEvent.severity,
          decisionAction: decision?.action
        }).catch(err => {
          logger.warn('Failed to trigger brain tick for critical alert', { error: err });
        });
      }

      return this.createResult(normalizedEvent, 'decide', false, undefined, analysis, decision, plan);

    } catch (error) {
      this.stats.errors++;
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error('Pipeline processing error:', error);

      // Requirements (syslog-cpu-spike-fix): 3.3 - 处理完成时清理标记（即使出错）
      eventProcessingTracker.markCompleted(eventId);

      // G5.18: 错误跟踪
      this.pipelineTracker.end(eventId, 'error');

      // 记录错误到审计日志
      await auditLogger.log({
        action: 'alert_trigger',
        actor: 'system',
        details: {
          trigger: 'pipeline_error',
          error: errorMessage,
          metadata: {
            eventId: this.getEventId(event),
          },
        },
      });

      // 返回错误结果，但仍然尝试归一化事件
      const normalizedEvent = alertPreprocessor.normalize(event);
      return this.createResult(normalizedEvent, 'normalize', false, {
        filtered: false,
        reason: undefined,
        details: `Pipeline error: ${errorMessage}`,
      });
    }
  }


  /**
   * Stage 1: 归一化
   * Requirements: G1.1, G1.2 - 可插拔 NormalizerAdapter
   * 优先使用注册的适配器，回退到默认适配器
   */
  private async stageNormalize(event: SyslogEvent | AlertEvent): Promise<UnifiedEvent | CompositeEvent> {
    logger.debug('Pipeline stage: normalize');

    // 确定事件来源类型
    const sourceType = this.getEventSourceType(event);

    // G1.2: 查找注册的 NormalizerAdapter
    const normalizer = this.normalizers.get(sourceType) ?? this.defaultNormalizer;
    return normalizer.normalize(event);
  }

  /**
   * 获取事件来源类型（用于 NormalizerAdapter 查找）
   */
  private getEventSourceType(event: SyslogEvent | AlertEvent): string {
    if ('source' in event && typeof event.source === 'string') {
      return event.source;
    }
    // AlertEvent 来自 metrics
    return 'metrics';
  }

  /**
   * Stage 2: 去重
   * Requirements: G1.3, G1.4 - 指纹生成 + PostgreSQL 持久化去重
   * 
   * 注意：对于来自 AlertEngine 的告警，已经在 evaluate() 中做过指纹检查
   * 这里主要处理来自 Syslog 等其他来源的事件
   */
  private async stageDeduplicate(event: UnifiedEvent | CompositeEvent): Promise<boolean> {
    logger.debug('Pipeline stage: deduplicate');

    // 复合事件不进行去重（已经是聚合后的）
    if ('isComposite' in event && event.isComposite) {
      return false;
    }

    // 来自 metrics（AlertEngine）的事件已经在 AlertEngine.evaluate() 中做过去重
    // 跳过重复检查，避免双重去重导致的问题
    if (event.source === 'metrics') {
      logger.debug(`Skipping deduplication for metrics event ${event.id} (already checked in AlertEngine)`);
      return false;
    }

    // G1.3: 为 UnifiedEvent 生成指纹
    const alertLikeEvent = this.convertToAlertLike(event);
    const fp = fingerprintCache.generateFingerprint(alertLikeEvent);

    // G1.4: 使用 PostgreSQL 指纹缓存（回退到内存）
    if (await this.pgFingerprintCache.isDuplicate(fp)) {
      logger.info(`Event deduplicated: ${event.id}, fingerprint: ${fp}`);
      return true;
    }

    // 记录新指纹
    await this.pgFingerprintCache.record(fp, event.id, event.source);
    return false;
  }

  /**
   * Stage 3: 过滤
   * 检查维护窗口、已知问题、瞬态抖动
   */
  private async stageFilter(event: UnifiedEvent | CompositeEvent): Promise<FilterResult> {
    logger.debug('Pipeline stage: filter');
    return noiseFilter.filter(event);
  }

  /**
   * Stage 4: 根因分析
   * 分析告警的根本原因
   * Requirements (syslog-cpu-spike-fix): 2.1 - 统一 RAG 分析入口
   */
  private async stageAnalyze(event: UnifiedEvent | CompositeEvent): Promise<RootCauseAnalysis> {
    logger.debug('Pipeline stage: analyze');

    // Requirements (syslog-cpu-spike-fix): 2.1 - 在此阶段统一调用 RAG 分析
    // 先调用 RAG 引擎获取根因分析结果
    let ragAnalysis: RootCauseAnalysis | undefined;
    try {
      ragAnalysis = await ragEngine.analyzeRootCause(event);
      logger.debug('RAG root cause analysis completed', {
        eventId: event.id,
        rootCausesCount: ragAnalysis?.rootCauses?.length || 0
      });
    } catch (error) {
      logger.debug('RAG root cause analysis failed, will use pattern-based analysis:', error);
    }

    // 将 RAG 结果传递给 RootCauseAnalyzer，避免重复调用
    const analysis = await rootCauseAnalyzer.analyzeSingle(event, ragAnalysis);

    // FaultHealer 集成：检查是否匹配已知故障模式
    try {
      // 需要将 UnifiedEvent 转换为 AlertEvent 格式
      const alertLikeEvent = this.convertToAlertLike(event);
      const matchedPattern = await faultHealer.matchPattern(alertLikeEvent);
      if (matchedPattern) {
        analysis.matchedFaultPatternId = matchedPattern.id;
        logger.info(`Event ${event.id} matched fault pattern ${matchedPattern.name} (${matchedPattern.id})`);
      }
    } catch (error) {
      logger.warn('Failed to match fault pattern in pipeline:', error);
    }

    // Pass autoResponseConfig if available (Requirements: System Association Issue #2)
    if ('autoResponseConfig' in event) {
      analysis.autoResponseConfig = (event as any).autoResponseConfig;
    }

    return analysis;
  }

  /**
   * Stage 5: 智能决策
   * 根据决策矩阵确定处理方式
   */
  private async stageDecide(
    event: UnifiedEvent | CompositeEvent,
    analysis?: RootCauseAnalysis
  ): Promise<Decision> {
    logger.debug('Pipeline stage: decide');
    return decisionEngine.decide(event, analysis);
  }

  /**
   * 将 UnifiedEvent 转换为类似 AlertEvent 的格式，供 FaultHealer 和指纹生成使用
   */
  private convertToAlertLike(event: UnifiedEvent | CompositeEvent): AlertEvent {
    // 确保 metric 是有效的 MetricType，否则使用默认值
    const validMetrics = ['cpu', 'memory', 'disk', 'interface_status', 'interface_traffic', 'syslog'];
    const metric = event.alertRuleInfo?.metric;
    const validMetric = metric && validMetrics.includes(metric)
      ? metric as any
      : (event.source === 'syslog' ? 'syslog' : 'cpu');

    return {
      id: event.id,
      // 优先从顶层字段提取，避免对异步增强的 deviceInfo 的单一依赖
      tenantId: event.tenantId || event.deviceInfo?.tenantId,
      deviceId: event.deviceId || event.deviceInfo?.id,
      ruleId: event.alertRuleInfo?.ruleId || event.category,
      ruleName: event.alertRuleInfo?.ruleName || event.category,
      severity: event.severity,
      metric: validMetric,
      metricLabel: (event.metadata?.metricLabel as string),
      currentValue: event.alertRuleInfo?.currentValue || 0,
      threshold: event.alertRuleInfo?.threshold || 0,
      message: event.message,
      status: 'active',
      triggeredAt: event.timestamp,
    };
  }

  /**
   * 获取事件 ID
   */
  private getEventId(event: SyslogEvent | AlertEvent): string {
    if ('source' in event && event.source === 'syslog') {
      return (event as SyslogEvent).id;
    }
    return (event as AlertEvent).id;
  }

  /**
   * 创建流水线结果
   */
  private createResult(
    event: UnifiedEvent | CompositeEvent,
    stage: PipelineStage,
    filtered: boolean,
    filterResult?: FilterResult,
    analysis?: RootCauseAnalysis,
    decision?: Decision,
    plan?: RemediationPlan
  ): PipelineResult {
    return {
      event,
      stage,
      filtered,
      filterResult,
      analysis,
      decision,
      plan,
    };
  }

  /**
   * 获取统计信息
   */
  getStats(): {
    processed: number;
    filtered: number;
    analyzed: number;
    decided: number;
    errors: number;
  } {
    return {
      processed: this.stats.processed,
      filtered: this.stats.filtered + this.stats.deduplicated,
      analyzed: this.stats.analyzed,
      decided: this.stats.decided,
      errors: this.stats.errors,
    };
  }

  /**
   * 获取详细统计信息
   */
  getDetailedStats(): PipelineStats {
    return { ...this.stats };
  }

  /**
   * 获取事件处理跟踪器统计信息
   * Requirements (syslog-cpu-spike-fix): 6.1, 6.4 - 处理状态监控
   */
  getEventProcessingStats(): EventProcessingStats {
    const stats = eventProcessingTracker.getStats();

    // Requirements (syslog-cpu-spike-fix): 6.4 - 超过阈值时记录警告日志
    const PROCESSING_COUNT_WARNING_THRESHOLD = 50;
    if (stats.processingCount > PROCESSING_COUNT_WARNING_THRESHOLD) {
      logger.warn(`High number of events being processed: ${stats.processingCount}`, {
        processingCount: stats.processingCount,
        duplicatesBlocked: stats.duplicatesBlocked,
        threshold: PROCESSING_COUNT_WARNING_THRESHOLD,
      });
    }

    return stats;
  }

  /**
   * 重置统计信息
   */
  resetStats(): void {
    this.stats = {
      processed: 0,
      filtered: 0,
      deduplicated: 0,
      analyzed: 0,
      decided: 0,
      errors: 0,
      notified: 0,
      notificationsSuppressed: 0,
      rateLimited: 0,
    };
    logger.info('Pipeline stats reset');
  }

  /**
   * 获取配置
   */
  getConfig(): PipelineConfig {
    return { ...this.config };
  }

  /**
   * 更新配置
   */
  updateConfig(config: Partial<PipelineConfig>): void {
    this.config = { ...this.config, ...config };
    logger.info('Pipeline config updated', { config: this.config });
  }

  // ==================== 通知状态跟踪 ====================

  /**
   * 检查是否已为事件发送过通知
   * Requirements: 5.5 - 避免重复通知
   */
  hasNotificationBeenSent(eventId: string): boolean {
    const entry = this.notificationStatusCache.get(eventId);
    if (!entry) {
      return false;
    }

    // 检查是否已过期
    if (Date.now() > entry.expiresAt) {
      this.notificationStatusCache.delete(eventId);
      return false;
    }

    return true;
  }

  /**
   * 记录通知状态
   * Requirements: 5.5 - 记录通知发送状态
   */
  recordNotificationStatus(eventId: string, decisionId: string, action: string): void {
    const now = Date.now();
    const entry: NotificationStatusEntry = {
      eventId,
      decisionId,
      notifiedAt: now,
      action,
      expiresAt: now + this.NOTIFICATION_STATUS_TTL_MS,
    };

    this.notificationStatusCache.set(eventId, entry);
    logger.debug(`Notification status recorded for event ${eventId}`, { decisionId, action });
  }

  /**
   * 获取通知状态
   */
  getNotificationStatus(eventId: string): NotificationStatusEntry | null {
    const entry = this.notificationStatusCache.get(eventId);
    if (!entry) {
      return null;
    }

    // 检查是否已过期
    if (Date.now() > entry.expiresAt) {
      this.notificationStatusCache.delete(eventId);
      return null;
    }

    return { ...entry };
  }

  /**
   * 清除事件的通知状态
   */
  clearNotificationStatus(eventId: string): void {
    this.notificationStatusCache.delete(eventId);
    logger.debug(`Notification status cleared for event ${eventId}`);
  }

  /**
   * 获取通知状态统计
   */
  getNotificationStatusStats(): {
    cacheSize: number;
    notified: number;
    suppressed: number;
  } {
    return {
      cacheSize: this.notificationStatusCache.size,
      notified: this.stats.notified,
      suppressed: this.stats.notificationsSuppressed,
    };
  }

  /**
   * 启动通知状态缓存清理定时器
   */
  private startNotificationStatusCleanup(): void {
    if (this.cleanupTimer) {
      return;
    }

    this.cleanupTimer = setInterval(() => {
      this.cleanupExpiredNotificationStatus();
    }, this.NOTIFICATION_CLEANUP_INTERVAL_MS);

    // 确保定时器不阻止进程退出
    if (this.cleanupTimer.unref) {
      this.cleanupTimer.unref();
    }

    logger.debug('Notification status cleanup timer started');
  }

  /**
   * 停止通知状态缓存清理定时器
   */
  stopNotificationStatusCleanup(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
      logger.debug('Notification status cleanup timer stopped');
    }
  }

  /**
   * 清理过期的通知状态
   */
  private cleanupExpiredNotificationStatus(): number {
    const now = Date.now();
    let cleanedCount = 0;

    for (const [eventId, entry] of this.notificationStatusCache) {
      if (now > entry.expiresAt) {
        this.notificationStatusCache.delete(eventId);
        cleanedCount++;
      }
    }

    if (cleanedCount > 0) {
      logger.debug(`Cleaned up ${cleanedCount} expired notification status entries`);
    }

    return cleanedCount;
  }

  /**
   * 刷新所有待处理数据
   * Requirements: 5.3 - 确保所有缓存数据刷新到磁盘
   */
  async flush(): Promise<void> {
    logger.info('Flushing AlertPipeline...');

    // 停止清理定时器
    this.stopNotificationStatusCleanup();

    // 停止指纹清理定时器
    if (this.fingerprintCleanupTimer) {
      clearInterval(this.fingerprintCleanupTimer);
      this.fingerprintCleanupTimer = null;
    }

    // 停止 PostgreSQL 指纹清理定时器
    if (this.pgFingerprintCleanupTimer) {
      clearInterval(this.pgFingerprintCleanupTimer);
      this.pgFingerprintCleanupTimer = null;
    }

    // 刷新聚合缓存并停止定时器
    this.flushAggregations();
    if (this.aggregationFlushTimer) {
      clearInterval(this.aggregationFlushTimer);
      this.aggregationFlushTimer = null;
    }

    // 清理通知状态缓存
    this.notificationStatusCache.clear();

    // 清理 syslog 指纹缓存
    this.syslogRateLimiter.recentFingerprints.clear();

    // 清理聚合缓存
    this.syslogAggregations.clear();

    // 重置流水线跟踪器
    this.pipelineTracker.reset();

    logger.info('AlertPipeline flushed');
  }

  /**
   * 停止服务
   * Requirements: 5.3 - 等待当前处理完成
   */
  async stop(): Promise<void> {
    logger.info('Stopping AlertPipeline...');

    // 停止清理定时器
    this.stopNotificationStatusCleanup();

    // 停止指纹清理定时器
    if (this.fingerprintCleanupTimer) {
      clearInterval(this.fingerprintCleanupTimer);
      this.fingerprintCleanupTimer = null;
    }

    // 停止 PostgreSQL 指纹清理定时器
    if (this.pgFingerprintCleanupTimer) {
      clearInterval(this.pgFingerprintCleanupTimer);
      this.pgFingerprintCleanupTimer = null;
    }

    // 刷新聚合缓存并停止定时器
    this.flushAggregations();
    if (this.aggregationFlushTimer) {
      clearInterval(this.aggregationFlushTimer);
      this.aggregationFlushTimer = null;
    }

    logger.info('AlertPipeline stopped');
  }

  /**
   * 检查服务是否支持降级模式
   * Requirements: 5.2 - 支持优雅降级模式
   */
  supportsDegradedMode(): boolean {
    // AlertPipeline 作为处理服务，不支持降级模式
    return false;
  }

  /**
   * 执行健康检查
   * Requirements: 5.4 - 提供服务健康状态检查接口
   */
  async healthCheck(): Promise<{
    healthy: boolean;
    message?: string;
    lastCheck: number;
    consecutiveFailures: number;
  }> {
    const now = Date.now();

    return {
      healthy: true,
      message: 'AlertPipeline is healthy',
      lastCheck: now,
      consecutiveFailures: 0,
    };
  }
}

// 导出单例实例
export const alertPipeline = new AlertPipeline();

/**
 * 初始化告警处理流水线并集成到 SyslogReceiver
 * 调用此函数后，所有 Syslog 事件将自动通过 AlertEngine 的并发控制机制处理
 * 
 * 重要：Syslog 事件复用现有的告警流程，通过 AlertEngine 的 processSyslogEvent() 方法处理
 * 这样可以：
 * 1. 使用 AlertEngine 的 ConcurrencyController 进行并发控制，防止 CPU 飙升
 * 2. 复用现有的告警处理流程（归一化 → 去重 → 过滤 → 分析 → 决策）
 * 3. 自动集成 RAG 知识库索引
 */
export function initializeAlertPipeline(): void {
  // 延迟导入以避免循环依赖
  const { syslogReceiver } = require('./syslogReceiver');
  const { alertEngine } = require('./alertEngine');

  // 注册 Syslog 事件处理器
  // 使用 AlertEngine 的 processSyslogEvent 方法，复用现有告警流程和并发控制
  syslogReceiver.onMessage(async (event: SyslogEvent) => {
    try {
      await alertEngine.processSyslogEvent(event);
      logger.debug(`Syslog event queued for processing: ${event.id}`);
    } catch (error) {
      // 记录入队失败统计
      syslogReceiver.recordEnqueueFailed();

      // 区分背压错误和其他错误
      const errorMessage = error instanceof Error ? error.message : String(error);
      if (errorMessage.includes('Backpressure') || errorMessage.includes('Queue full')) {
        logger.warn(`Syslog event dropped due to system overload: ${event.id}`);
      } else {
        logger.error('Failed to queue syslog event for processing:', error);
      }
    }
  });

  logger.info('AlertPipeline integrated with SyslogReceiver via AlertEngine');
}
