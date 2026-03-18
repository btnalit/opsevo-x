/**
 * AlertEngine 告警引擎
 * 负责告警规则管理、告警评估、告警触发和自动响应
 *
 * Requirements: 2.1-2.8, 3.1-3.12
 * - 2.1: 支持创建、编辑、删除和启用/禁用告警规则
 * - 2.2: 要求指定规则名称、指标类型、条件运算符和阈值
 * - 2.3: 支持条件运算符：gt, lt, eq, ne, gte, lte
 * - 2.4: 支持配置告警持续时间阈值
 * - 2.5: 支持配置告警冷却时间
 * - 2.6: 支持配置多个通知渠道
 * - 2.7: 支持配置告警严重级别
 * - 2.8: 显示规则状态和最近触发时间
 * - 3.1: 指标满足条件时触发告警
 * - 3.2: 调用 AI 服务分析异常原因
 * - 3.3: 告警通知中包含 AI 分析结果
 * - 3.4: 通过配置的通知渠道发送告警
 * - 3.5-3.7: 支持 Web Push、Webhook、邮件通知
 * - 3.8: 支持自动响应脚本执行
 * - 3.9-3.10: 记录执行前后状态到审计日志
 * - 3.11: 执行失败时发送通知
 * - 3.12: 告警恢复时发送恢复通知
 */

import fs from 'fs/promises';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import {
  AlertRule,
  AlertEvent,
  AlertEventSource,
  SyslogMetadata,
  CreateAlertRuleInput,
  UpdateAlertRuleInput,
  IAlertEngine,
  SystemMetrics,
  InterfaceMetrics,
  AlertOperator,
  MetricType,
  AlertSeverity,
  InterfaceStatusTarget,
  UnifiedEvent,
  CompositeEvent,
  SyslogEvent,
} from '../../types/ai-ops';
import { logger } from '../../utils/logger';
import { auditLogger } from './auditLogger';
import { notificationService } from './notificationService';
import { serviceRegistry } from '../serviceRegistry';
import type { DeviceManager } from '../device/deviceManager';
import { metricsCollector } from './metricsCollector';
import { fingerprintCache } from './fingerprintCache';
import { alertPreprocessor } from './alertPreprocessor';
import { alertPipeline } from './alertPipeline';
import { knowledgeBase } from './rag';
import { ConcurrencyController, ConcurrencyConfig, ConcurrencyStatus } from './concurrencyController';
import { LRUCache, CacheStats as LRUCacheStats } from '../core/lruCache';
import type { DataStore as PgDataStore } from '../dataStore';

const DATA_DIR = path.join(process.cwd(), 'data', 'ai-ops');
const ALERTS_DIR = path.join(DATA_DIR, 'alerts');
const RULES_FILE = path.join(ALERTS_DIR, 'rules.json');
const EVENTS_DIR = path.join(ALERTS_DIR, 'events');

// ==================== 告警生命周期状态机 ====================
// Requirements: G4.13 - 告警事件完整生命周期管理

/**
 * 告警生命周期状态
 */
export type AlertState = 'active' | 'acknowledged' | 'in_progress' | 'resolved' | 'closed';

/**
 * 有效的状态转换映射
 * active → acknowledged → in_progress → resolved/closed
 */
const VALID_ALERT_TRANSITIONS: Record<AlertState, AlertState[]> = {
  active: ['acknowledged', 'resolved', 'closed'],
  acknowledged: ['in_progress', 'resolved', 'closed'],
  in_progress: ['resolved', 'closed'],
  resolved: ['closed'],
  closed: [],
};

// ==================== Syslog Topic 严重度映射 ====================
// Requirements: G5.17 - 数据驱动的 topic-to-severity 映射

/**
 * Syslog topic 到严重度的映射条目
 */
export interface SyslogTopicSeverityMapping {
  /** topic 匹配模式（支持正则） */
  pattern: string;
  /** 映射到的告警严重度 */
  severity: AlertSeverity;
  /** 描述 */
  description?: string;
}

/**
 * 默认的 syslog topic 严重度映射（数据驱动，非硬编码）
 * 可通过配置覆盖，不再绑定特定厂商
 */
const DEFAULT_SYSLOG_TOPIC_SEVERITY_MAP: SyslogTopicSeverityMapping[] = [
  { pattern: 'critical|emergency', severity: 'emergency', description: 'Critical system events' },
  { pattern: 'error|failure', severity: 'critical', description: 'Error events' },
  { pattern: 'warning|warn', severity: 'warning', description: 'Warning events' },
  { pattern: 'info|notice|system', severity: 'info', description: 'Informational events' },
];

/**
 * 获取日期字符串 (YYYY-MM-DD)
 */
function getDateString(timestamp: number): string {
  const date = new Date(timestamp);
  return date.toISOString().split('T')[0];
}

/**
 * 获取告警事件文件路径
 */
function getEventsFilePath(dateStr: string): string {
  return path.join(EVENTS_DIR, `${dateStr}.json`);
}

/**
 * 规则触发状态跟踪（用于持续时间阈值检测）
 */
interface RuleTriggerState {
  ruleId: string;
  consecutiveCount: number;
  lastEvaluatedAt: number;
}

/**
 * 告警引擎配置
 * Requirements: 11.3 - 支持配置持久化间隔
 * Requirements: 2.1, 2.3, 2.4 - 支持配置并发控制参数
 * Requirements: 3.1, 3.3, 3.5 - 支持配置缓存参数
 */
export interface AlertEngineConfig {
  persistIntervalMs: number;    // 持久化间隔，默认 30000 (30秒)
  enableMemoryCache: boolean;   // 启用内存缓存，默认 true
  // Pipeline 并发控制配置
  maxConcurrentPipeline: number;  // 最大并发 Pipeline 处理数，默认 5
  maxQueueSize: number;           // 最大队列大小，默认 100
  taskTimeoutMs: number;          // 单任务超时（毫秒），默认 30000
  enablePriorityQueue: boolean;   // 启用优先级队列，默认 true
  enableBackpressure: boolean;    // 启用背压机制，默认 true
  backpressureThreshold: number;  // 背压阈值（队列使用率 0-1），默认 0.8
  // 缓存配置 (Requirements: 3.1, 3.3, 3.5)
  maxCacheEntries: number;        // 最大缓存条目数，默认 10000
  cacheCleanupIntervalMs: number; // 缓存清理间隔，默认 5 分钟
  maxCacheMemoryMB: number;       // 最大缓存内存（MB），默认 50
}

/**
 * 持久化队列条目
 * Requirements: 11.2 - 异步持久化机制
 */
interface PersistQueueEntry {
  type: 'rule' | 'event';
  operation: 'create' | 'update' | 'delete';
  data: AlertRule | AlertEvent;
  timestamp: number;
}

/**
 * 默认配置
 */
const DEFAULT_CONFIG: AlertEngineConfig = {
  persistIntervalMs: 30000,  // 30 秒
  enableMemoryCache: true,
  // Pipeline 并发控制默认配置
  maxConcurrentPipeline: 5,      // 默认 5 个并发
  maxQueueSize: 100,             // 默认队列大小 100
  taskTimeoutMs: 30000,          // 默认 30 秒超时
  enablePriorityQueue: true,     // 默认启用优先级队列
  enableBackpressure: true,      // 默认启用背压
  backpressureThreshold: 0.8,    // 默认 80% 触发背压
  // 缓存默认配置 (Requirements: 3.1, 3.3, 3.5)
  maxCacheEntries: 10000,        // 默认最大 10000 条目
  cacheCleanupIntervalMs: 5 * 60 * 1000, // 默认 5 分钟清理间隔
  maxCacheMemoryMB: 50,          // 默认最大 50MB 内存
};

export class AlertEngine implements IAlertEngine {
  private rules: AlertRule[] = [];
  private initialized = false;

  // 规则触发状态跟踪（内存中）
  private triggerStates: Map<string, RuleTriggerState> = new Map();

  // 活跃告警缓存（内存中）
  private activeAlerts: Map<string, AlertEvent> = new Map();

  // 预处理事件处理器（用于 AI 智能处理流程）
  private preprocessedEventHandlers: Array<(event: UnifiedEvent | CompositeEvent) => void> = [];

  // ==================== DeviceManager 依赖 ====================
  // Requirements: G4.12 - 通过 DeviceDriver 标准化接口替代直接 API 调用
  private deviceManager: DeviceManager | null = null;

  // ==================== Syslog Topic 严重度映射 ====================
  // Requirements: G5.17 - 数据驱动的 topic-to-severity 映射
  private syslogTopicSeverityMap: SyslogTopicSeverityMapping[] = [...DEFAULT_SYSLOG_TOPIC_SEVERITY_MAP];

  // ==================== Syslog 事件去重 ====================
  // Requirements (syslog-cpu-spike-fix): 4.1, 4.2, 4.3, 4.4 - Syslog 事件入队去重
  /** 处理中的 Syslog 事件指纹集合 */
  private processingSyslogFingerprints: Set<string> = new Set();
  /** 指纹清理定时器 */
  private syslogFingerprintCleanupTimer: ReturnType<typeof setInterval> | null = null;
  /** 指纹过期时间（毫秒），默认 5 分钟 */
  private readonly SYSLOG_FINGERPRINT_TTL_MS = 5 * 60 * 1000;
  /** 指纹清理定时器间隔（毫秒），默认 1 分钟 */
  private readonly SYSLOG_FINGERPRINT_CLEANUP_INTERVAL_MS = 60 * 1000;
  /** 指纹时间戳映射（用于过期清理） */
  private syslogFingerprintTimestamps: Map<string, number> = new Map();

  // ==================== 并发控制 ====================
  // 使用增强的并发控制器替代手动实现
  // Requirements: 2.1, 2.2, 2.4, 2.6
  private pipelineController: ConcurrencyController<
    { event: AlertEvent; rule: AlertRule },
    void
  > | null = null;

  // ==================== 内存缓存相关 ====================
  // Requirements: 11.1, 11.2, 11.3, 11.4

  // 配置
  private config: AlertEngineConfig;

  // 持久化队列（待写入文件的变更）
  private persistQueue: PersistQueueEntry[] = [];

  // 持久化定时器
  private persistTimer: ReturnType<typeof setInterval> | null = null;

  // 规则是否有变更（用于批量持久化）
  private rulesDirty = false;

  // 事件变更缓存（按日期分组）
  private eventsDirty: Map<string, Set<string>> = new Map();

  // 事件内存缓存（使用 LRU 缓存替代 Map）
  // Requirements: 3.1, 3.2 - 使用 LRU 缓存管理事件
  private eventsCache: LRUCache<string, AlertEvent> | null = null;

  // 是否正在持久化
  private isPersisting = false;

  // 缓存清理定时器
  private cacheCleanupTimer: ReturnType<typeof setInterval> | null = null;

  // 最大缓存天数（内存中只保留最近 N 天的事件缓存）
  private readonly MAX_CACHE_DAYS = 2;

  // ==================== PostgreSQL DataStore 集成 ====================
  // Requirements: C3.12 - 统一迁移至 PostgreSQL
  private pgDataStore: PgDataStore | null = null;

  /** Check if PostgreSQL DataStore is available */
  private get usePg(): boolean {
    return this.pgDataStore !== null;
  }

  constructor(config?: Partial<AlertEngineConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * 设置 PostgreSQL DataStore 实例
   * Requirements: C3.12 - 统一迁移至 PostgreSQL
   */
  setPgDataStore(ds: PgDataStore): void {
    this.pgDataStore = ds;
    logger.info('AlertEngine: PgDataStore configured, PostgreSQL persistence enabled');
  }

  /**
   * 设置 DeviceManager 实例
   * 用于通过 DeviceDriver 标准化接口执行设备操作，替代直接 API 调用
   * Requirements: G4.12
   */
  setDeviceManager(dm: DeviceManager): void {
    this.deviceManager = dm;
    logger.info('AlertEngine: DeviceManager configured, using DeviceDriver for device operations');
  }

  /**
   * 设置 Syslog topic 严重度映射
   * 允许外部配置覆盖默认映射，实现数据驱动的 topic 分类
   * Requirements: G5.17
   */
  setSyslogTopicSeverityMap(mappings: SyslogTopicSeverityMapping[]): void {
    this.syslogTopicSeverityMap = mappings;
    logger.info(`AlertEngine: Syslog topic severity map updated with ${mappings.length} entries`);
  }

  /**
   * 确保数据目录存在
   */
  private async ensureDataDir(): Promise<void> {
    try {
      await fs.mkdir(ALERTS_DIR, { recursive: true });
      await fs.mkdir(EVENTS_DIR, { recursive: true });
    } catch (error) {
      logger.error('Failed to create alerts directories:', error);
    }
  }

  /**
   * 初始化服务
   * 性能优化：并行加载规则和活跃告警
   * Requirements: 11.1 - 使用内存缓存存储告警规则和活跃告警
   * Requirements: 2.1, 2.4 - 初始化并发控制器
   * Requirements: 3.1, 3.2 - 初始化 LRU 缓存
   */
  async initialize(): Promise<void> {
    if (this.initialized) {
      return;
    }

    const startTime = Date.now();
    await this.ensureDataDir();

    // 初始化 LRU 缓存 (Requirements: 3.1, 3.2, 3.5)
    this.initializeEventsCache();

    // 并行加载规则和活跃告警（两者独立，无依赖关系）
    await Promise.all([
      this.loadRules(),
      this.loadActiveAlerts(),
    ]);

    // 初始化 Pipeline 并发控制器
    // Requirements: 2.1, 2.2, 2.4, 2.6
    this.initializePipelineController();

    // 启动持久化定时器
    // Requirements: 11.2, 11.3 - 异步持久化机制，可配置持久化间隔
    if (this.config.enableMemoryCache && this.config.persistIntervalMs > 0) {
      this.startPersistTimer();
      this.startCacheCleanupTimer();
    }

    // 启动 Syslog 指纹清理定时器
    // Requirements: 4.1 - 按配置间隔周期性清理过期指纹
    this.startSyslogFingerprintCleanupTimer();

    this.initialized = true;
    logger.info(`AlertEngine initialized in ${Date.now() - startTime}ms (persistInterval: ${this.config.persistIntervalMs}ms, maxConcurrentPipeline: ${this.config.maxConcurrentPipeline}, maxCacheEntries: ${this.config.maxCacheEntries})`);
  }

  /**
   * 初始化事件缓存
   * Requirements: 3.1, 3.2, 3.5 - 使用 LRU 缓存管理事件
   */
  private initializeEventsCache(): void {
    this.eventsCache = new LRUCache<string, AlertEvent>({
      maxEntries: this.config.maxCacheEntries,
      maxMemoryMB: this.config.maxCacheMemoryMB,
      cleanupIntervalMs: this.config.cacheCleanupIntervalMs,
      ttlMs: this.MAX_CACHE_DAYS * 24 * 60 * 60 * 1000, // TTL 与最大缓存天数一致
      onEvict: (key, value) => {
        logger.debug(`Event evicted from cache: ${key}`);
      },
    });
    logger.debug(`Events LRU cache initialized (maxEntries: ${this.config.maxCacheEntries}, maxMemoryMB: ${this.config.maxCacheMemoryMB})`);
  }

  /**
   * 初始化 Pipeline 并发控制器
   * Requirements: 2.1, 2.2, 2.4, 2.6
   */
  private initializePipelineController(): void {
    const concurrencyConfig: Partial<ConcurrencyConfig> = {
      maxConcurrent: this.config.maxConcurrentPipeline,
      maxQueueSize: this.config.maxQueueSize,
      taskTimeout: this.config.taskTimeoutMs,
      enablePriorityQueue: this.config.enablePriorityQueue,
      enableBackpressure: this.config.enableBackpressure,
      backpressureThreshold: this.config.backpressureThreshold,
    };

    this.pipelineController = new ConcurrencyController<
      { event: AlertEvent; rule: AlertRule },
      void
    >(concurrencyConfig);

    // 设置任务处理器
    this.pipelineController.setProcessor(async ({ event, rule }) => {
      await this.processPipelineTask(event, rule);
    });

    logger.info('Pipeline concurrency controller initialized', concurrencyConfig);
  }

  /**
   * 启动持久化定时器
   * Requirements: 11.2, 11.3
   */
  private startPersistTimer(): void {
    if (this.persistTimer) {
      clearInterval(this.persistTimer);
    }

    this.persistTimer = setInterval(async () => {
      await this.persistDirtyData();
    }, this.config.persistIntervalMs);

    logger.debug(`Persist timer started with interval ${this.config.persistIntervalMs}ms`);
  }

  /**
   * 停止持久化定时器
   */
  private stopPersistTimer(): void {
    if (this.persistTimer) {
      clearInterval(this.persistTimer);
      this.persistTimer = null;
      logger.debug('Persist timer stopped');
    }
  }

  /**
   * 启动缓存清理定时器
   * 定期清理过期的事件缓存，防止内存泄漏
   * Requirements: 3.3 - 可配置缓存清理间隔
   */
  private startCacheCleanupTimer(): void {
    if (this.cacheCleanupTimer) {
      clearInterval(this.cacheCleanupTimer);
    }

    // 使用配置的清理间隔（默认 5 分钟）
    this.cacheCleanupTimer = setInterval(() => {
      this.cleanupExpiredEventCache();
      this.checkMemoryThreshold();
    }, this.config.cacheCleanupIntervalMs);

    logger.debug(`Cache cleanup timer started with interval ${this.config.cacheCleanupIntervalMs}ms`);
  }

  /**
   * 停止缓存清理定时器
   */
  private stopCacheCleanupTimer(): void {
    if (this.cacheCleanupTimer) {
      clearInterval(this.cacheCleanupTimer);
      this.cacheCleanupTimer = null;
      logger.debug('Cache cleanup timer stopped');
    }
  }

  /**
   * 启动 Syslog 指纹清理定时器
   * 定期清理过期的 Syslog 事件指纹，防止内存持续增长
   * Requirements: 4.1 - 启动 Syslog 指纹清理定时器
   */
  private startSyslogFingerprintCleanupTimer(): void {
    if (this.syslogFingerprintCleanupTimer) {
      clearInterval(this.syslogFingerprintCleanupTimer);
    }
    this.syslogFingerprintCleanupTimer = setInterval(() => {
      this.cleanupExpiredSyslogFingerprints();
    }, this.SYSLOG_FINGERPRINT_CLEANUP_INTERVAL_MS);
    logger.debug('Syslog fingerprint cleanup timer started');
  }

  /**
   * 清理过期的事件缓存
   * Requirements: 3.2 - LRU 淘汰策略
   */
  private cleanupExpiredEventCache(): void {
    if (!this.eventsCache) return;

    const cleaned = this.eventsCache.forceCleanup();
    if (cleaned > 0) {
      logger.info(`Cleaned up ${cleaned} expired event cache entries`);
    }
  }

  /**
   * 检查内存阈值并触发清理
   * Requirements: 3.5 - 内存使用量超过阈值时主动触发缓存清理
   */
  private checkMemoryThreshold(): void {
    if (!this.eventsCache) return;

    const stats = this.eventsCache.getStats();
    const memoryUsagePercent = (stats.memoryUsageMB / this.config.maxCacheMemoryMB) * 100;

    // 当内存使用超过 80% 时，强制清理
    if (memoryUsagePercent > 80) {
      logger.warn(`Cache memory usage at ${memoryUsagePercent.toFixed(1)}%, triggering cleanup`);
      const cleaned = this.eventsCache.forceCleanup();
      logger.info(`Memory threshold cleanup: removed ${cleaned} entries`);
    }
  }

  /**
   * 持久化脏数据
   * Requirements: 11.2 - 异步持久化到文件
   */
  private async persistDirtyData(): Promise<void> {
    if (this.isPersisting) {
      logger.debug('Persist already in progress, skipping');
      return;
    }

    this.isPersisting = true;
    const startTime = Date.now();

    try {
      // 持久化规则
      if (this.rulesDirty) {
        await this.persistRules();
        this.rulesDirty = false;
      }

      // 持久化事件（按日期）
      for (const [dateStr, eventIds] of this.eventsDirty) {
        if (eventIds.size > 0) {
          await this.persistEventsForDate(dateStr);
          eventIds.clear();
        }
      }

      const elapsed = Date.now() - startTime;
      if (elapsed > 100) {
        logger.debug(`Persist completed in ${elapsed}ms`);
      }
    } catch (error) {
      logger.error('Failed to persist dirty data:', error);
    } finally {
      this.isPersisting = false;
    }
  }

  /**
   * 持久化规则
   * Requirements: 9.2 - 当 DataStore 可用时写入 alert_rules 表
   */
  private async persistRules(): Promise<void> {
    // PostgreSQL path (highest priority)
    if (this.usePg) {
      try {
        await this.pgDataStore!.transaction(async (tx) => {
          for (const rule of this.rules) {
            const tenantId = rule.tenantId || 'default';
            const deviceId = rule.deviceId || null;
            const config = JSON.stringify({
              metricLabel: rule.metricLabel,
              targetStatus: rule.targetStatus,
              duration: rule.duration,
              cooldownMs: rule.cooldownMs,
              channels: rule.channels,
              autoResponse: rule.autoResponse,
              lastTriggeredAt: rule.lastTriggeredAt,
            });
            const createdAt = new Date(rule.createdAt).toISOString();
            const updatedAt = new Date(rule.updatedAt).toISOString();

            await tx.execute(
              `INSERT INTO alert_rules (id, tenant_id, device_id, name, metric, operator, threshold, severity, enabled, config, created_at, updated_at)
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
               ON CONFLICT (id) DO UPDATE SET
                 tenant_id = EXCLUDED.tenant_id, device_id = EXCLUDED.device_id, name = EXCLUDED.name,
                 metric = EXCLUDED.metric, operator = EXCLUDED.operator, threshold = EXCLUDED.threshold,
                 severity = EXCLUDED.severity, enabled = EXCLUDED.enabled, config = EXCLUDED.config,
                 updated_at = EXCLUDED.updated_at`,
              [rule.id, tenantId, deviceId, rule.name, rule.metric, rule.operator, rule.threshold, rule.severity, rule.enabled, config, createdAt, updatedAt]
            );
          }
        });
        logger.debug(`Rules persisted to PostgreSQL: ${this.rules.length} rules`);
        return;
      } catch (error) {
        logger.error('Failed to persist rules to PostgreSQL, falling back:', error);
      }
    }

    // Fallback: 写入 JSON 文件
    await this.ensureDataDir();
    await fs.writeFile(RULES_FILE, JSON.stringify(this.rules, null, 2), 'utf-8');
    logger.debug(`Rules persisted: ${this.rules.length} rules`);
  }

  /**
   * 持久化指定日期的事件
   * Requirements: 3.1 - 使用 LRU 缓存
   */
  private async persistEventsForDate(dateStr: string): Promise<void> {
    if (!this.eventsCache) return;

    // 从 LRU 缓存中获取该日期的所有事件并写入文件
    // 逻辑变更：读取现有文件 -> 合并缓存中的事件 -> 写回文件
    // 防止覆盖掉因 LRU 驱逐而不在缓存中但仍存在于文件中的事件

    // 1. 获取缓存中该日期的事件
    const cachedEvents: AlertEvent[] = [];
    if (this.eventsCache) {
      for (const [key, event] of this.eventsCache.entries()) {
        const eventDateStr = getDateString(event.triggeredAt);
        if (eventDateStr === dateStr) {
          cachedEvents.push(event);
        }
      }
    }

    // 如果缓存中没有该日期的事件，理论上不需要做任何事，除非我们想确保持久化空状态？
    // 但 persistEventsForDate 是由 persistDirtyData 调用的，意味着一定有脏数据需要写入（即缓存中有数据）
    // 或者我们可能想删除所有事件？不，我们只做追加/更新。

    await this.ensureDataDir();
    const filePath = getEventsFilePath(dateStr);

    // 2. 读取现有文件（如果存在）
    let fileEvents: AlertEvent[] = [];
    try {
      const data = await fs.readFile(filePath, 'utf-8');
      fileEvents = JSON.parse(data) as AlertEvent[];
    } catch (error) {
      // 如果文件不存在，忽略错误，我们将创建一个新文件
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        logger.error(`Failed to read existing events file for merge ${dateStr}:`, error);
        // 如果读取失败，为了安全起见，也许应该中止？
        // 但如果不中止，我们可能会覆盖文件。
        // 考虑到这是一次修复，如果读取失败，我们最好抛出异常而不是粗暴覆盖
        // 除非文件真的损坏了。
        // 让我们保守一点：如果读取出错且不是 ENOENT，记录错误并继续（可能会覆盖，但比应用崩溃好？）
        // 或者：仅仅使用 cachedEvents 写入（这就是之前的行为，也就是 Bug）
        // 让我们尽量保留原有数据。
      }
    }

    // 3. 合并事件
    const mergedEventsMap = new Map<string, AlertEvent>();

    // 先把文件中的事件放入 Map
    for (const event of fileEvents) {
      mergedEventsMap.set(event.id, event);
    }

    // 再把缓存中的事件（较新）更新/添加到 Map
    for (const event of cachedEvents) {
      mergedEventsMap.set(event.id, event);
    }

    const finalEvents = Array.from(mergedEventsMap.values());

    // 即使没有事件也要写入空数组，确保删除操作被持久化
    await fs.writeFile(filePath, JSON.stringify(finalEvents, null, 2), 'utf-8');
    logger.debug(`Events persisted for ${dateStr}: ${finalEvents.length} events (merged cached: ${cachedEvents.length}, file: ${fileEvents.length})`);
  }

  /**
   * 强制持久化所有待写入数据
   * Requirements: 11.4 - 系统关闭时确保所有待持久化数据写入文件
   */
  async flush(): Promise<void> {
    logger.info('Flushing all pending data to disk...');

    // 停止定时器
    this.stopPersistTimer();
    this.stopCacheCleanupTimer();

    // 清除 Syslog 指纹清理定时器
    if (this.syslogFingerprintCleanupTimer) {
      clearInterval(this.syslogFingerprintCleanupTimer);
      this.syslogFingerprintCleanupTimer = null;
    }

    // 等待 Pipeline 控制器完成所有任务
    if (this.pipelineController) {
      logger.info('Draining pipeline controller...');
      await this.pipelineController.drain();
    }

    // 等待当前持久化完成（带超时保护，避免无限等待导致 CPU 飙升）
    const maxWaitTime = 10000; // 最多等待 10 秒
    const startWait = Date.now();
    while (this.isPersisting) {
      if (Date.now() - startWait > maxWaitTime) {
        logger.warn('Flush wait timeout, forcing persist');
        break;
      }
      await new Promise(resolve => setTimeout(resolve, 50)); // 增加等待间隔到 50ms
    }

    // 强制持久化所有脏数据
    this.isPersisting = true;
    try {
      // 持久化规则
      if (this.rulesDirty) {
        await this.persistRules();
        this.rulesDirty = false;
      }

      // 持久化所有缓存的事件到文件（按日期分组）
      if (this.eventsCache) {
        const dateGroups = new Map<string, AlertEvent[]>();
        for (const [key, event] of this.eventsCache.entries()) {
          const dateStr = getDateString(event.triggeredAt);
          if (!dateGroups.has(dateStr)) {
            dateGroups.set(dateStr, []);
          }
          dateGroups.get(dateStr)!.push(event);
        }

        for (const [dateStr, events] of dateGroups) {
          if (events.length > 0) {
            await this.ensureDataDir();
            const filePath = getEventsFilePath(dateStr);
            await fs.writeFile(filePath, JSON.stringify(events, null, 2), 'utf-8');
            logger.debug(`Events persisted for ${dateStr}: ${events.length} events`);
          }
        }
      }
      this.eventsDirty.clear();

      logger.info('All pending data flushed');
    } catch (error) {
      logger.error('Failed to flush data:', error);
      throw error;
    } finally {
      this.isPersisting = false;
    }
  }

  /**
   * 检查服务是否支持降级模式
   * Requirements: 5.2 - 支持优雅降级模式
   */
  supportsDegradedMode(): boolean {
    // AlertEngine 作为持久化服务，支持降级模式
    // 在降级模式下，可以继续处理告警但可能跳过 AI 分析
    return true;
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

    try {
      // 检查是否已初始化
      if (!this.initialized) {
        return {
          healthy: false,
          message: 'AlertEngine not initialized',
          lastCheck: now,
          consecutiveFailures: 1,
        };
      }

      // 检查 Pipeline 控制器状态
      if (this.pipelineController) {
        const status = this.pipelineController.getStatus();
        if (status.isPaused) {
          return {
            healthy: false,
            message: 'Pipeline controller is paused',
            lastCheck: now,
            consecutiveFailures: 1,
          };
        }
      }

      // 检查缓存状态
      const cacheStats = this.getCacheStats();
      if (cacheStats.lruCacheStats && cacheStats.lruCacheStats.memoryUsageMB > (this.config.maxCacheMemoryMB * 0.9)) {
        return {
          healthy: true,
          message: 'Cache memory usage high',
          lastCheck: now,
          consecutiveFailures: 0,
        };
      }

      return {
        healthy: true,
        message: 'AlertEngine is healthy',
        lastCheck: now,
        consecutiveFailures: 0,
      };
    } catch (error) {
      return {
        healthy: false,
        message: error instanceof Error ? error.message : 'Health check failed',
        lastCheck: now,
        consecutiveFailures: 1,
      };
    }
  }

  /**
   * 获取缓存统计信息
   * Requirements: 11.1, 3.6 - 提供缓存状态查询和统计信息
   */
  getCacheStats(): {
    rulesInMemory: number;
    activeAlertsInMemory: number;
    pendingPersist: number;
    eventsCacheSize: number;
    lruCacheStats?: LRUCacheStats;
  } {
    let pendingPersist = 0;
    if (this.rulesDirty) pendingPersist++;
    for (const eventIds of this.eventsDirty.values()) {
      pendingPersist += eventIds.size;
    }

    const eventsCacheSize = this.eventsCache ? this.eventsCache.size() : 0;
    const lruCacheStats = this.eventsCache ? this.eventsCache.getStats() : undefined;

    return {
      rulesInMemory: this.rules.length,
      activeAlertsInMemory: this.activeAlerts.size,
      pendingPersist,
      eventsCacheSize,
      lruCacheStats,
    };
  }

  // ==================== DataStore 辅助方法 ====================

  /**
   * 将数据库行转换为 AlertEvent 对象
   * Requirements: 9.2
   */
  private dbRowToAlertEvent(row: {
    id: string;
    tenant_id: string;
    device_id: string | null;
    rule_id: string;
    severity: string;
    message: string;
    metric_value: number | null;
    status: string;
    acknowledged_at: string | null;
    resolved_at: string | null;
    created_at: string;
    notify_channels: string | null;
    auto_response_config: string | null;
  }): AlertEvent {
    // 尝试从内存中的规则获取额外信息
    const rule = this.rules.find((r) => r.id === row.rule_id);

    let notifyChannels: string[] | undefined;
    try {
      if (row.notify_channels) {
        notifyChannels = JSON.parse(row.notify_channels);
      }
    } catch (e) {
      logger.warn(`Failed to parse notify_channels for event ${row.id}:`, e);
    }

    let autoResponseConfig: any | undefined;
    try {
      if (row.auto_response_config) {
        autoResponseConfig = JSON.parse(row.auto_response_config);
      }
    } catch (e) {
      logger.warn(`Failed to parse auto_response_config for event ${row.id}:`, e);
    }

    return {
      id: row.id,
      tenantId: row.tenant_id,
      deviceId: row.device_id || undefined,
      ruleId: row.rule_id,
      ruleName: rule?.name || row.rule_id,
      severity: row.severity as AlertSeverity,
      metric: (rule?.metric || 'cpu') as MetricType,
      metricLabel: rule?.metricLabel,
      currentValue: row.metric_value ?? 0,
      threshold: rule?.threshold ?? 0,
      message: row.message,
      status: row.status as AlertEvent['status'],
      triggeredAt: new Date(row.created_at).getTime(),
      resolvedAt: row.resolved_at ? new Date(row.resolved_at).getTime() : undefined,
      notifyChannels: notifyChannels || rule?.channels, // Fallback to rule if missing in event
      autoResponseConfig: autoResponseConfig || rule?.autoResponse, // Fallback to rule if missing in event
    };
  }

  /**
   * 加载告警规则
   * Requirements: 9.2 - 当 DataStore 可用时从 alert_rules 表读取
   */
  private async loadRules(): Promise<void> {
    const rulesMap = new Map<string, AlertRule>();

    // 0. 从 PostgreSQL 加载（最高优先级）
    if (this.usePg) {
      try {
        const rows = await this.pgDataStore!.query<{
          id: string;
          tenant_id: string;
          device_id: string | null;
          name: string;
          metric: string;
          operator: string;
          threshold: number;
          severity: string;
          enabled: boolean;
          config: string;
          created_at: string;
          updated_at: string;
        }>('SELECT * FROM alert_rules');

        for (const row of rows) {
          const config = typeof row.config === 'string' ? JSON.parse(row.config || '{}') : (row.config || {});
          const rule: AlertRule = {
            id: row.id,
            name: row.name,
            enabled: Boolean(row.enabled),
            metric: row.metric as MetricType,
            metricLabel: config.metricLabel,
            operator: row.operator as AlertOperator,
            threshold: row.threshold,
            targetStatus: config.targetStatus,
            duration: config.duration ?? 1,
            cooldownMs: config.cooldownMs ?? 300000,
            severity: row.severity as AlertSeverity,
            channels: config.channels ?? [],
            autoResponse: config.autoResponse,
            createdAt: new Date(row.created_at).getTime(),
            updatedAt: new Date(row.updated_at).getTime(),
            lastTriggeredAt: config.lastTriggeredAt,
            tenantId: row.tenant_id,
            deviceId: row.device_id || undefined,
          };
          rulesMap.set(rule.id, rule);
        }
        if (rulesMap.size > 0) {
          logger.info(`Loaded ${rulesMap.size} alert rules from PostgreSQL`);
          this.rules = Array.from(rulesMap.values());
          return;
        }
      } catch (error) {
        logger.warn('Failed to load alert rules from PostgreSQL, falling back:', error);
      }
    }

    // 1. 从 JSON 文件加载（Supplement & Fallback）
    // 即使 DB 有数据，也检查 JSON 文件，合并可能因 DB 写入失败而仅存在于文件中的规则
    try {
      const data = await fs.readFile(RULES_FILE, 'utf-8');
      const fileRules = JSON.parse(data) as AlertRule[];
      let mergedFromFile = 0;
      for (const rule of fileRules) {
        if (!rulesMap.has(rule.id)) {
          rulesMap.set(rule.id, rule);
          mergedFromFile++;
        } else {
          // 如果 DB 和文件都有，以 updatedAt 较新的为准
          const existing = rulesMap.get(rule.id)!;
          if (rule.updatedAt > existing.updatedAt) {
            rulesMap.set(rule.id, rule);
            mergedFromFile++;
          }
        }
      }
      if (mergedFromFile > 0) {
        logger.info(`Merged ${mergedFromFile} additional/newer rules from JSON file`);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        // 文件不存在，如果 DB 也没有数据则初始化空规则
        if (rulesMap.size === 0) {
          this.rules = [];
          await this.saveRules();
          return;
        }
      } else {
        logger.error('Failed to load alert rules from JSON file:', error);
      }
    }

    this.rules = Array.from(rulesMap.values());
    logger.info(`Total rules loaded: ${this.rules.length}`);
  }

  /**
   * 保存告警规则
   * Requirements: 11.2 - 更新内存缓存并异步持久化
   */
  private async saveRules(): Promise<void> {
    if (this.config.enableMemoryCache) {
      // 标记为脏数据，等待异步持久化
      this.rulesDirty = true;
    } else {
      // 直接写入文件（兼容模式）
      await this.ensureDataDir();
      await fs.writeFile(RULES_FILE, JSON.stringify(this.rules, null, 2), 'utf-8');
    }
  }


  /**
   * 读取指定日期的告警事件
   * Requirements: 11.1, 3.1 - 使用 LRU 缓存
   */
  private async readEventsFile(dateStr: string): Promise<AlertEvent[]> {
    // Fallback: 从文件读取并与缓存合并
    // 逻辑变更：不再优先返回缓存，而是始终读取文件（如果存在）并与缓存合并
    // 防止因缓存驱逐导致读取到不完整的数据

    // 1. 获取缓存中的事件
    const cachedEventsMap = new Map<string, AlertEvent>();
    if (this.config.enableMemoryCache && this.eventsCache) {
      for (const [key, event] of this.eventsCache.entries()) {
        const eventDateStr = getDateString(event.triggeredAt);
        if (eventDateStr === dateStr) {
          cachedEventsMap.set(event.id, event);
        }
      }
    }

    // 2. 读取文件中的事件
    let fileEvents: AlertEvent[] = [];
    const filePath = getEventsFilePath(dateStr);
    try {
      const data = await fs.readFile(filePath, 'utf-8');
      fileEvents = JSON.parse(data) as AlertEvent[];
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        logger.error(`Failed to read alert events file ${dateStr}:`, error);
      }
      // 文件不存在，fileEvents 为空数组
    }

    // 3. 合并事件
    // 优先使用缓存中的事件（可能是较新的/脏数据）
    // 如果缓存中有，使用缓存的；如果缓存中没有但文件中有，使用文件的
    const mergedEventsMap = new Map<string, AlertEvent>();

    // 先添加文件中的事件
    for (const event of fileEvents) {
      mergedEventsMap.set(event.id, event);
    }

    // 再覆盖/添加缓存中的事件
    for (const event of cachedEventsMap.values()) {
      mergedEventsMap.set(event.id, event);
      // 同时更新回 LRU 缓存（刷新访问时间）
      if (this.config.enableMemoryCache && this.eventsCache) {
        this.eventsCache.set(event.id, event);
      }
    }

    return Array.from(mergedEventsMap.values());
  }

  /**
   * 写入告警事件
   * Requirements: 11.2, 3.1 - 更新 LRU 缓存并异步持久化
   */
  private async writeEventsFile(dateStr: string, events: AlertEvent[]): Promise<void> {
    // PostgreSQL path (highest priority)
    if (this.usePg) {
      try {
        await this.pgDataStore!.transaction(async (tx) => {
          for (const event of events) {
            const tenantId = event.tenantId || 'default';
            const deviceId = event.deviceId || null;
            const createdAt = new Date(event.triggeredAt).toISOString();
            const resolvedAt = event.resolvedAt ? new Date(event.resolvedAt).toISOString() : null;
            const notifyChannels = JSON.stringify(event.notifyChannels || []);
            const autoResponseConfig = JSON.stringify(event.autoResponseConfig || {});

            await tx.execute(
              `INSERT INTO alert_events (id, tenant_id, device_id, rule_id, severity, message, metric_value, status, resolved_at, created_at, notify_channels, auto_response_config)
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
               ON CONFLICT (id) DO UPDATE SET
                 status = EXCLUDED.status, resolved_at = EXCLUDED.resolved_at,
                 notify_channels = EXCLUDED.notify_channels, auto_response_config = EXCLUDED.auto_response_config`,
              [event.id, tenantId, deviceId, event.ruleId, event.severity, event.message, event.currentValue, event.status, resolvedAt, createdAt, notifyChannels, autoResponseConfig]
            );
          }
        });

        // 同时更新 LRU 缓存
        if (this.config.enableMemoryCache && this.eventsCache) {
          for (const event of events) {
            this.eventsCache.set(event.id, event);
          }
        }
        return;
      } catch (error) {
        logger.error('Failed to write events to PostgreSQL, falling back:', error);
      }
    }

    // Fallback: 写入 LRU 缓存或文件
    if (this.config.enableMemoryCache && this.eventsCache) {
      // 更新 LRU 缓存
      for (const event of events) {
        this.eventsCache.set(event.id, event);
      }

      // 标记所有事件为脏数据
      let dirtySet = this.eventsDirty.get(dateStr);
      if (!dirtySet) {
        dirtySet = new Set();
        this.eventsDirty.set(dateStr, dirtySet);
      }
      for (const event of events) {
        dirtySet.add(event.id);
      }
    } else {
      // 直接写入文件（兼容模式）
      await this.ensureDataDir();
      const filePath = getEventsFilePath(dateStr);
      await fs.writeFile(filePath, JSON.stringify(events, null, 2), 'utf-8');
    }
  }

  /**
   * 保存告警事件
   * Requirements: 11.2, 3.1 - 更新 LRU 缓存并异步持久化
   * Requirements: 9.2 - 当 DataStore 可用时写入 alert_events 表
   */
  private async saveEvent(event: AlertEvent): Promise<void> {
    const dateStr = getDateString(event.triggeredAt);

    // PostgreSQL path (highest priority)
    if (this.usePg) {
      try {
        const tenantId = event.tenantId || 'default';
        const deviceId = event.deviceId || null;
        const createdAt = new Date(event.triggeredAt).toISOString();
        const resolvedAt = event.resolvedAt ? new Date(event.resolvedAt).toISOString() : null;
        const notifyChannels = JSON.stringify(event.notifyChannels || []);
        const autoResponseConfig = JSON.stringify(event.autoResponseConfig || {});

        await this.pgDataStore!.execute(
          `INSERT INTO alert_events (id, tenant_id, device_id, rule_id, severity, message, metric_value, status, resolved_at, created_at, notify_channels, auto_response_config)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
           ON CONFLICT (id) DO UPDATE SET
             status = EXCLUDED.status, resolved_at = EXCLUDED.resolved_at,
             notify_channels = EXCLUDED.notify_channels, auto_response_config = EXCLUDED.auto_response_config`,
          [event.id, tenantId, deviceId, event.ruleId || null, event.severity, event.message, event.currentValue ?? null, event.status, resolvedAt, createdAt, notifyChannels, autoResponseConfig]
        );

        // 同时更新 LRU 缓存
        if (this.config.enableMemoryCache && this.eventsCache) {
          this.eventsCache.set(event.id, event);
        }
        return;
      } catch (error) {
        logger.error('Failed to save event to PostgreSQL, falling back:', error);
      }
    }

    // Fallback: 写入 LRU 缓存或文件
    if (this.config.enableMemoryCache && this.eventsCache) {
      // 更新 LRU 缓存
      this.eventsCache.set(event.id, event);

      // 标记为脏数据
      let dirtySet = this.eventsDirty.get(dateStr);
      if (!dirtySet) {
        dirtySet = new Set();
        this.eventsDirty.set(dateStr, dirtySet);
      }
      dirtySet.add(event.id);
    } else {
      // 直接写入文件（兼容模式）
      const events = await this.readEventsFile(dateStr);

      const existingIndex = events.findIndex((e) => e.id === event.id);
      if (existingIndex >= 0) {
        events[existingIndex] = event;
      } else {
        events.push(event);
      }

      await this.writeEventsFile(dateStr, events);
    }
  }

  /**
   * 加载活跃告警到内存
   * Requirements: 9.2 - 当 DataStore 可用时从 alert_events 表读取
   */
  private async loadActiveAlerts(): Promise<void> {
    // PostgreSQL path (highest priority)
    if (this.usePg) {
      try {
        const rows = await this.pgDataStore!.query<{
          id: string;
          tenant_id: string;
          device_id: string | null;
          rule_id: string;
          severity: string;
          message: string;
          metric_value: number | null;
          status: string;
          acknowledged_at: string | null;
          resolved_at: string | null;
          created_at: string;
          notify_channels: string | null;
          auto_response_config: string | null;
        }>("SELECT * FROM alert_events WHERE status = 'active'");

        for (const row of rows) {
          const event = this.dbRowToAlertEvent(row);
          this.activeAlerts.set(event.id, event);
        }
        logger.info(`Loaded ${this.activeAlerts.size} active alerts from PostgreSQL`);
        return;
      } catch (error) {
        logger.warn('Failed to load active alerts from PostgreSQL, falling back:', error);
      }
    }

    // 1. 从 JSON 文件加载（Fallback）
    // 即使 DB 有数据，也检查文件，合并可能因 DB 写入失败而仅存在于文件中的活跃告警
    try {
      const now = Date.now();
      const sevenDaysAgo = now - 7 * 24 * 60 * 60 * 1000;
      const dates = this.getDateRange(sevenDaysAgo, now);
      let mergedFromFile = 0;

      for (const dateStr of dates) {
        let fileEvents: AlertEvent[] = [];
        const filePath = getEventsFilePath(dateStr);
        try {
          const data = await fs.readFile(filePath, 'utf-8');
          fileEvents = JSON.parse(data) as AlertEvent[];
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
            logger.error(`Failed to read alert events file ${dateStr}:`, error);
          }
          continue;
        }

        for (const event of fileEvents) {
          if (event.status === 'active') {
            if (!this.activeAlerts.has(event.id)) {
              this.activeAlerts.set(event.id, event);
              mergedFromFile++;
            } else {
              // 如果 DB 和文件都有，以 triggeredAt 较新的为准
              const existing = this.activeAlerts.get(event.id)!;
              if (event.triggeredAt > existing.triggeredAt) {
                this.activeAlerts.set(event.id, event);
                mergedFromFile++;
              }
            }
          }
        }
      }

      if (mergedFromFile > 0) {
        logger.info(`Merged ${mergedFromFile} additional/newer active alerts from JSON files`);
      }
    } catch (error) {
      logger.error('Failed to read active alerts from files:', error);
    }

    logger.info(`Total active alerts loaded: ${this.activeAlerts.size}`);
  }

  /**
   * 获取日期范围内的所有日期字符串 (使用 UTC 时间)
   */
  private getDateRange(from: number, to: number): string[] {
    const dates: string[] = [];

    // 使用 UTC 时间计算日期范围
    const fromDate = new Date(from);
    const toDate = new Date(to);

    // 获取 UTC 日期的开始
    const currentDate = new Date(Date.UTC(
      fromDate.getUTCFullYear(),
      fromDate.getUTCMonth(),
      fromDate.getUTCDate()
    ));

    // 获取 UTC 日期的结束
    const endDate = new Date(Date.UTC(
      toDate.getUTCFullYear(),
      toDate.getUTCMonth(),
      toDate.getUTCDate(),
      23, 59, 59, 999
    ));

    while (currentDate <= endDate) {
      dates.push(getDateString(currentDate.getTime()));
      currentDate.setUTCDate(currentDate.getUTCDate() + 1);
    }

    return dates;
  }

  // ==================== 规则管理 ====================

  /**
   * 创建告警规则
   * Requirements: 9.2 - 支持 tenant_id 和 device_id 关联
   */
  async createRule(input: CreateAlertRuleInput & { tenant_id?: string; device_id?: string | null }): Promise<AlertRule> {
    await this.initialize();

    const now = Date.now();
    const { tenant_id, device_id, ...ruleInput } = input;
    const rule: AlertRule & { tenant_id?: string; device_id?: string | null } = {
      id: uuidv4(),
      createdAt: now,
      updatedAt: now,
      ...ruleInput,
      tenant_id,
      device_id,
    };

    this.rules.push(rule);

    await this.saveRules();

    logger.info(`Created alert rule: ${rule.name} (${rule.id})`);
    return rule;
  }

  /**
   * 更新告警规则
   * Requirements: 9.2 - 当 DataStore 可用时更新 alert_rules 表
   */
  async updateRule(id: string, updates: UpdateAlertRuleInput): Promise<AlertRule> {
    await this.initialize();

    const index = this.rules.findIndex((r) => r.id === id);
    if (index === -1) {
      throw new Error(`Alert rule not found: ${id}`);
    }

    const rule = this.rules[index];
    const updatedRule: AlertRule = {
      ...rule,
      ...updates,
      updatedAt: Date.now(),
    };

    this.rules[index] = updatedRule;

    await this.saveRules();

    logger.info(`Updated alert rule: ${updatedRule.name} (${id})`);
    return updatedRule;
  }

  /**
   * 删除告警规则
   * Requirements: 9.2 - 当 DataStore 可用时从 alert_rules 表删除
   */
  async deleteRule(id: string): Promise<void> {
    await this.initialize();

    const index = this.rules.findIndex((r) => r.id === id);
    if (index === -1) {
      throw new Error(`Alert rule not found: ${id}`);
    }

    const rule = this.rules[index];
    this.rules.splice(index, 1);

    await this.saveRules();

    // 清理触发状态
    this.triggerStates.delete(id);

    logger.info(`Deleted alert rule: ${rule.name} (${id})`);
  }

  /**
   * 获取告警规则列表
   * @param deviceId 可选的设备 ID 过滤
   */
  async getRules(deviceId?: string): Promise<AlertRule[]> {
    await this.initialize();
    if (deviceId) {
      return this.rules.filter(r => !r.deviceId || r.deviceId === deviceId);
    }
    return [...this.rules];
  }

  /**
   * 根据 ID 获取告警规则
   */
  async getRuleById(id: string): Promise<AlertRule | null> {
    await this.initialize();
    return this.rules.find((r) => r.id === id) || null;
  }

  /**
   * 启用告警规则
   */
  async enableRule(id: string): Promise<void> {
    await this.updateRule(id, { enabled: true });
    logger.info(`Enabled alert rule: ${id}`);
  }

  /**
   * 禁用告警规则
   */
  async disableRule(id: string): Promise<void> {
    await this.updateRule(id, { enabled: false });
    // 清理触发状态
    this.triggerStates.delete(id);

    // 自动解决该规则的所有活跃告警
    await this.resolveAlertsForRule(id, 'rule_disabled');

    logger.info(`Disabled alert rule: ${id}`);
  }

  /**
   * 解决指定规则的所有活跃告警
   * @param ruleId 规则 ID
   * @param reason 解决原因
   */
  private async resolveAlertsForRule(ruleId: string, reason: string): Promise<void> {
    const now = Date.now();
    const alertsToResolve: AlertEvent[] = [];

    // 找出该规则的所有活跃告警
    for (const [eventId, event] of this.activeAlerts) {
      if (event.ruleId === ruleId && event.status === 'active') {
        alertsToResolve.push(event);
      }
    }

    // 解决这些告警
    for (const event of alertsToResolve) {
      event.status = 'resolved';
      event.resolvedAt = now;

      await this.saveEvent(event);
      this.activeAlerts.delete(event.id);

      // 清除指纹缓存，允许同样的告警再次触发
      const fingerprint = fingerprintCache.generateFingerprint(event);
      fingerprintCache.delete(fingerprint);
      logger.debug(`Fingerprint cleared for rule-disabled alert: ${fingerprint}`);

      // 记录审计日志
      await auditLogger.log({
        action: 'alert_resolve',
        actor: 'system',
        details: {
          trigger: reason,
          metadata: {
            eventId: event.id,
            ruleId: event.ruleId,
            ruleName: event.ruleName,
          },
        },
      });

      logger.info(`Alert auto-resolved due to ${reason}: ${event.ruleName} (${event.id})`);
    }

    if (alertsToResolve.length > 0) {
      logger.info(`Resolved ${alertsToResolve.length} active alerts for rule ${ruleId} (reason: ${reason})`);
    }
  }


  // ==================== 告警评估 ====================

  /**
   * 评估条件运算符
   */
  evaluateCondition(value: number, operator: AlertOperator, threshold: number): boolean {
    switch (operator) {
      case 'gt':
        return value > threshold;
      case 'lt':
        return value < threshold;
      case 'eq':
        return value === threshold;
      case 'ne':
        return value !== threshold;
      case 'gte':
        return value >= threshold;
      case 'lte':
        return value <= threshold;
      default:
        logger.warn(`Unknown operator: ${operator}`);
        return false;
    }
  }

  /**
   * 从指标数据中获取指定指标的值
   */
  private getMetricValue(
    metrics: { system: SystemMetrics; interfaces: InterfaceMetrics[] },
    metricType: MetricType,
    metricLabel?: string
  ): number | null {
    switch (metricType) {
      case 'cpu':
        return metrics.system.cpu.usage;
      case 'memory':
        return metrics.system.memory.usage;
      case 'disk':
        return metrics.system.disk.usage;
      case 'interface_status': {
        if (!metricLabel) return null;
        const iface = metrics.interfaces.find((i) => i.name === metricLabel);
        if (!iface) return null;
        // 返回 1 表示 up，0 表示 down
        return iface.status === 'up' ? 1 : 0;
      }
      case 'interface_traffic': {
        if (!metricLabel) {
          logger.warn('[interface_traffic] metricLabel is required but not provided');
          return null;
        }
        // 获取最近的流量速率数据（最近 30 秒的平均值）
        const historyRecord = metricsCollector.getTrafficHistory([metricLabel], undefined, 30000);
        const trafficHistory = historyRecord[metricLabel] || [];

        if (trafficHistory.length === 0) {
          // 如果没有速率数据，尝试获取更长时间范围的数据
          const extendedRecord = metricsCollector.getTrafficHistory([metricLabel], undefined, 120000); // 2分钟
          const extendedHistory = extendedRecord[metricLabel] || [];

          if (extendedHistory.length === 0) {
            // 检查接口是否存在于可用列表中
            const availableInterfaces = metricsCollector.getAvailableTrafficInterfaces();
            if (!availableInterfaces.includes(metricLabel)) {
              logger.warn(`[interface_traffic] Interface "${metricLabel}" not found in available interfaces: [${availableInterfaces.join(', ')}]`);
            } else {
              logger.debug(`[interface_traffic] No traffic rate data yet for interface ${metricLabel}, waiting for data collection`);
            }
            return null;
          }
          // 使用扩展时间范围的数据
          const avgRate = extendedHistory.reduce((sum, p) => sum + p.rxRate + p.txRate, 0) / extendedHistory.length;
          return avgRate / 1024;
        }
        // 计算平均速率（rx + tx，单位：bytes/s）
        const avgRate = trafficHistory.reduce((sum, p) => sum + p.rxRate + p.txRate, 0) / trafficHistory.length;
        // 转换为 KB/s 以便更合理的阈值设置
        return avgRate / 1024;
      }
      default:
        return null;
    }
  }

  /**
   * 获取接口状态字符串
   */
  private getInterfaceStatus(
    metrics: { system: SystemMetrics; interfaces: InterfaceMetrics[] },
    metricLabel?: string
  ): InterfaceStatusTarget | null {
    if (!metricLabel) return null;
    const iface = metrics.interfaces.find((i) => i.name === metricLabel);
    if (!iface) return null;
    return iface.status as InterfaceStatusTarget;
  }

  /**
   * 评估接口状态条件
   * 当接口当前状态等于目标状态时返回 true（触发告警）
   * 
   * 逻辑说明：
   * - targetStatus: 'down' 表示"当接口断开时触发告警"
   * - targetStatus: 'up' 表示"当接口连接时触发告警"（较少使用）
   * - 所以当 currentStatus === targetStatus 时应该触发告警
   */
  private evaluateInterfaceStatus(
    currentStatus: InterfaceStatusTarget,
    targetStatus: InterfaceStatusTarget
  ): boolean {
    // 当前状态等于目标状态时触发告警
    // 例如：targetStatus='down' 且 currentStatus='down' 时触发
    return currentStatus === targetStatus;
  }

  /**
   * 检查规则是否在冷却期内
   */
  private isInCooldown(rule: AlertRule): boolean {
    if (!rule.lastTriggeredAt || rule.cooldownMs <= 0) {
      return false;
    }
    const elapsed = Date.now() - rule.lastTriggeredAt;
    return elapsed < rule.cooldownMs;
  }

  /**
   * 更新规则触发状态
   */
  private updateTriggerState(ruleId: string, triggered: boolean): RuleTriggerState {
    const now = Date.now();
    const existing = this.triggerStates.get(ruleId);

    if (triggered) {
      const state: RuleTriggerState = {
        ruleId,
        consecutiveCount: (existing?.consecutiveCount || 0) + 1,
        lastEvaluatedAt: now,
      };
      this.triggerStates.set(ruleId, state);
      return state;
    } else {
      // 条件不满足，重置计数
      const state: RuleTriggerState = {
        ruleId,
        consecutiveCount: 0,
        lastEvaluatedAt: now,
      };
      this.triggerStates.set(ruleId, state);
      return state;
    }
  }

  /**
   * 评估所有告警规则
   */
  async evaluate(
    metrics: { system: SystemMetrics; interfaces: InterfaceMetrics[] },
    deviceId?: string
  ): Promise<AlertEvent[]> {
    await this.initialize();

    const triggeredEvents: AlertEvent[] = [];
    const now = Date.now();

    // 添加调试日志：显示当前评估的规则数量
    logger.info(`Alert evaluation started: ${this.rules.length} rules to evaluate (deviceId: ${deviceId || 'global'})`);

    // 检查告警恢复
    await this.checkAlertRecovery(metrics, deviceId);

    // 评估每个启用的规则
    for (const rule of this.rules) {
      if (!rule.enabled) continue;

      // Filter by deviceId (Requirements: 9.2)
      // If rule has specific deviceId, it must match.
      // If rule has no deviceId (global), it applies to all devices? 
      // Or if rule has no deviceId, it applies to 'default' device?
      // Typically global rules (e.g. standard thresholds) apply to all devices unless overridden.
      // But implementation simplicity: 
      // If rule.deviceId is set, it ONLY applies when evaluating that device.
      // If rule.deviceId is NOT set, it applies to ALL devices.
      if (rule.deviceId && rule.deviceId !== deviceId) {
        continue;
      }

      // 检查冷却期
      if (this.isInCooldown(rule)) {
        logger.debug(`Rule ${rule.name} is in cooldown period`);
        continue;
      }

      let conditionMet = false;
      let currentValue = 0;

      // 根据指标类型选择不同的评估逻辑
      if (rule.metric === 'interface_status') {
        // 接口状态类型：使用状态匹配而非数值比较
        const currentStatus = this.getInterfaceStatus(metrics, rule.metricLabel);
        if (currentStatus === null) {
          logger.warn(`[interface_status] Rule ${rule.name}: Could not get interface status for ${rule.metricLabel}`);
          continue;
        }

        // 如果没有配置 targetStatus，默认为 'down'（即当接口 down 时触发告警）
        const targetStatus = rule.targetStatus || 'down';
        conditionMet = this.evaluateInterfaceStatus(currentStatus, targetStatus);
        // 用于告警事件记录：1 表示 up，0 表示 down
        currentValue = currentStatus === 'up' ? 1 : 0;

        // 添加详细日志
        logger.info(`[interface_status] Rule ${rule.name}: interface=${rule.metricLabel}, currentStatus=${currentStatus}, targetStatus=${targetStatus}, conditionMet=${conditionMet}`);
      } else if (rule.metric === 'interface_traffic') {
        // 接口流量类型：添加详细日志
        const value = this.getMetricValue(metrics, rule.metric, rule.metricLabel);
        if (value === null) {
          logger.warn(`[interface_traffic] Rule ${rule.name}: Could not get traffic value for ${rule.metricLabel}`);
          continue;
        }
        currentValue = value;
        conditionMet = this.evaluateCondition(value, rule.operator, rule.threshold);
        logger.info(`[interface_traffic] Rule ${rule.name}: interface=${rule.metricLabel}, currentValue=${value.toFixed(2)} KB/s, threshold=${rule.threshold}, conditionMet=${conditionMet}`);
      } else {
        // 数值型指标：使用数值比较
        const value = this.getMetricValue(metrics, rule.metric, rule.metricLabel);
        if (value === null) {
          logger.debug(`Could not get metric value for rule ${rule.name}`);
          continue;
        }
        currentValue = value;
        conditionMet = this.evaluateCondition(value, rule.operator, rule.threshold);
      }

      // 更新触发状态
      const state = this.updateTriggerState(rule.id, conditionMet);

      // 检查是否达到持续时间阈值
      if (conditionMet && state.consecutiveCount >= rule.duration) {
        // 检查是否已有该规则的活跃告警
        const existingAlert = Array.from(this.activeAlerts.values()).find(
          (a) => a.ruleId === rule.id && a.status === 'active'
        );

        if (!existingAlert) {
          // 创建临时告警对象用于指纹检查
          // Requirements: 8.1 - 包含 metricLabel 字段
          const tempAlert: AlertEvent = {
            id: '',
            tenantId: rule.tenantId,
            deviceId: rule.deviceId,
            ruleId: rule.id,
            ruleName: rule.name,
            severity: rule.severity,
            metric: rule.metric,
            metricLabel: rule.metricLabel,  // 从规则复制指标标签
            currentValue,
            threshold: rule.threshold,
            message: this.buildAlertMessage(rule, currentValue),
            status: 'active',
            triggeredAt: now,
          };

          // 生成指纹并检查是否重复
          const fingerprint = fingerprintCache.generateFingerprint(tempAlert);

          if (fingerprintCache.exists(fingerprint)) {
            // 指纹存在且在冷却期内，抑制重复告警
            fingerprintCache.set(fingerprint); // 更新 lastSeen 和 count
            logger.info(`Alert suppressed by fingerprint deduplication: ${rule.name} (fingerprint: ${fingerprint})`);
            continue;
          }

          // 创建新告警
          const event = await this.createAlertEvent(rule, currentValue, metrics.system);

          // 添加指纹到缓存
          fingerprintCache.set(fingerprint);

          triggeredEvents.push(event);

          // 更新规则最后触发时间
          await this.updateRule(rule.id, { lastTriggeredAt: now });

          // 重置触发计数
          this.triggerStates.set(rule.id, {
            ruleId: rule.id,
            consecutiveCount: 0,
            lastEvaluatedAt: now,
          });
        }
      }
    }

    return triggeredEvents;
  }


  // ==================== 告警触发和通知 ====================

  /**
   * 创建告警事件
   */
  private async createAlertEvent(
    rule: AlertRule,
    currentValue: number,
    systemMetrics: SystemMetrics
  ): Promise<AlertEvent> {
    const now = Date.now();

    // Enrich with device info (Requirements: 8.1 - 增强告警上下文)
    let deviceName: string | undefined;
    let deviceIp: string | undefined;

    if (rule.deviceId) {
      try {
        // DeviceManager is a core service, should be available
        const deviceManager = serviceRegistry.get('deviceManager') as DeviceManager;
        const device = await deviceManager.getDevice(rule.tenantId || '', rule.deviceId);
        if (device) {
          deviceName = device.name;
          deviceIp = device.host;
        }
      } catch (error) {
        logger.warn(`Failed to fetch device info for alert enrichment: ${error}`);
      }
    }

    // 构建告警消息
    const message = this.buildAlertMessage(rule, currentValue);

    // 创建告警事件
    // Requirements: 8.1 - 包含 metricLabel 字段以支持接口级别的告警
    const event: AlertEvent = {
      id: uuidv4(),
      tenantId: rule.tenantId,
      deviceId: rule.deviceId,
      ruleId: rule.id,
      ruleName: rule.name,
      severity: rule.severity,
      metric: rule.metric,
      metricLabel: rule.metricLabel,  // 从规则复制指标标签
      currentValue,
      threshold: rule.threshold,
      deviceName,
      deviceIp,
      message,
      status: 'active',
      triggeredAt: now,
      // Carry over configuration for pipeline processing (Requirements: 2.x - System Association)
      notifyChannels: rule.channels,
      autoResponseConfig: rule.autoResponse,
    };

    // 尝试获取 AI 分析（如果可用）
    try {
      const aiAnalysis = await this.getAIAnalysis(event, systemMetrics);
      if (aiAnalysis) {
        event.aiAnalysis = aiAnalysis;
      }
    } catch (error) {
      logger.warn('Failed to get AI analysis for alert:', error);
    }

    // 保存告警事件
    await this.saveEvent(event);
    this.activeAlerts.set(event.id, event);

    // 记录审计日志
    await auditLogger.log({
      tenantId: rule.tenantId,
      deviceId: rule.deviceId,
      action: 'alert_trigger',
      actor: 'system',
      details: {
        trigger: rule.name,
        metadata: {
          eventId: event.id,
          ruleId: rule.id,
          metric: rule.metric,
          currentValue,
          threshold: rule.threshold,
          severity: rule.severity,
        },
      },
    });

    // 执行自动响应（如果配置）
    if (rule.autoResponse?.enabled && rule.autoResponse.script) {
      await this.executeAutoResponse(event, rule);
    }

    // 调用告警处理流水线进行完整的 AI 智能处理（带并发控制）
    // Requirements: 4.1, 5.1, 6.1, 8.1 - 归一化 → 去重 → 过滤 → 分析 → 决策
    // 注意：通知由流水线中的决策引擎统一处理，避免重复通知
    // 使用并发控制防止 CPU 飙升
    this.enqueuePipelineProcess(event, rule);

    logger.info(`Alert triggered: ${rule.name} (${event.id})`);
    return event;
  }

  /**
   * 构建告警消息
   */
  private buildAlertMessage(rule: AlertRule, currentValue: number): string {
    const operatorText: Record<AlertOperator, string> = {
      gt: '大于',
      lt: '小于',
      eq: '等于',
      ne: '不等于',
      gte: '大于等于',
      lte: '小于等于',
    };

    const metricText: Record<MetricType, string> = {
      cpu: 'CPU 使用率',
      memory: '内存使用率',
      disk: '磁盘使用率',
      interface_status: '接口状态',
      interface_traffic: '接口流量',
      syslog: 'Syslog 事件',
    };

    const metric = metricText[rule.metric] || rule.metric;
    const label = rule.metricLabel ? ` (${rule.metricLabel})` : '';

    // 接口状态类型使用不同的消息格式
    if (rule.metric === 'interface_status') {
      const currentStatus = currentValue === 1 ? 'up' : 'down';
      const targetStatus = rule.targetStatus || 'up';
      const targetStatusText = targetStatus === 'up' ? '连接' : '断开';
      const currentStatusText = currentStatus === 'up' ? '连接' : '断开';
      return `${metric}${label} 当前状态为 ${currentStatusText}，期望状态为 ${targetStatusText}`;
    }

    const operator = operatorText[rule.operator] || rule.operator;
    return `${metric}${label} 当前值 ${currentValue} ${operator} 阈值 ${rule.threshold}`;
  }

  /**
   * 获取 AI 分析（占位实现，后续集成 AIAnalyzer）
   */
  private async getAIAnalysis(
    event: AlertEvent,
    systemMetrics: SystemMetrics
  ): Promise<string | undefined> {
    // TODO: 集成 AIAnalyzer 服务
    // 目前返回基础分析
    const severityText: Record<AlertSeverity, string> = {
      info: '信息',
      warning: '警告',
      critical: '严重',
      emergency: '紧急',
    };

    return `[${severityText[event.severity]}] ${event.message}。建议检查相关配置和系统状态。`;
  }

  /**
   * 发送告警通知
   */
  private async sendAlertNotification(event: AlertEvent, rule: AlertRule): Promise<void> {
    if (!rule.channels || rule.channels.length === 0) {
      logger.debug(`No notification channels configured for rule: ${rule.name}`);
      return;
    }

    const severityText: Record<AlertSeverity, string> = {
      info: '📢 信息',
      warning: '⚠️ 警告',
      critical: '🔴 严重',
      emergency: '🚨 紧急',
    };

    try {
      await notificationService.send(rule.channels, {
        type: 'alert',
        title: `${severityText[event.severity]} - ${rule.name}`,
        body: `设备: ${event.deviceName || 'Unknown'} (${event.deviceIp || 'Unknown'})\n` +
          `告警: ${event.message}` +
          (event.aiAnalysis ? `\n\nAI 分析: ${event.aiAnalysis}` : ''),
        data: {
          eventId: event.id,
          ruleId: rule.id,
          severity: event.severity,
          metric: event.metric,
          currentValue: event.currentValue,
          threshold: event.threshold,
          deviceName: event.deviceName || 'Unknown',
          deviceIp: event.deviceIp || 'Unknown',
        },
      });
      logger.info(`Alert notification sent for: ${rule.name}`);
    } catch (error) {
      logger.error(`Failed to send alert notification for ${rule.name}:`, error);
    }
  }

  // ==================== Pipeline 并发控制 ====================
  // 使用增强的并发控制器
  // Requirements: 2.1, 2.2, 2.4, 2.6

  /**
   * 将 pipeline 处理加入队列（使用增强的并发控制器）
   * Requirements: 2.2, 2.4 - 优先级队列和并发控制
   * @param event 告警事件
   * @param rule 告警规则
   * @param priority 优先级（数字越小优先级越高，默认根据严重级别计算）
   */
  private enqueuePipelineProcess(event: AlertEvent, rule: AlertRule, priority?: number): void {
    if (!this.pipelineController) {
      logger.error('Pipeline controller not initialized');
      return;
    }

    // 根据告警严重级别计算优先级（如果未指定）
    // emergency: 1, critical: 2, warning: 3, info: 4
    const severityPriority: Record<string, number> = {
      emergency: 1,
      critical: 2,
      warning: 3,
      info: 4,
    };
    const taskPriority = priority ?? severityPriority[event.severity] ?? 5;

    // 使用并发控制器入队
    this.pipelineController.enqueue({ event, rule }, taskPriority)
      .catch(error => {
        logger.warn(`Pipeline processing failed for event ${event.id}:`, error);
        // 降级处理：发送基础通知
        this.sendAlertNotification(event, rule).catch(notifyError => {
          logger.error('Failed to send fallback notification:', notifyError);
        });
      });
  }

  /**
   * 处理 Pipeline 任务（由并发控制器调用）
   * Requirements: 2.1 - 超时保护由并发控制器处理
   * Requirements: RAG 集成 - 处理完成后索引到知识库
   */
  private async processPipelineTask(event: AlertEvent, rule: AlertRule): Promise<void> {
    logger.debug(`Pipeline processing started for event ${event.id}`);

    try {
      const pipelineResult = await alertPipeline.process(event);
      this.emitPreprocessedEvent(pipelineResult.event);

      // 记录流水线处理结果
      if (pipelineResult.filtered) {
        logger.info(`Alert filtered by pipeline: ${event.id}, reason: ${pipelineResult.filterResult?.reason}`);
      } else if (pipelineResult.decision) {
        logger.info(`Alert decision made: ${event.id}, action: ${pipelineResult.decision.action}`);

        // RAG 集成：将处理完成的告警索引到知识库
        // 只有未被过滤且有决策结果的告警才索引
        try {
          await knowledgeBase.indexAlert(event, pipelineResult.analysis);
          logger.debug(`Alert indexed to knowledge base: ${event.id}`);
        } catch (indexError) {
          logger.warn(`Failed to index alert to knowledge base: ${event.id}`, indexError);
        }
      }
    } catch (error) {
      logger.warn('Failed to process alert through pipeline:', error);
      // 降级处理：流水线失败时才发送基础通知
      await this.sendAlertNotification(event, rule);
      // 仅进行预处理
      try {
        const preprocessedEvent = await alertPreprocessor.process(event);
        this.emitPreprocessedEvent(preprocessedEvent);
      } catch (preprocessError) {
        logger.warn('Failed to preprocess alert event:', preprocessError);
      }
    }

    logger.debug(`Pipeline processing completed for event ${event.id}`);
  }

  /**
   * 获取 pipeline 并发状态（用于监控）
   * Requirements: 2.5 - 提供 Pipeline 并发状态监控接口
   */
  getPipelineConcurrencyStatus(): ConcurrencyStatus {
    if (!this.pipelineController) {
      return {
        active: 0,
        queued: 0,
        maxConcurrent: this.config.maxConcurrentPipeline,
        queueCapacity: this.config.maxQueueSize,
        queueUsagePercent: 0,
        isPaused: false,
        isBackpressureActive: false,
        avgProcessingTimeMs: 0,
        totalProcessed: 0,
        totalDropped: 0,
        totalTimedOut: 0,
      };
    }
    return this.pipelineController.getStatus();
  }

  /**
   * 获取 Pipeline 状态（简化版，向后兼容）
   */
  getPipelineStatus(): {
    active: number;
    queued: number;
    maxConcurrent: number;
    queueCapacity: number;
    queueUsagePercent: number;
    avgProcessingTimeMs: number;
    totalProcessed: number;
    totalDropped: number;
    totalTimedOut: number;
  } {
    const status = this.getPipelineConcurrencyStatus();
    return {
      active: status.active,
      queued: status.queued,
      maxConcurrent: status.maxConcurrent,
      queueCapacity: status.queueCapacity,
      queueUsagePercent: status.queueUsagePercent,
      avgProcessingTimeMs: status.avgProcessingTimeMs,
      totalProcessed: status.totalProcessed,
      totalDropped: status.totalDropped,
      totalTimedOut: status.totalTimedOut,
    };
  }


  // ==================== 告警恢复 ====================

  /**
   * 检查告警恢复
   */
  private async checkAlertRecovery(
    metrics: { system: SystemMetrics; interfaces: InterfaceMetrics[] },
    deviceId?: string
  ): Promise<void> {
    const now = Date.now();

    for (const [eventId, event] of this.activeAlerts) {
      if (event.status !== 'active') continue;

      // Filter by deviceId to avoid cross-device contamination
      // If event has deviceId, it must match current deviceId
      if (event.deviceId && event.deviceId !== deviceId) {
        continue;
      }
      // If event has no deviceId (global/legacy), and we are checking a specific device...
      // This is tricky. Legacy alerts might be global.
      // But usually alerts are bound to a device context implicitly if not explicitly.
      // For now, if event.deviceId is missing, we assume it matches 'global' context or we just process it?
      // If we process it with specific device metrics, we might resolve it incorrectly via that device's metrics.
      // Safest: Only process if event.deviceId matches passed deviceId (including both undefined).
      if (event.deviceId !== deviceId) {
        // Strict matching: undefined === undefined, 'A' === 'A'
        // If event.deviceId is undefined (global) but deviceId is 'A', skip?
        // If we allow global alerts to be resolved by any device, that's risky.
        // Let's enforce strict match for now.
        continue;
      }

      // 获取对应的规则
      const rule = this.rules.find((r) => r.id === event.ruleId);
      if (!rule) {
        // 规则已删除，自动解决告警
        await this.resolveAlert(eventId);
        continue;
      }

      // 如果规则已禁用，自动解决告警（不发送恢复通知）
      if (!rule.enabled) {
        event.status = 'resolved';
        event.resolvedAt = now;

        await this.saveEvent(event);
        this.activeAlerts.delete(eventId);

        // 清除指纹缓存，允许同样的告警再次触发
        const fingerprint = fingerprintCache.generateFingerprint(event);
        fingerprintCache.delete(fingerprint);
        logger.debug(`Fingerprint cleared for rule-disabled alert: ${fingerprint}`);

        // 记录审计日志
        await auditLogger.log({
          action: 'alert_resolve',
          actor: 'system',
          details: {
            trigger: 'rule_disabled',
            metadata: {
              eventId: event.id,
              ruleId: rule.id,
              ruleName: rule.name,
            },
          },
        });

        logger.info(`Alert auto-resolved (rule disabled): ${rule.name} (${eventId})`);
        continue;
      }

      let conditionMet = false;

      // 根据指标类型选择不同的评估逻辑
      if (rule.metric === 'interface_status') {
        // 接口状态类型：使用状态匹配
        const currentStatus = this.getInterfaceStatus(metrics, rule.metricLabel);
        if (currentStatus === null) {
          logger.debug(`[recovery] Could not get interface status for ${rule.metricLabel}, skipping recovery check`);
          continue;
        }

        // 重要：恢复检查时使用与触发时相同的 targetStatus 默认值 'down'
        // 这样当接口从 down 恢复到 up 时，conditionMet 会变为 false，触发恢复
        const targetStatus = rule.targetStatus || 'down';
        conditionMet = this.evaluateInterfaceStatus(currentStatus, targetStatus);

        logger.debug(`[recovery] Rule ${rule.name}: interface=${rule.metricLabel}, currentStatus=${currentStatus}, targetStatus=${targetStatus}, conditionMet=${conditionMet}`);
      } else if (rule.metric === 'interface_traffic') {
        // 接口流量类型：使用数值比较
        const currentValue = this.getMetricValue(metrics, rule.metric, rule.metricLabel);
        if (currentValue === null) {
          logger.debug(`[recovery] Could not get traffic value for ${rule.metricLabel}, skipping recovery check`);
          continue;
        }

        conditionMet = this.evaluateCondition(currentValue, rule.operator, rule.threshold);
        logger.debug(`[recovery] Rule ${rule.name}: interface=${rule.metricLabel}, currentValue=${currentValue.toFixed(2)} KB/s, threshold=${rule.threshold}, conditionMet=${conditionMet}`);
      } else {
        // 数值型指标：使用数值比较
        const currentValue = this.getMetricValue(metrics, rule.metric, rule.metricLabel);
        if (currentValue === null) continue;

        conditionMet = this.evaluateCondition(currentValue, rule.operator, rule.threshold);
      }

      if (!conditionMet) {
        // 条件不再满足，告警恢复
        event.status = 'resolved';
        event.resolvedAt = now;

        await this.saveEvent(event);
        this.activeAlerts.delete(eventId);

        // 清除指纹缓存，允许同样的告警再次触发
        const fingerprint = fingerprintCache.generateFingerprint(event);
        fingerprintCache.delete(fingerprint);
        logger.debug(`Fingerprint cleared for recovered alert: ${fingerprint}`);

        // 索引到知识库 (Requirements: 3.1 - 告警解决时自动索引)
        // Note: aiAnalysis is a string summary, not a RootCauseAnalysis object
        try {
          await knowledgeBase.indexAlert(event);
          logger.debug(`Alert indexed to knowledge base: ${event.id}`);
        } catch (error) {
          logger.warn(`Failed to index alert to knowledge base: ${event.id}`, error);
        }

        // 记录审计日志
        await auditLogger.log({
          action: 'alert_resolve',
          actor: 'system',
          details: {
            trigger: 'auto_recovery',
            metadata: {
              eventId: event.id,
              ruleId: rule.id,
              ruleName: rule.name,
            },
          },
        });

        // 发送恢复通知
        await this.sendRecoveryNotification(event, rule);

        logger.info(`Alert recovered: ${rule.name} (${eventId})`);
      }
    }
  }

  /**
   * 发送恢复通知
   */
  private async sendRecoveryNotification(event: AlertEvent, rule: AlertRule): Promise<void> {
    if (!rule.channels || rule.channels.length === 0) {
      return;
    }

    try {
      await notificationService.send(rule.channels, {
        type: 'recovery',
        title: `✅ 已恢复 - ${rule.name}`,
        body: `告警已恢复: ${event.message}`,
        data: {
          eventId: event.id,
          ruleId: rule.id,
          severity: event.severity,
          resolvedAt: event.resolvedAt,
          deviceName: event.deviceName || 'Unknown',
          deviceIp: event.deviceIp || 'Unknown',
        },
      });
      logger.info(`Recovery notification sent for: ${rule.name}`);
    } catch (error) {
      logger.error(`Failed to send recovery notification for ${rule.name}:`, error);
    }
  }

  // ==================== 自动响应 ====================

  /**
   * 执行自动响应脚本
   * Requirements: G4.12 - 通过 DeviceManager 执行设备操作，替代直接 API 调用
   */
  private async executeAutoResponse(event: AlertEvent, rule: AlertRule): Promise<void> {
    if (!rule.autoResponse?.script) return;

    const script = rule.autoResponse.script;
    const deviceId = event.deviceId || rule.deviceId;

    // 记录执行意图到审计日志
    await auditLogger.log({
      action: 'script_execute',
      actor: 'system',
      details: {
        trigger: `auto_response:${rule.name}`,
        script,
        metadata: {
          eventId: event.id,
          ruleId: rule.id,
        },
      },
    });

    try {
      // 检查 DeviceManager 是否可用
      if (!this.deviceManager) {
        logger.warn('DeviceManager not available, skipping auto-response execution');
        throw new Error('DeviceManager not configured');
      }

      if (!deviceId) {
        logger.warn('No deviceId available for auto-response, skipping execution');
        throw new Error('No deviceId available for auto-response');
      }

      // 通过 DeviceManager 执行脚本
      const output = await this.executeScript(script, deviceId);

      // 更新告警事件
      event.autoResponseResult = {
        executed: true,
        success: true,
        output,
      };
      await this.saveEvent(event);

      // 记录执行结果到审计日志
      await auditLogger.log({
        action: 'script_execute',
        actor: 'system',
        details: {
          trigger: `auto_response:${rule.name}`,
          result: 'success',
          metadata: {
            eventId: event.id,
            ruleId: rule.id,
            output,
          },
        },
      });

      logger.info(`Auto-response executed successfully for: ${rule.name}`);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);

      // 更新告警事件
      event.autoResponseResult = {
        executed: true,
        success: false,
        error: errorMessage,
      };
      await this.saveEvent(event);

      // 记录执行失败到审计日志
      await auditLogger.log({
        action: 'script_execute',
        actor: 'system',
        details: {
          trigger: `auto_response:${rule.name}`,
          result: 'failed',
          error: errorMessage,
          metadata: {
            eventId: event.id,
            ruleId: rule.id,
          },
        },
      });

      // 发送执行失败通知
      await this.sendAutoResponseFailureNotification(event, rule, errorMessage);

      logger.error(`Auto-response failed for ${rule.name}:`, error);
    }
  }

  /**
   * 通过 DeviceManager 执行脚本
   * Requirements: G4.12 - DeviceDriver 处理命令格式转换，上层无需关心具体协议
   * @param script 脚本内容（多行命令）
   * @param deviceId 目标设备 ID
   */
  private async executeScript(script: string, deviceId: string): Promise<string> {
    if (!this.deviceManager) {
      throw new Error('DeviceManager not configured');
    }

    const lines = script
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith('#'));

    const outputs: string[] = [];

    for (const line of lines) {
      try {
        // 通过 DeviceManager 查找设备并执行命令
        // DeviceDriver 内部处理命令格式转换（如 CLI → API 格式）
        const device = await this.deviceManager.findDeviceByIdAcrossTenants(deviceId);
        if (!device) {
          throw new Error(`Device not found: ${deviceId}`);
        }

        // 使用 DeviceDriver 的 execute 接口执行命令
        // 获取 serviceRegistry 中注册的 driverRegistry 来执行
        const driverRegistry = serviceRegistry.get('driverRegistry') as any;
        if (driverRegistry && typeof driverRegistry.execute === 'function') {
          const result = await driverRegistry.execute(deviceId, 'execute', { commands: [line] });
          if (result?.data) {
            outputs.push(typeof result.data === 'string' ? result.data : JSON.stringify(result.data, null, 2));
          }
        } else {
          // Fallback: 直接通过 serviceRegistry 获取可用的执行方式
          logger.warn(`DriverRegistry not available, command skipped: ${line}`);
        }
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        throw new Error(`命令 "${line}" 执行失败: ${errorMessage}`);
      }
    }

    return outputs.join('\n') || '命令执行成功';
  }

  /**
   * 发送自动响应失败通知
   */
  private async sendAutoResponseFailureNotification(
    event: AlertEvent,
    rule: AlertRule,
    error: string
  ): Promise<void> {
    if (!rule.channels || rule.channels.length === 0) {
      return;
    }

    try {
      await notificationService.send(rule.channels, {
        type: 'alert',
        title: `❌ 自动响应失败 - ${rule.name}`,
        body: `自动响应脚本执行失败: ${error}\n\n原始告警: ${event.message}`,
        data: {
          eventId: event.id,
          ruleId: rule.id,
          error,
        },
      });
    } catch (notifyError) {
      logger.error(`Failed to send auto-response failure notification:`, notifyError);
    }
  }


  // ==================== 告警事件管理 ====================

  /**
   * 获取活跃告警
   */
  async getActiveAlerts(deviceId?: string): Promise<AlertEvent[]> {
    await this.initialize();
    const alerts = Array.from(this.activeAlerts.values());
    if (deviceId) {
      return alerts.filter(a => a.deviceId === deviceId);
    }
    return alerts;
  }

  /**
   * 清理指定设备的所有活跃告警（内存缓存 + JSON 文件）
   * 在设备被删除时调用，防止 Brain 拿到已删除设备的残留告警后
   * 用过期的 deviceId 调用 execute_intent 导致 PARAM_VALIDATION 失败。
   *
   * 清理范围：
   * 1. 内存 activeAlerts Map（立即生效，阻止当前运行的 Brain tick）
   * 2. JSON 事件文件（防止重启后 loadActiveAlerts 重新加载残留告警）
   * 注：DataStore (PostgreSQL) 中的 alert_events 已由 deviceManager.deleteDevice 事务级联清理
   */
  clearAlertsForDevice(deviceId: string): number {
    // 1. 清理内存缓存
    let cleared = 0;
    const affectedDates = new Set<string>();
    for (const [id, alert] of this.activeAlerts) {
      if (alert.deviceId === deviceId) {
        affectedDates.add(getDateString(alert.triggeredAt));
        this.activeAlerts.delete(id);
        cleared++;
      }
    }
    if (cleared > 0) {
      logger.info(`[AlertEngine] Cleared ${cleared} active alert(s) from memory for deleted device ${deviceId}`);
    }

    // 2. 异步清理 JSON 文件（不阻塞删除设备的响应）
    if (affectedDates.size > 0) {
      this.purgeDeviceFromEventFiles(deviceId, affectedDates).catch(err => {
        logger.warn(`[AlertEngine] Failed to purge device ${deviceId} from event files:`, err);
      });
    }

    return cleared;
  }

  /**
   * 从 JSON 事件文件中移除指定设备的告警记录
   */
  private async purgeDeviceFromEventFiles(deviceId: string, dates: Set<string>): Promise<void> {
    for (const dateStr of dates) {
      const filePath = getEventsFilePath(dateStr);
      try {
        const data = await fs.readFile(filePath, 'utf-8');
        const events = JSON.parse(data) as AlertEvent[];
        const filtered = events.filter(e => e.deviceId !== deviceId);
        if (filtered.length < events.length) {
          await fs.writeFile(filePath, JSON.stringify(filtered, null, 2), 'utf-8');
          logger.debug(`[AlertEngine] Purged ${events.length - filtered.length} event(s) for device ${deviceId} from ${dateStr}.json`);
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
          logger.warn(`[AlertEngine] Failed to purge events from ${dateStr}.json:`, error);
        }
      }
    }
  }

  /**
   * 获取告警历史
   * Requirements: 9.2 - 当 DataStore 可用时从 alert_events 表读取
   */
  async getAlertHistory(from: number, to: number, deviceId?: string): Promise<AlertEvent[]> {
    await this.initialize();

    const resultEvents = new Map<string, AlertEvent>();

    // 0. PostgreSQL path (highest priority)
    if (this.usePg) {
      try {
        const fromStr = new Date(from).toISOString();
        const toStr = new Date(to).toISOString();

        let query = 'SELECT * FROM alert_events WHERE created_at <= $1 AND (resolved_at >= $2 OR resolved_at IS NULL)';
        const params: any[] = [toStr, fromStr];

        if (deviceId) {
          query += ' AND device_id = $3';
          params.push(deviceId);
        }

        query += ' ORDER BY created_at DESC';

        const rows = await this.pgDataStore!.query<{
          id: string;
          tenant_id: string;
          device_id: string | null;
          rule_id: string;
          severity: string;
          message: string;
          metric_value: number | null;
          status: string;
          acknowledged_at: string | null;
          resolved_at: string | null;
          created_at: string;
          notify_channels: string | null;
          auto_response_config: string | null;
        }>(query, params);

        for (const row of rows) {
          const event = this.dbRowToAlertEvent(row);
          resultEvents.set(event.id, event);
        }

        // Also merge in-memory cache for latest dirty data
        if (this.config.enableMemoryCache && this.eventsCache) {
          for (const event of this.eventsCache.values()) {
            const eventEnd = event.resolvedAt || Date.now();
            const overlap = event.triggeredAt <= to && eventEnd >= from;
            if (!overlap) continue;
            if (deviceId && event.deviceId && event.deviceId !== deviceId) continue;
            resultEvents.set(event.id, event);
          }
        }

        const allEvents = Array.from(resultEvents.values());
        allEvents.sort((a, b) => b.triggeredAt - a.triggeredAt);
        return allEvents;
      } catch (error) {
        logger.warn('Failed to get alert history from PostgreSQL, falling back:', error);
      }
    }

    // 从文件读取 (Fallback & Supplement)
    // 即使 DB 可用，我们也读取文件，以防 DB 写入失败导致数据丢失 (Foreign Key 失败等情况)
    // 这是一个 "混合检索策略" (Hybrid Retrieval Strategy)
    try {
      // 扫描范围：[from - 7 days, to] 以捕获长周期告警
      const searchFrom = from - 7 * 24 * 60 * 60 * 1000;
      const dates = this.getDateRange(searchFrom, to);

      for (const dateStr of dates) {
        const fileEvents = await this.readEventsFile(dateStr);

        for (const e of fileEvents) {
          // 过滤时间范围和设备
          const eventEnd = e.resolvedAt || Date.now();
          const overlap = e.triggeredAt <= to && eventEnd >= from;
          if (!overlap) continue;
          if (deviceId && e.deviceId && e.deviceId !== deviceId) continue;

          // 合并逻辑
          const existing = resultEvents.get(e.id);
          if (!existing) {
            // 情况 A: DB 中没有，但文件中有 -> 添加 (修复 Persistence Failure)
            resultEvents.set(e.id, e);
          } else {
            // 情况 B: DB 中有，文件也有 -> 冲突解决
            // 如果文件显示已解决，但 DB 显示活跃 -> 采信文件 (修复 Resolve Update Persistence Failure)
            if (e.status === 'resolved' && existing.status === 'active') {
              resultEvents.set(e.id, e);
            }
          }
        }
      }
    } catch (error) {
      logger.error('Failed to read alert history from files:', error);
    }

    // 3. 从内存缓存读取 (Dirty Data / Latest Updates)
    // 修复：如果启用了内存缓存，最新的变更可能还在内存中未持久化到文件（也未成功写入 DB）
    if (this.config.enableMemoryCache && this.eventsCache) {
      for (const event of this.eventsCache.values()) {
        const eventEnd = event.resolvedAt || Date.now();
        const overlap = event.triggeredAt <= to && eventEnd >= from;

        if (!overlap) continue;
        if (deviceId && event.deviceId && event.deviceId !== deviceId) continue;

        // 内存中的数据通常是最新的，覆盖之前的记录
        resultEvents.set(event.id, event);
      }
    }

    // 4. 转换为数组并排序
    const allEvents = Array.from(resultEvents.values());
    allEvents.sort((a, b) => b.triggeredAt - a.triggeredAt);

    return allEvents;
  }

  /**
   * 分页获取告警历史
   * Requirements: 4.1, 4.2, 4.3
   */
  async getAlertHistoryPaginated(
    from: number,
    to: number,
    page: number = 1,
    pageSize: number = 20,
    deviceId?: string // Add deviceId support
  ): Promise<{
    items: AlertEvent[];
    total: number;
    page: number;
    pageSize: number;
    totalPages: number;
  }> {
    const allEvents = await this.getAlertHistory(from, to, deviceId);
    const total = allEvents.length;
    const totalPages = Math.ceil(total / pageSize);
    const start = (page - 1) * pageSize;
    const items = allEvents.slice(start, start + pageSize);

    return { items, total, page, pageSize, totalPages };
  }

  /**
   * 删除告警事件
   * Requirements: 4.5, 4.7, 4.9
  /**
   * 删除告警事件
   * Requirements: 4.5, 4.7
   */
  async deleteAlertEvent(id: string): Promise<void> {
    await this.initialize();

    const event = await this.getAlertEventById(id);
    if (!event) {
      throw new Error('告警事件不存在');
    }

    // 状态检查：对 Syslog 转换事件放宽限制
    // Syslog 事件始终设置 status: 'active'，即使已过期也应允许删除
    if (event.status === 'active' && event.source !== 'syslog') {
      throw new Error('活跃告警不能删除，请先解决');
    }

    // 从缓存和文件中删除
    const dateStr = getDateString(event.triggeredAt);

    if (this.config.enableMemoryCache && this.eventsCache) {
      // 从 LRU 缓存中删除
      this.eventsCache.delete(id);
    }

    // 清理 activeAlerts Map 中的对应条目
    this.activeAlerts.delete(id);

    // PostgreSQL path
    if (this.usePg) {
      try {
        await this.pgDataStore!.execute('DELETE FROM alert_events WHERE id = $1', [id]);
      } catch (error) {
        logger.error('Failed to delete event from PostgreSQL:', error);
      }
    }

    // 从文件中删除
    // Syslog 事件可能因 FK 约束未能写入 DB，仅存在于文件中
    // 即使 DataStore 可用，也需要清理文件中的残留数据
    {
      const filePath = getEventsFilePath(dateStr);
      let fileEvents: AlertEvent[] = [];
      try {
        const data = await fs.readFile(filePath, 'utf-8');
        fileEvents = JSON.parse(data) as AlertEvent[];
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
          throw error;
        }
      }

      if (fileEvents.some((e) => e.id === id)) {
        const filteredEvents = fileEvents.filter((e) => e.id !== id);
        await this.ensureDataDir();
        await fs.writeFile(filePath, JSON.stringify(filteredEvents, null, 2), 'utf-8');
      }
    }

    // 记录审计日志
    await auditLogger.log({
      action: 'alert_resolve',
      actor: 'user',
      details: {
        trigger: 'delete',
        metadata: {
          eventId: id,
          ruleId: event.ruleId,
          ruleName: event.ruleName,
        },
      },
    });

    logger.info(`Alert event deleted: ${id}`);
  }

  /**
   * 批量删除告警事件
   * Requirements: 4.6, 4.7, 4.9
   */
  async deleteAlertEvents(ids: string[]): Promise<{ deleted: number; failed: number; errors: Array<{ id: string; reason: string }> }> {
    let deleted = 0;
    let failed = 0;
    const errors: Array<{ id: string; reason: string }> = [];

    for (const id of ids) {
      try {
        await this.deleteAlertEvent(id);
        deleted++;
      } catch (error) {
        failed++;
        const reason = error instanceof Error ? error.message : String(error);
        errors.push({ id, reason });
      }
    }

    return { deleted, failed, errors };
  }

  /**
   * 手动解决告警
   */
  async resolveAlert(id: string): Promise<void> {
    await this.initialize();

    const event = this.activeAlerts.get(id);
    if (!event) {
      // 尝试从文件中查找
      const now = Date.now();
      const sevenDaysAgo = now - 7 * 24 * 60 * 60 * 1000;
      const dates = this.getDateRange(sevenDaysAgo, now);

      for (const dateStr of dates) {
        const events = await this.readEventsFile(dateStr);
        const found = events.find((e) => e.id === id);
        if (found) {
          if (found.status === 'resolved') {
            throw new Error(`Alert already resolved: ${id}`);
          }
          found.status = 'resolved';
          found.resolvedAt = now;
          await this.writeEventsFile(dateStr, events);

          // 清除指纹缓存，允许同样的告警再次触发
          const fingerprint = fingerprintCache.generateFingerprint(found);
          fingerprintCache.delete(fingerprint);
          logger.debug(`Fingerprint cleared for manually resolved alert (from file): ${fingerprint}`);

          // 索引到知识库 (Requirements: 3.1 - 告警解决时自动索引)
          // Note: aiAnalysis is a string summary, not a RootCauseAnalysis object
          try {
            await knowledgeBase.indexAlert(found);
            logger.debug(`Alert indexed to knowledge base: ${found.id}`);
          } catch (error) {
            logger.warn(`Failed to index alert to knowledge base: ${found.id}`, error);
          }

          // 记录审计日志
          await auditLogger.log({
            action: 'alert_resolve',
            actor: 'user',
            details: {
              trigger: 'manual',
              metadata: {
                eventId: id,
                ruleId: found.ruleId,
              },
            },
          });

          logger.info(`Alert manually resolved: ${id}`);
          return;
        }
      }

      throw new Error(`Alert not found: ${id}`);
    }

    // 更新活跃告警
    event.status = 'resolved';
    event.resolvedAt = Date.now();

    await this.saveEvent(event);
    this.activeAlerts.delete(id);

    // 清除指纹缓存，允许同样的告警再次触发
    const fingerprint = fingerprintCache.generateFingerprint(event);
    fingerprintCache.delete(fingerprint);
    logger.debug(`Fingerprint cleared for manually resolved alert: ${fingerprint}`);

    // 索引到知识库 (Requirements: 3.1 - 告警解决时自动索引)
    // Note: aiAnalysis is a string summary, not a RootCauseAnalysis object
    try {
      await knowledgeBase.indexAlert(event);
      logger.debug(`Alert indexed to knowledge base: ${event.id}`);
    } catch (error) {
      logger.warn(`Failed to index alert to knowledge base: ${event.id}`, error);
    }

    // 记录审计日志
    await auditLogger.log({
      action: 'alert_resolve',
      actor: 'user',
      details: {
        trigger: 'manual',
        metadata: {
          eventId: id,
          ruleId: event.ruleId,
          ruleName: event.ruleName,
        },
      },
    });

    // 获取规则并发送恢复通知
    const rule = this.rules.find((r) => r.id === event.ruleId);
    if (rule) {
      await this.sendRecoveryNotification(event, rule);
    }

    logger.info(`Alert manually resolved: ${id}`);
  }

  /**
   * 根据 ID 获取告警事件
   * Requirements: 9.2 - 当 DataStore 可用时从 alert_events 表读取
   */
  async getAlertEventById(id: string): Promise<AlertEvent | null> {
    await this.initialize();

    // 1. 先检查 LRU 缓存
    if (this.config.enableMemoryCache && this.eventsCache) {
      const cached = this.eventsCache.get(id);
      if (cached) {
        return cached;
      }
    }

    // 2. 检查活跃告警 Map
    const activeEvent = this.activeAlerts.get(id);
    if (activeEvent) {
      return activeEvent;
    }

    // 3. PostgreSQL path
    if (this.usePg) {
      try {
        const row = await this.pgDataStore!.queryOne<{
          id: string;
          tenant_id: string;
          device_id: string | null;
          rule_id: string;
          severity: string;
          message: string;
          metric_value: number | null;
          status: string;
          acknowledged_at: string | null;
          resolved_at: string | null;
          created_at: string;
          notify_channels: string | null;
          auto_response_config: string | null;
        }>('SELECT * FROM alert_events WHERE id = $1', [id]);

        if (row) {
          return this.dbRowToAlertEvent(row);
        }
      } catch (error) {
        logger.warn('Failed to get alert event from PostgreSQL, falling back:', error);
      }
    }

    // 从文件中查找 — 分级策略：先查 90 天，再全目录扫描
    const now = Date.now();
    const ninetyDaysAgo = now - 90 * 24 * 60 * 60 * 1000;
    const dates = this.getDateRange(ninetyDaysAgo, now);

    for (const dateStr of dates) {
      const events = await this.readEventsFile(dateStr);
      const found = events.find((e) => e.id === id);
      if (found) {
        return found;
      }
    }

    // 5. 全目录扫描 fallback（超过 90 天的历史事件）
    // 注意：全目录扫描在数据量大时可能较慢，考虑优化为索引查找
    logger.warn(`getAlertEventById: event ${id} not found in cache/DB/90-day range, falling back to full directory scan`);
    try {
      const allFiles = await fs.readdir(EVENTS_DIR);
      const dateFiles = allFiles
        .filter(f => f.endsWith('.json'))
        .sort()
        .reverse(); // 从最新到最旧

      for (const file of dateFiles) {
        const dateStr = file.replace('.json', '');
        // 跳过已经在 90 天范围内搜索过的日期
        if (dates.includes(dateStr)) continue;
        const events = await this.readEventsFile(dateStr);
        const found = events.find((e) => e.id === id);
        if (found) {
          return found;
        }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        logger.error('Failed to scan events directory for fallback search:', error);
      }
    }

    return null;
  }

  /**
   * 获取规则的告警统计
   */
  async getRuleAlertStats(
    ruleId: string,
    from: number,
    to: number
  ): Promise<{ total: number; active: number; resolved: number }> {
    const events = await this.getAlertHistory(from, to);
    const ruleEvents = events.filter((e) => e.ruleId === ruleId);

    return {
      total: ruleEvents.length,
      active: ruleEvents.filter((e) => e.status === 'active').length,
      resolved: ruleEvents.filter((e) => e.status === 'resolved').length,
    };
  }

  // ==================== 预处理事件处理 ====================

  /**
   * 注册预处理事件处理器
   * 用于将归一化后的事件传递给后续 AI 处理流程
   * Requirements: 4.1
   */
  onPreprocessedEvent(handler: (event: UnifiedEvent | CompositeEvent) => void): void {
    this.preprocessedEventHandlers.push(handler);
    logger.debug(`Preprocessed event handler registered, total: ${this.preprocessedEventHandlers.length}`);
  }

  /**
   * 移除预处理事件处理器
   */
  offPreprocessedEvent(handler: (event: UnifiedEvent | CompositeEvent) => void): void {
    const index = this.preprocessedEventHandlers.indexOf(handler);
    if (index !== -1) {
      this.preprocessedEventHandlers.splice(index, 1);
      logger.debug(`Preprocessed event handler removed, total: ${this.preprocessedEventHandlers.length}`);
    }
  }

  /**
   * 发送预处理事件给所有处理器
   */
  private emitPreprocessedEvent(event: UnifiedEvent | CompositeEvent): void {
    for (const handler of this.preprocessedEventHandlers) {
      try {
        handler(event);
      } catch (error) {
        logger.error('Preprocessed event handler error:', error);
      }
    }

    // Log for debugging
    const isComposite = 'isComposite' in event && event.isComposite;
    logger.debug(
      `Preprocessed event emitted: ${event.id}, source: ${event.source}, composite: ${isComposite}`
    );
  }

  // ==================== Syslog 事件处理 ====================

  /**
   * 将 SyslogEvent 转换为 AlertEvent
   * Requirements: syslog-alert-integration 2.1, 2.2, 2.3
  // ==================== Syslog 指纹去重方法 ====================
  // Requirements (syslog-cpu-spike-fix): 4.1, 4.2, 4.3, 4.4

  /**
   * 生成 Syslog 事件指纹
   * Requirements (syslog-cpu-spike-fix): 4.3 - 基于消息、来源、类别生成指纹
   * @param syslogEvent Syslog 事件
   * @returns 指纹字符串
   */
  private generateSyslogFingerprint(syslogEvent: SyslogEvent): string {
    // 基于消息内容、来源和类别生成指纹
    const message = syslogEvent.message || '';
    const source = syslogEvent.metadata?.hostname || 'unknown';
    const category = syslogEvent.category || 'unknown';

    // 使用简单的哈希算法生成指纹
    const content = `${source}:${category}:${message}`;
    let hash = 0;
    for (let i = 0; i < content.length; i++) {
      const char = content.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash; // Convert to 32bit integer
    }
    return `syslog_${Math.abs(hash).toString(16)}`;
  }

  /**
   * 检查 Syslog 指纹是否正在处理中
   * Requirements (syslog-cpu-spike-fix): 4.1, 4.2 - 入队前检查
   * @param fingerprint 指纹
   * @returns true 如果正在处理中
   */
  private isSyslogFingerprintProcessing(fingerprint: string): boolean {
    if (!this.processingSyslogFingerprints.has(fingerprint)) {
      return false;
    }

    // 检查是否已过期
    const timestamp = this.syslogFingerprintTimestamps.get(fingerprint);
    if (timestamp && Date.now() - timestamp > this.SYSLOG_FINGERPRINT_TTL_MS) {
      // 已过期，清理并返回 false
      this.processingSyslogFingerprints.delete(fingerprint);
      this.syslogFingerprintTimestamps.delete(fingerprint);
      return false;
    }

    return true;
  }

  /**
   * 标记 Syslog 指纹为处理中
   * Requirements (syslog-cpu-spike-fix): 4.1 - 入队时标记
   * @param fingerprint 指纹
   */
  private markSyslogFingerprintProcessing(fingerprint: string): void {
    this.processingSyslogFingerprints.add(fingerprint);
    this.syslogFingerprintTimestamps.set(fingerprint, Date.now());
  }

  /**
   * 清理 Syslog 指纹处理状态
   * Requirements (syslog-cpu-spike-fix): 4.4 - 处理完成后清理
   * @param fingerprint 指纹
   */
  private clearSyslogFingerprint(fingerprint: string): void {
    this.processingSyslogFingerprints.delete(fingerprint);
    this.syslogFingerprintTimestamps.delete(fingerprint);
  }

  /**
   * 清理过期的 Syslog 指纹
   * Requirements (syslog-cpu-spike-fix): 4.4 - 定期清理
   */
  private cleanupExpiredSyslogFingerprints(): void {
    const now = Date.now();
    let cleanedCount = 0;

    for (const [fingerprint, timestamp] of this.syslogFingerprintTimestamps) {
      if (now - timestamp > this.SYSLOG_FINGERPRINT_TTL_MS) {
        this.processingSyslogFingerprints.delete(fingerprint);
        this.syslogFingerprintTimestamps.delete(fingerprint);
        cleanedCount++;
      }
    }

    if (cleanedCount > 0) {
      logger.debug(`Cleaned up ${cleanedCount} expired syslog fingerprints, remaining: ${this.processingSyslogFingerprints.size}`);
    }
  }

  /**
   * 将 SyslogEvent 转换为 AlertEvent 格式
   * Requirements: G5.17 - 使用数据驱动的 topic-to-severity 映射
   * 
   * @param syslogEvent Syslog 事件
   * @returns 转换后的 AlertEvent
   */
  private convertSyslogToAlertEvent(syslogEvent: SyslogEvent): AlertEvent {
    // G5.17: 使用数据驱动的 topic 严重度映射，替代硬编码的 RouterOS topic 检测
    const mappedSeverity = this.mapSyslogTopicToSeverity(syslogEvent.category);
    // 优先使用 syslog 事件自身的严重度，映射结果作为 fallback
    const severity = syslogEvent.severity || mappedSeverity;

    return {
      id: syslogEvent.id,
      tenantId: syslogEvent.tenantId, // 传播租户 ID
      deviceId: syslogEvent.deviceId, // 传播设备 ID
      ruleId: `syslog-${syslogEvent.category}`,
      ruleName: `Syslog: ${syslogEvent.category}`,
      severity,
      metric: 'syslog' as MetricType, // 使用 'syslog' 类型明确标识来源
      currentValue: 0,
      threshold: 0,
      message: syslogEvent.message,
      status: 'active',
      triggeredAt: syslogEvent.timestamp,
      // Syslog 集成字段 (Requirements: syslog-alert-integration 1.3, 1.4)
      source: 'syslog' as AlertEventSource,
      syslogData: {
        hostname: syslogEvent.metadata?.hostname || 'unknown',
        facility: syslogEvent.metadata?.facility || 0,
        syslogSeverity: syslogEvent.metadata?.syslogSeverity || 6,
        category: syslogEvent.category,
        rawMessage: syslogEvent.rawData?.raw || syslogEvent.message,
      },
    };
  }

  /**
   * 处理 Syslog 事件
   * Requirements: syslog-alert-integration 1.2, 2.1
   * Requirements (syslog-cpu-spike-fix): 4.1, 4.2, 4.3, 4.4 - Syslog 事件入队去重
   * 
   * 改造后的流程：
   * 1. 生成事件指纹并检查是否重复
   * 2. 将 SyslogEvent 转换为 AlertEvent 格式
   * 3. 保存到统一的告警事件存储 (data/ai-ops/alerts/events/)
   * 4. 通过 ConcurrencyController 入队处理
   * 5. 通过 alertPipeline 进行完整处理（归一化 → 去重 → 过滤 → 分析 → 决策）
   * 6. 处理完成后清理指纹
   * 
   * @param syslogEvent Syslog 事件
   */
  async processSyslogEvent(syslogEvent: SyslogEvent): Promise<void> {
    await this.initialize();

    if (!this.pipelineController) {
      logger.error('Pipeline controller not initialized, cannot process syslog event');
      return;
    }

    // Requirements (syslog-cpu-spike-fix): 4.1, 4.2, 4.3 - 入队前检查指纹
    const fingerprint = this.generateSyslogFingerprint(syslogEvent);
    if (this.isSyslogFingerprintProcessing(fingerprint)) {
      logger.debug(`Duplicate syslog event dropped: ${syslogEvent.id}, fingerprint: ${fingerprint}`);
      return;
    }

    // 标记指纹为处理中
    this.markSyslogFingerprintProcessing(fingerprint);

    // 转换为 AlertEvent 格式 (Requirements: syslog-alert-integration 2.1, 2.2, 2.3)
    const alertEvent = this.convertSyslogToAlertEvent(syslogEvent);

    // 保存到统一的告警事件存储 (Requirements: syslog-alert-integration 1.2)
    await this.saveEvent(alertEvent);
    // 添加到活跃告警缓存，确保 getActiveAlerts() 能返回 Syslog 事件
    this.activeAlerts.set(alertEvent.id, alertEvent);
    logger.debug(`Syslog event saved to unified storage and active alerts: ${alertEvent.id}`);

    // 根据 syslog 严重级别计算优先级
    // emergency/critical: 2, warning: 3, info: 4
    const severityPriority: Record<string, number> = {
      emergency: 1,
      critical: 2,
      warning: 3,
      info: 4,
    };
    const priority = severityPriority[syslogEvent.severity] ?? 4;

    // 创建一个虚拟的 AlertRule 用于处理（syslog 没有对应的规则）
    const virtualRule: AlertRule = {
      id: `syslog-${syslogEvent.category}`,
      name: `Syslog: ${syslogEvent.category}`,
      tenantId: syslogEvent.tenantId, // 注入租户 ID
      deviceId: syslogEvent.deviceId, // 注入设备 ID
      enabled: true,
      metric: 'syslog', // 使用 'syslog' 类型明确标识来源
      operator: 'gt',
      threshold: 0,
      duration: 1,
      cooldownMs: 0,
      severity: syslogEvent.severity,
      channels: [], // syslog 通知由决策引擎处理
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    // 使用并发控制器入队处理（fire-and-forget 模式，与普通告警保持一致）
    // 不 await enqueue 的结果，避免大量 Syslog 消息涌入时阻塞
    this.pipelineController.enqueue({ event: alertEvent, rule: virtualRule }, priority)
      .then(() => {
        logger.debug(`Syslog event processed: ${syslogEvent.id}`);
        // Requirements (syslog-cpu-spike-fix): 4.4 - 处理完成后清理指纹
        this.clearSyslogFingerprint(fingerprint);
      })
      .catch(error => {
        logger.warn(`Failed to process syslog event ${syslogEvent.id}:`, error);
        // 处理失败也要清理指纹，避免永久阻塞
        this.clearSyslogFingerprint(fingerprint);
      });

    logger.debug(`Syslog event enqueued for processing: ${syslogEvent.id}, priority: ${priority}, fingerprint: ${fingerprint}`);
  }

  // ==================== 告警生命周期状态机 ====================
  // Requirements: G4.13 - 告警事件完整生命周期管理
  // 状态转换：active → acknowledged → in_progress → resolved/closed

  /**
   * 转换告警状态
   * Requirements: G4.13 - 状态转换通过 StateMachine 编排
   * @param alertId 告警事件 ID
   * @param newState 目标状态
   * @returns 更新后的告警事件
   */
  async transitionAlertState(alertId: string, newState: AlertState): Promise<AlertEvent> {
    await this.initialize();

    const event = this.activeAlerts.get(alertId);
    if (!event) {
      throw new Error(`Alert not found: ${alertId}`);
    }

    const currentState = (event.status === 'resolved' ? 'resolved' : event.status) as AlertState;
    const validTransitions = VALID_ALERT_TRANSITIONS[currentState];

    if (!validTransitions || !validTransitions.includes(newState)) {
      throw new Error(
        `Invalid state transition: ${currentState} → ${newState}. Valid transitions: ${validTransitions?.join(', ') || 'none'}`
      );
    }

    // 更新状态
    const previousState = event.status;
    event.status = newState as AlertEvent['status'];

    if (newState === 'resolved') {
      event.resolvedAt = Date.now();
    }

    // 持久化
    await this.saveEvent(event);

    // 如果状态为 resolved 或 closed，从活跃告警中移除
    if (newState === 'resolved' || newState === 'closed') {
      this.activeAlerts.delete(alertId);
    } else {
      this.activeAlerts.set(alertId, event);
    }

    // 记录审计日志
    await auditLogger.log({
      tenantId: event.tenantId,
      deviceId: event.deviceId,
      action: newState === 'resolved' ? 'alert_resolve' : 'alert_trigger',
      actor: 'user',
      details: {
        trigger: 'state_transition',
        metadata: {
          alertId,
          previousState,
          newState,
          transitionAt: Date.now(),
        },
      },
    });

    logger.info(`Alert state transitioned: ${alertId} ${previousState} → ${newState}`);
    return event;
  }

  // ==================== 批量操作 ====================
  // Requirements: G4.14, G5.17 - 批量处理告警事件

  /**
   * 批量确认告警
   * Requirements: G4.14 - 批量确认操作
   */
  async batchAcknowledge(ids: string[]): Promise<{ success: number; failed: number }> {
    let success = 0;
    let failed = 0;

    for (const id of ids) {
      try {
        await this.transitionAlertState(id, 'acknowledged');
        success++;
      } catch (error) {
        logger.warn(`Failed to acknowledge alert ${id}:`, error);
        failed++;
      }
    }

    logger.info(`Batch acknowledge completed: ${success} success, ${failed} failed`);
    return { success, failed };
  }

  /**
   * 批量关闭告警
   * Requirements: G4.14 - 批量关闭操作
   */
  async batchClose(ids: string[]): Promise<{ success: number; failed: number }> {
    let success = 0;
    let failed = 0;

    for (const id of ids) {
      try {
        await this.transitionAlertState(id, 'closed');
        success++;
      } catch (error) {
        logger.warn(`Failed to close alert ${id}:`, error);
        failed++;
      }
    }

    logger.info(`Batch close completed: ${success} success, ${failed} failed`);
    return { success, failed };
  }

  /**
   * 批量分配告警
   * Requirements: G4.14 - 批量分配操作
   */
  async batchAssign(ids: string[], assignee: string): Promise<{ success: number; failed: number }> {
    let success = 0;
    let failed = 0;

    for (const id of ids) {
      try {
        const event = this.activeAlerts.get(id);
        if (!event) {
          failed++;
          continue;
        }

        // 将告警转为处理中状态并记录分配人
        if (event.status === 'active') {
          await this.transitionAlertState(id, 'acknowledged');
        }
        if (event.status === 'acknowledged' as string) {
          await this.transitionAlertState(id, 'in_progress');
        }

        // 记录分配审计日志
        await auditLogger.log({
          tenantId: event.tenantId,
          deviceId: event.deviceId,
          action: 'alert_trigger',
          actor: 'user',
          details: {
            trigger: 'batch_assign',
            metadata: {
              alertId: id,
              assignee,
              assignedAt: Date.now(),
            },
          },
        });

        success++;
      } catch (error) {
        logger.warn(`Failed to assign alert ${id} to ${assignee}:`, error);
        failed++;
      }
    }

    logger.info(`Batch assign completed: ${success} success, ${failed} failed, assignee: ${assignee}`);
    return { success, failed };
  }

  // ==================== Syslog Topic 严重度映射 ====================
  // Requirements: G5.17 - 数据驱动的 topic-to-severity 映射

  /**
   * 根据 syslog topic/category 映射严重度
   * 使用数据驱动的映射表，不硬编码特定厂商的 topic
   * Requirements: G5.17
   */
  mapSyslogTopicToSeverity(topic: string): AlertSeverity {
    for (const mapping of this.syslogTopicSeverityMap) {
      try {
        const regex = new RegExp(mapping.pattern, 'i');
        if (regex.test(topic)) {
          return mapping.severity;
        }
      } catch {
        // 如果正则无效，尝试简单字符串匹配
        if (topic.toLowerCase().includes(mapping.pattern.toLowerCase())) {
          return mapping.severity;
        }
      }
    }
    // 默认返回 info
    return 'info';
  }

  /**
   * 获取预处理器实例
   * 用于外部访问预处理器功能
   */
  getPreprocessor() {
    return alertPreprocessor;
  }
}

// 导出单例实例
export const alertEngine = new AlertEngine();
