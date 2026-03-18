/**
 * DecisionEngine 智能决策引擎服务
 * 根据多种因素决定告警的处理方式
 *
 * Requirements: 8.1, 8.2, 8.3, 8.4, 8.5, 8.6, 8.7, 8.8, 8.9
 * - 8.1: 根据决策矩阵评估告警并确定处理动作
 * - 8.2: 支持决策类型：auto_execute, notify_and_wait, escalate, silence
 * - 8.3: 决策考虑因素：严重级别、时间、历史成功率、影响范围
 * - 8.4: auto_execute 决策触发自动修复
 * - 8.5: notify_and_wait 决策发送通知并等待确认
 * - 8.6: escalate 决策通知更高级别人员并提升优先级
 * - 8.7: silence 决策抑制告警但记录审计日志
 * - 8.8: 支持通过配置接口配置决策矩阵
 * - 8.9: 决策时记录决策推理用于审计
 */

import fs from 'fs/promises';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import {
  UnifiedEvent,
  RootCauseAnalysis,
  RemediationPlan,
  Decision,
  DecisionType,
  DecisionRule,
  DecisionFactor,
  DecisionContext,
  DecisionCondition,
  DecisionFactorScore,
  ImpactAssessment,
  ImpactScope,
  IDecisionEngine,
  CreateDecisionRuleInput,
  UpdateDecisionRuleInput,
  DefaultDecisionConfig,
  ExecutionResult,
} from '../../types/ai-ops';
import { logger } from '../../utils/logger';
import { auditLogger } from './auditLogger';
import { notificationService } from './notificationService';
import { remediationAdvisor } from './remediationAdvisor';
import { faultHealer } from './faultHealer';
import { autonomousBrainService } from './brain/autonomousBrainService';
import type { DataStore } from '../dataStore';


const DATA_DIR = path.join(process.cwd(), 'data', 'ai-ops');
const DECISIONS_DIR = path.join(DATA_DIR, 'decisions');
const RULES_FILE = path.join(DECISIONS_DIR, 'rules.json');
const HISTORY_DIR = path.join(DECISIONS_DIR, 'history');

/**
 * Get date string (YYYY-MM-DD)
 */
function getDateString(timestamp: number): string {
  const date = new Date(timestamp);
  return date.toISOString().split('T')[0];
}

/**
 * Get decision history file path for a date
 */
function getHistoryFilePath(dateStr: string): string {
  return path.join(HISTORY_DIR, `${dateStr}.json`);
}


/**
 * Default decision factors
 * Requirements: 8.3 - 决策考虑因素
 */
const DEFAULT_FACTORS: DecisionFactor[] = [
  {
    name: 'severity',
    weight: 0.25,
    evaluate: (event: UnifiedEvent): number => {
      // Map severity to score (0-1)
      const severityScores: Record<string, number> = {
        info: 0.1,
        warning: 0.4,
        critical: 0.8,
        emergency: 1.0,
      };
      return severityScores[event.severity] || 0.5;
    },
  },
  {
    name: 'time_of_day',
    weight: 0.10,
    evaluate: (_event: UnifiedEvent, context: DecisionContext): number => {
      // Business hours (9-18) get lower score (more likely to wait for human)
      // Off-hours get higher score (more likely to auto-execute)
      const hour = context.currentTime.getHours();
      if (hour >= 9 && hour < 18) {
        return 0.3; // Business hours - prefer human intervention
      } else if (hour >= 0 && hour < 6) {
        return 0.9; // Night - prefer auto-execution
      }
      return 0.6; // Evening/early morning
    },
  },
  {
    name: 'historical_success_rate',
    weight: 0.20,
    evaluate: (_event: UnifiedEvent, context: DecisionContext): number => {
      // Higher success rate = higher score for auto-execution
      return context.historicalSuccessRate;
    },
  },
  {
    name: 'affected_scope',
    weight: 0.15,
    evaluate: (_event: UnifiedEvent, context: DecisionContext): number => {
      // Larger scope = lower score (more caution needed)
      const scopeScores: Record<ImpactScope, number> = {
        local: 0.8,
        partial: 0.5,
        widespread: 0.2,
      };
      return scopeScores[context.affectedScope.scope] || 0.5;
    },
  },
  // G3.7: 新增多因子 - 系统负载
  {
    name: 'system_load',
    weight: 0.10,
    evaluate: (): number => {
      // Default 0.5; updated via setSystemLoad(). High load → lower score (more caution).
      return 0.5;
    },
  },
  // G3.7: 新增多因子 - 设备健康度
  {
    name: 'device_health',
    weight: 0.10,
    evaluate: (): number => {
      // Default 0.5; updated via setDeviceHealth(). Unhealthy → higher urgency score.
      return 0.5;
    },
  },
  // G3.7: 新增多因子 - 关联告警数量
  {
    name: 'correlated_alert_count',
    weight: 0.10,
    evaluate: (): number => {
      // Default 0; updated from analysis result in decide(). More correlated → higher score.
      return 0;
    },
  },
];

/**
 * Default decision rules
 * Requirements: 8.8 - 支持配置决策矩阵
 */
const DEFAULT_RULES: DecisionRule[] = [
  {
    id: 'rule-emergency-escalate',
    name: 'Critical Widespread Escalation',
    priority: 1,
    conditions: [
      { factor: 'severity', operator: 'gte', value: 0.8 },
      { factor: 'affected_scope', operator: 'lte', value: 0.5 },
    ],
    action: 'escalate',
    enabled: true,
  },
  {
    id: 'rule-critical-notify',
    name: 'Critical / Emergency Notification',
    priority: 2,
    conditions: [
      { factor: 'severity', operator: 'gte', value: 0.7 },
    ],
    action: 'notify_and_wait',
    enabled: true,
  },
  {
    id: 'rule-high-confidence-auto',
    name: 'High Success Rate Auto-Execute',
    priority: 3,
    conditions: [
      { factor: 'historical_success_rate', operator: 'gte', value: 0.9 },
      { factor: 'severity', operator: 'gte', value: 0.2 },
      { factor: 'severity', operator: 'lt', value: 0.8 },
      { factor: 'affected_scope', operator: 'gte', value: 0.5 },
    ],
    action: 'auto_execute',
    enabled: true,
  },
  {
    id: 'rule-off-hours-auto',
    name: 'Off-Hours Low-Risk Auto-Execute',
    priority: 4,
    conditions: [
      { factor: 'time_of_day', operator: 'gte', value: 0.8 },
      { factor: 'severity', operator: 'lte', value: 0.4 },
      { factor: 'historical_success_rate', operator: 'gte', value: 0.7 },
    ],
    action: 'auto_execute',
    enabled: true,
  },
  {
    id: 'rule-info-silence',
    name: 'Info Level Silence',
    priority: 5,
    conditions: [
      { factor: 'severity', operator: 'lte', value: 0.15 },
    ],
    action: 'silence',
    enabled: true,
  },
  {
    id: 'rule-night-noise-silence',
    name: 'Night Local Noise Silence',
    priority: 6,
    conditions: [
      { factor: 'time_of_day', operator: 'gte', value: 0.8 },
      { factor: 'severity', operator: 'lte', value: 0.3 },
      { factor: 'affected_scope', operator: 'gte', value: 0.8 },
    ],
    action: 'silence',
    enabled: true,
  },
  {
    id: 'rule-default-notify',
    name: 'Default Notification',
    priority: 100,
    conditions: [], // Always matches as fallback
    action: 'notify_and_wait',
    enabled: true,
  },
];

/**
 * Default decision configuration
 * Requirements: 9.1, 9.2, 9.3, 9.4 - 当所有规则禁用时返回默认决策
 */
const DEFAULT_DECISION_CONFIG: DefaultDecisionConfig = {
  action: 'notify_and_wait',
  priority: 1000,
  notifyChannels: [],
};


export class DecisionEngine implements IDecisionEngine {
  private initialized = false;
  private rules: DecisionRule[] = [];
  private factors: Map<string, DecisionFactor> = new Map();
  private decisionCache: Map<string, Decision> = new Map();
  private defaultDecisionConfig: DefaultDecisionConfig = { ...DEFAULT_DECISION_CONFIG };

  // 按日期分区的写锁，防止并发 read-modify-write 丢数据
  private writeLocks: Map<string, Promise<void>> = new Map();

  // 缓存清理定时器
  private cacheCleanupTimer: NodeJS.Timeout | null = null;

  // 最大缓存条目数
  private readonly MAX_CACHE_SIZE = 500;

  // 缓存 TTL（1 小时）
  private readonly CACHE_TTL_MS = 60 * 60 * 1000;

  // G3.9: Optional PostgreSQL DataStore (setter injection, file-based fallback)
  private dataStore: DataStore | null = null;

  // G3.7: Runtime values for new factors
  private systemLoadValue = 0.5;
  private deviceHealthValue = 0.5;

  // Optional dependency: MetricsCollector (duck-typed to avoid circular imports)
  private metricsCollector: { getLatestMetrics?(): { cpuUsage?: number; memoryUsage?: number } } | null = null;

  // Optional dependency: EventBus (duck-typed to avoid circular imports)
  private eventBus: { publish(event: { type: string; payload: Record<string, unknown>; priority?: string }): Promise<unknown> } | null = null;

  constructor() {
    // Register default factors
    for (const factor of DEFAULT_FACTORS) {
      this.factors.set(factor.name, factor);
    }

    // Override new factor evaluators to use instance state
    this.factors.set('system_load', {
      name: 'system_load',
      weight: 0.10,
      evaluate: (): number => {
        // If metricsCollector is available, derive from it
        if (this.metricsCollector?.getLatestMetrics) {
          const metrics = this.metricsCollector.getLatestMetrics();
          const cpu = metrics?.cpuUsage ?? 0.5;
          // High load → lower score (more caution needed)
          return Math.max(0, 1 - cpu);
        }
        // High load → lower score
        return Math.max(0, 1 - this.systemLoadValue);
      },
    });

    this.factors.set('device_health', {
      name: 'device_health',
      weight: 0.10,
      evaluate: (): number => {
        // Unhealthy (low value) → higher urgency score
        return 1 - this.deviceHealthValue;
      },
    });

    this.factors.set('correlated_alert_count', {
      name: 'correlated_alert_count',
      weight: 0.10,
      evaluate: (): number => {
        // This is overridden per-decision in decide() via a temporary factor
        // Default: 0 correlated alerts
        return 0;
      },
    });
  }

  /**
   * Ensure data directories exist
   */
  private async ensureDataDirs(): Promise<void> {
    try {
      await fs.mkdir(DECISIONS_DIR, { recursive: true });
      await fs.mkdir(HISTORY_DIR, { recursive: true });
    } catch (error) {
      logger.error('Failed to create decision directories:', error);
    }
  }

  /**
   * Initialize service
   */
  async initialize(): Promise<void> {
    if (this.initialized) return;
    await this.ensureDataDirs();
    await this.loadRules();

    // 启动缓存清理定时器
    this.startCacheCleanupTimer();

    this.initialized = true;
    logger.info('DecisionEngine initialized');
  }

  /**
   * 启动缓存清理定时器
   */
  private startCacheCleanupTimer(): void {
    if (this.cacheCleanupTimer) {
      clearInterval(this.cacheCleanupTimer);
    }

    // 每 15 分钟清理一次过期缓存
    const CLEANUP_INTERVAL_MS = 15 * 60 * 1000;
    this.cacheCleanupTimer = setInterval(() => {
      this.cleanupExpiredCache();
    }, CLEANUP_INTERVAL_MS);

    logger.debug('DecisionEngine cache cleanup timer started');
  }

  /**
   * 停止缓存清理定时器
   */
  stopCleanupTimer(): void {
    if (this.cacheCleanupTimer) {
      clearInterval(this.cacheCleanupTimer);
      this.cacheCleanupTimer = null;
      logger.debug('DecisionEngine cache cleanup timer stopped');
    }
  }

  // ==================== Dependency Setters (G3.9, G3.10) ====================

  /**
   * Set optional PostgreSQL DataStore for persistence
   * When set, saveDecision writes to decision_history table, loadRules reads from decision_rules table
   * When NOT set, file-based fallback is used
   * Requirements: G3.9, PG.5
   */
  setDataStore(dataStore: DataStore): void {
    this.dataStore = dataStore;
    logger.info('DecisionEngine: DataStore set, PostgreSQL persistence enabled');
  }

  /**
   * Set optional MetricsCollector for system_load factor
   */
  setMetricsCollector(mc: { getLatestMetrics?(): { cpuUsage?: number; memoryUsage?: number } }): void {
    this.metricsCollector = mc;
    logger.info('DecisionEngine: MetricsCollector set');
  }

  /**
   * Set optional EventBus for publishing decision events
   */
  setEventBus(eb: { publish(event: { type: string; payload: Record<string, unknown>; priority?: string }): Promise<unknown> }): void {
    this.eventBus = eb;
    logger.info('DecisionEngine: EventBus set');
  }

  /**
   * Set system load value (0-1). High value = high load.
   * Requirements: G3.7
   */
  setSystemLoad(value: number): void {
    this.systemLoadValue = Math.max(0, Math.min(1, value));
  }

  /**
   * Get current system load value
   */
  getSystemLoad(): number {
    return this.systemLoadValue;
  }

  /**
   * Set device health value (0-1). Low value = unhealthy.
   * Requirements: G3.7
   */
  setDeviceHealth(value: number): void {
    this.deviceHealthValue = Math.max(0, Math.min(1, value));
  }

  /**
   * Get current device health value
   */
  getDeviceHealth(): number {
    return this.deviceHealthValue;
  }

  /**
   * 清理过期缓存
   */
  private cleanupExpiredCache(): void {
    const now = Date.now();
    let cleanedCount = 0;

    // 清理过期的决策缓存
    for (const [id, decision] of this.decisionCache) {
      if (now - decision.timestamp > this.CACHE_TTL_MS) {
        this.decisionCache.delete(id);
        cleanedCount++;
      }
    }

    // 如果缓存仍然过大，删除最旧的条目
    if (this.decisionCache.size > this.MAX_CACHE_SIZE) {
      const entries = Array.from(this.decisionCache.entries())
        .sort((a, b) => a[1].timestamp - b[1].timestamp);

      const toRemove = entries.slice(0, this.decisionCache.size - this.MAX_CACHE_SIZE);
      for (const [id] of toRemove) {
        this.decisionCache.delete(id);
        cleanedCount++;
      }
    }

    if (cleanedCount > 0) {
      logger.info(`DecisionEngine cleaned up ${cleanedCount} expired cache entries, remaining: ${this.decisionCache.size}`);
    }
  }

  /**
   * Load decision rules from DataStore (PostgreSQL) or disk (file fallback)
   * Requirements: G3.9
   */
  private async loadRules(): Promise<void> {
    // Try PostgreSQL first if DataStore is available
    if (this.dataStore) {
      try {
        const rows = await this.dataStore.query<DecisionRule>(
          'SELECT * FROM decision_rules ORDER BY priority ASC'
        );
        if (rows.length > 0) {
          this.rules = rows.map(row => ({
            ...row,
            conditions: typeof row.conditions === 'string' ? JSON.parse(row.conditions as unknown as string) : row.conditions,
            enabled: typeof row.enabled === 'string' ? row.enabled === 'true' : Boolean(row.enabled),
          }));
          logger.info(`Loaded ${this.rules.length} decision rules from PostgreSQL`);
          return;
        }
      } catch (error) {
        logger.warn('Failed to load rules from PostgreSQL, falling back to file:', error);
      }
    }

    // File-based fallback
    try {
      const data = await fs.readFile(RULES_FILE, 'utf-8');
      this.rules = JSON.parse(data) as DecisionRule[];
      logger.info(`Loaded ${this.rules.length} decision rules`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        // Initialize with default rules
        this.rules = [...DEFAULT_RULES];
        await this.saveRules();
        logger.info('Initialized with default decision rules');
      } else {
        logger.error('Failed to load decision rules:', error);
        this.rules = [...DEFAULT_RULES];
      }
    }
  }

  /**
   * Save decision rules to disk
   */
  private async saveRules(): Promise<void> {
    // PostgreSQL path
    if (this.dataStore) {
      try {
        await this.dataStore.transaction(async (tx) => {
          for (const rule of this.rules) {
            await tx.execute(
              `INSERT INTO decision_rules (id, name, description, enabled, priority, action, conditions, created_at, updated_at)
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
               ON CONFLICT (id) DO UPDATE SET
                 name = EXCLUDED.name, description = EXCLUDED.description, enabled = EXCLUDED.enabled,
                 priority = EXCLUDED.priority, action = EXCLUDED.action, conditions = EXCLUDED.conditions,
                 updated_at = EXCLUDED.updated_at`,
              [
                rule.id,
                rule.name,
                rule.description || '',
                rule.enabled,
                rule.priority,
                rule.action,
                JSON.stringify(rule.conditions),
                rule.createdAt,
                rule.updatedAt,
              ]
            );
          }
        });
        logger.debug(`Decision rules persisted to PostgreSQL: ${this.rules.length} rules`);
        return;
      } catch (error) {
        logger.warn('Failed to save decision rules to PostgreSQL, falling back to file:', error);
      }
    }

    // File-based fallback
    await this.ensureDataDirs();
    await fs.writeFile(RULES_FILE, JSON.stringify(this.rules, null, 2), 'utf-8');
  }

  /**
   * Read decision history for a date
   */
  private async readHistoryFile(dateStr: string): Promise<Decision[]> {
    const filePath = getHistoryFilePath(dateStr);
    try {
      const data = await fs.readFile(filePath, 'utf-8');
      return JSON.parse(data) as Decision[];
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return [];
      }
      logger.error(`Failed to read decision history ${dateStr}:`, error);
      return [];
    }
  }

  /**
   * Write decision history for a date
   */
  private async writeHistoryFile(dateStr: string, decisions: Decision[]): Promise<void> {
    await this.ensureDataDirs();
    const filePath = getHistoryFilePath(dateStr);
    await fs.writeFile(filePath, JSON.stringify(decisions, null, 2), 'utf-8');
  }

  /**
   * Save a decision to history (PostgreSQL or file fallback)
   * Requirements: G3.9, PG.5
   */
  public async saveDecision(decision: Decision): Promise<void> {
    // Try PostgreSQL first if DataStore is available
    if (this.dataStore) {
      try {
        await this.dataStore.execute(
          `INSERT INTO decision_history (id, alert_id, tenant_id, device_id, timestamp, action, reasoning, factors, matched_rule, executed, execution_result)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
           ON CONFLICT (id) DO UPDATE SET
             executed = EXCLUDED.executed,
             execution_result = EXCLUDED.execution_result,
             action = EXCLUDED.action,
             reasoning = EXCLUDED.reasoning`,
          [
            decision.id,
            decision.alertId,
            decision.tenantId || null,
            decision.deviceId || null,
            decision.timestamp,
            decision.action,
            decision.reasoning,
            JSON.stringify(decision.factors),
            decision.matchedRule || null,
            decision.executed,
            decision.executionResult ? JSON.stringify(decision.executionResult) : null,
          ]
        );
        this.decisionCache.set(decision.id, decision);
        return;
      } catch (error) {
        logger.warn('Failed to save decision to PostgreSQL, falling back to file:', error);
      }
    }

    // File-based fallback
    const dateStr = getDateString(decision.timestamp);

    // 串行化同一天的写操作，避免并发 read-modify-write 丢数据
    const prevLock = this.writeLocks.get(dateStr) ?? Promise.resolve();

    // 构建写操作 Promise（不含 finally，用于 await 抛出原始错误）
    const writeOp = prevLock.then(async () => {
      const decisions = await this.readHistoryFile(dateStr);

      const existingIndex = decisions.findIndex((d) => d.id === decision.id);
      if (existingIndex >= 0) {
        decisions[existingIndex] = decision;
      } else {
        decisions.push(decision);
      }

      await this.writeHistoryFile(dateStr, decisions);
      this.decisionCache.set(decision.id, decision);
    });

    // 存入 Map 的是一个不会 reject 的 Promise（供后续请求链式等待）
    // FIX: 在 finally 中安全释放锁，避免竞态条件窗口
    const safeChain = writeOp.catch(() => { /* 吞掉错误，防止后续链式 await 崩溃 */ }).finally(() => {
      // 仅当 Map 中的锁仍是当前实例时才删除，防止误删后续请求设置的新锁
      if (this.writeLocks.get(dateStr) === safeChain) {
        this.writeLocks.delete(dateStr);
      }
    });
    this.writeLocks.set(dateStr, safeChain);

    // await 原始 writeOp 以便向调用方抛出错误
    try {
      await writeOp;
    } catch (error) {
      logger.error(`Failed to save decision ${decision.id}:`, error);
      throw error;
    }
  }


  // ==================== Decision Making ====================

  /**
   * Make a decision for an event
   * Requirements: 8.1, 8.2, 8.3, 8.9, 9.1, 9.2, 9.3, 9.4
   */
  async decide(event: UnifiedEvent, analysis?: RootCauseAnalysis): Promise<Decision> {
    await this.initialize();

    const now = Date.now();
    const decisionId = uuidv4();

    // Build decision context
    const context = await this.buildDecisionContext(event, analysis);

    // G3.7: Temporarily override correlated_alert_count factor with analysis data
    const correlatedCount = analysis?.similarIncidents?.length ?? 0;
    const originalCorrelatedFactor = this.factors.get('correlated_alert_count');
    if (correlatedCount > 0) {
      this.factors.set('correlated_alert_count', {
        name: 'correlated_alert_count',
        weight: originalCorrelatedFactor?.weight ?? 0.10,
        evaluate: (): number => {
          // Normalize: 1 correlated=0.2, 3=0.6, 5+=1.0
          return Math.min(1, correlatedCount / 5);
        },
      });
    }

    // Evaluate all factors
    const factorScores = this.evaluateFactors(event, context);

    // Restore original correlated factor
    if (correlatedCount > 0 && originalCorrelatedFactor) {
      this.factors.set('correlated_alert_count', originalCorrelatedFactor);
    }

    // Find matching rule
    const matchedRule = this.findMatchingRule(factorScores);

    // Determine action - use default decision if no rule matches
    // Requirements: 9.1, 9.2 - 当所有规则禁用时返回默认决策
    let action: DecisionType;
    let usedDefaultDecision = false;

    if (matchedRule) {
      action = matchedRule.action;
    } else {
      // No rule matched (all rules disabled or no matching conditions)
      action = this.defaultDecisionConfig.action;
      usedDefaultDecision = true;
      // Requirements: 9.3 - 记录使用默认决策的情况
      logger.info(`Using default decision for event ${event.id}: action=${action}`);
    }

    // Build reasoning
    const reasoning = this.buildReasoning(event, factorScores, matchedRule, action, usedDefaultDecision);

    const decision: Decision = {
      id: decisionId,
      alertId: event.id,
      tenantId: event.tenantId || event.deviceInfo?.tenantId,
      deviceId: event.deviceId || event.deviceInfo?.id,
      timestamp: now,
      action,
      reasoning,
      factors: factorScores,
      matchedRule: matchedRule?.id,
      executed: false,
    };

    // Save decision
    await this.saveDecision(decision);

    // Log audit
    // Requirements: 8.9 - 决策时记录决策推理用于审计
    await auditLogger.log({
      action: 'alert_trigger',
      actor: 'system',
      tenantId: decision.tenantId,
      deviceId: decision.deviceId,
      details: {
        trigger: 'decision_made',
        metadata: {
          decisionId: decision.id,
          alertId: event.id,
          action: decision.action,
          reasoning: decision.reasoning,
        },
      },
    });

    logger.info(`Decision made for event ${event.id}: ${action} (rule: ${matchedRule?.name || 'default'})`);
    return decision;
  }

  /**
   * Build decision context
   */
  private async buildDecisionContext(
    event: UnifiedEvent,
    analysis?: RootCauseAnalysis
  ): Promise<DecisionContext> {
    // Get recent decisions for historical success rate
    const recentDecisions = await this.getDecisionHistory(undefined, 100);

    // Calculate historical success rate
    const executedDecisions = recentDecisions.filter((d) => d.executed && d.executionResult);
    const successfulDecisions = executedDecisions.filter((d) => d.executionResult?.success);
    const historicalSuccessRate = executedDecisions.length > 0
      ? successfulDecisions.length / executedDecisions.length
      : 0.5; // Default to 50% if no history

    // Get affected scope from analysis or estimate
    const affectedScope: ImpactAssessment = analysis?.impact || {
      scope: this.estimateScope(event),
      affectedResources: [event.category],
      estimatedUsers: this.estimateUsers(event),
      services: [],
      networkSegments: [],
    };

    return {
      currentTime: new Date(),
      historicalSuccessRate,
      affectedScope,
      recentDecisions: recentDecisions.slice(0, 10),
    };
  }

  /**
   * Estimate impact scope from event
   */
  private estimateScope(event: UnifiedEvent): ImpactScope {
    if (event.severity === 'emergency') return 'widespread';
    if (event.severity === 'critical') return 'partial';
    return 'local';
  }

  /**
   * Estimate affected users from event
   */
  private estimateUsers(event: UnifiedEvent): number {
    const baseEstimates: Record<string, number> = {
      emergency: 100,
      critical: 50,
      warning: 10,
      info: 1,
    };
    return baseEstimates[event.severity] || 5;
  }

  /**
   * Evaluate all factors for an event
   * Requirements: 8.3 - 决策考虑因素
   */
  private evaluateFactors(event: UnifiedEvent, context: DecisionContext): DecisionFactorScore[] {
    const scores: DecisionFactorScore[] = [];

    for (const [name, factor] of this.factors) {
      try {
        const score = factor.evaluate(event, context);
        scores.push({
          name,
          score: Math.max(0, Math.min(1, score)), // Clamp to [0, 1]
          weight: factor.weight,
        });
      } catch (error) {
        logger.warn(`Failed to evaluate factor ${name}:`, error);
        scores.push({
          name,
          score: 0.5, // Default to neutral
          weight: factor.weight,
        });
      }
    }

    return scores;
  }


  /**
   * Find matching rule based on factor scores
   */
  private findMatchingRule(factorScores: DecisionFactorScore[]): DecisionRule | null {
    // Sort rules by priority (lower number = higher priority)
    const sortedRules = [...this.rules]
      .filter((r) => r.enabled)
      .sort((a, b) => a.priority - b.priority);

    // Create score map for easy lookup
    const scoreMap = new Map<string, number>();
    for (const fs of factorScores) {
      scoreMap.set(fs.name, fs.score);
    }

    // Find first matching rule
    for (const rule of sortedRules) {
      if (this.ruleMatches(rule, scoreMap)) {
        return rule;
      }
    }

    return null;
  }

  /**
   * Check if a rule matches the current factor scores
   */
  private ruleMatches(rule: DecisionRule, scoreMap: Map<string, number>): boolean {
    // Empty conditions = always matches (fallback rule)
    if (rule.conditions.length === 0) {
      return true;
    }

    // All conditions must match
    return rule.conditions.every((condition) => {
      const score = scoreMap.get(condition.factor);
      if (score === undefined) {
        return false;
      }
      return this.evaluateCondition(score, condition);
    });
  }

  /**
   * Evaluate a single condition
   */
  private evaluateCondition(score: number, condition: DecisionCondition): boolean {
    switch (condition.operator) {
      case 'gt':
        return score > condition.value;
      case 'lt':
        return score < condition.value;
      case 'eq':
        return Math.abs(score - condition.value) < 0.001;
      case 'gte':
        return score >= condition.value;
      case 'lte':
        return score <= condition.value;
      default:
        return false;
    }
  }

  /**
   * Build reasoning string for audit
   * Requirements: 8.9, 9.3 - 决策时记录决策推理用于审计
   */
  private buildReasoning(
    event: UnifiedEvent,
    factorScores: DecisionFactorScore[],
    matchedRule: DecisionRule | null,
    action: DecisionType,
    usedDefaultDecision: boolean = false
  ): string {
    const parts: string[] = [];

    // Event summary
    parts.push(`Event: ${event.category} - ${event.severity} severity`);

    // Factor scores summary
    const factorSummary = factorScores
      .map((f) => `${f.name}=${f.score.toFixed(2)}`)
      .join(', ');
    parts.push(`Factors: ${factorSummary}`);

    // Rule match
    if (matchedRule) {
      parts.push(`Matched rule: "${matchedRule.name}" (priority ${matchedRule.priority})`);
    } else if (usedDefaultDecision) {
      // Requirements: 9.3 - 记录使用默认决策的情况
      parts.push('No enabled rules matched, using default decision configuration');
    } else {
      parts.push('No rule matched, using default action');
    }

    // Action explanation
    const actionExplanations: Record<DecisionType, string> = {
      auto_execute: 'Automatic remediation will be triggered',
      auto_remediate: 'Automatic remediation will be triggered',
      notify_and_wait: 'Notification sent, awaiting human confirmation',
      escalate: 'Escalating to higher-level personnel',
      silence: 'Alert suppressed but logged for audit',
      observe: 'Alert observed and logged, no active action taken',
    };
    parts.push(`Decision: ${action} - ${actionExplanations[action] || action}`);

    return parts.join('. ');
  }


  // ==================== Decision Execution ====================

  /**
   * Execute a decision
   * Requirements: 8.4, 8.5, 8.6, 8.7
   * 
   * @param decision 决策对象
   * @param plan 可选的修复方案
   * @param event 可选的原始事件（用于发送更详细的通知）
   */
  async executeDecision(
    decision: Decision,
    plan?: RemediationPlan,
    event?: UnifiedEvent
  ): Promise<void> {
    await this.initialize();

    try {
      switch (decision.action) {
        case 'auto_execute':
        case 'auto_remediate':
          // Requirements: 8.4 - auto_execute/auto_remediate 决策触发自动修复
          await this.executeAutoExecute(decision, plan, event);
          break;

        case 'notify_and_wait':
          // Requirements: 8.5 - notify_and_wait 决策发送通知并等待确认
          await this.executeNotifyAndWait(decision, event);
          break;

        case 'escalate':
          // Requirements: 8.6 - escalate 决策通知更高级别人员并提升优先级
          await this.executeEscalate(decision, event);
          break;

        case 'silence':
          // Requirements: 8.7 - silence 决策抑制告警但记录审计日志
          await this.executeSilence(decision);
          break;

        case 'observe':
          // G3.7: observe 决策 - 记录日志但不执行主动操作
          await this.executeObserve(decision);
          break;

        default:
          logger.warn(`Unknown decision action: ${decision.action}`);
      }

      // Update decision as executed
      decision.executed = true;
      // FIX: 通知失败时标注到 executionResult，不再静默显示"成功"
      const nfFailed = (decision as any).notificationFailed === true;
      decision.executionResult = {
        success: !nfFailed,
        details: nfFailed
          ? `Decision ${decision.action} executed but notification failed: ${(decision as any).notificationError}`
          : `Decision ${decision.action} executed successfully`,
      };
      await this.saveDecision(decision);

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error(`Failed to execute decision ${decision.id}:`, error);

      decision.executed = true;
      decision.executionResult = {
        success: false,
        details: `Execution failed: ${errorMessage}`,
      };
      await this.saveDecision(decision);

      // Log failure
      await auditLogger.log({
        action: 'alert_trigger',
        actor: 'system',
        tenantId: decision.tenantId,
        deviceId: decision.deviceId,
        details: {
          trigger: 'decision_execution_failed',
          error: errorMessage,
          metadata: {
            decisionId: decision.id,
            action: decision.action,
          },
        },
      });
    }
  }

  /**
   * Execute auto_execute decision
   * Requirements: 8.4, critic-reflector 11.1-11.6
   * - 11.1: 在 DecisionEngine 执行 auto_execute 后触发 IterationLoop
   * - 11.2: 检查功能开关配置，仅在启用时触发
   * - 11.3: 使用 startAsync() 进行异步触发，避免阻塞主流程
   * - 11.4: 传递 alert event, decision, plan 到 IterationLoop
   */
  private async executeAutoExecute(
    decision: Decision,
    plan?: RemediationPlan,
    event?: UnifiedEvent
  ): Promise<void> {
    logger.info(`Executing auto_execute decision ${decision.id}`);

    if (plan) {
      // Execute auto-executable steps from the plan
      try {
        let results: ExecutionResult[] = [];

        // FaultHealer 集成：如果匹配到已知故障模式，优先使用 FaultHealer 执行修复
        if (plan.matchedFaultPatternId) {
          logger.info(`Pattern-based remediation detected: ${plan.matchedFaultPatternId}`);
          const execution = await faultHealer.executeRemediation(
            plan.matchedFaultPatternId,
            plan.alertId,
            plan.tenantId,
            plan.deviceId
          );

          // 将 FaultHealer 的执行记录映射为 ExecutionResult 格式以便流水线继续处理
          results = [{
            stepOrder: 1,
            success: execution.status === 'success',
            output: execution.executionResult?.output,
            error: execution.executionResult?.error,
            duration: execution.completedAt ? (execution.completedAt - execution.startedAt) / 1000 : 0,
            verificationPassed: execution.verificationResult?.passed
          }];
        } else {
          results = await remediationAdvisor.executeAutoSteps(plan.id);
        }

        const allSucceeded = results.every((r) => r.success);

        logger.info(
          `Auto-execution completed for plan ${plan.id}: ${results.length} steps, ` +
          `success: ${allSucceeded}`
        );

        // FIX: 自动执行完成后发送通知，告知用户系统已自动处理
        const autoExecChannelIds = await this.getEffectiveNotifyChannels(event);
        if (autoExecChannelIds.length > 0) {
          const severity = event?.severity || 'warning';
          const category = event?.category || 'Unknown';
          const statusEmoji = allSucceeded ? '✅' : '⚠️';
          const statusText = allSucceeded ? '自动修复成功' : '自动修复部分失败';

          notificationService.send(autoExecChannelIds, {
            type: 'alert',
            title: `${statusEmoji} 自动执行: ${category}`,
            body: `系统已自动处理告警。\n\n` +
              `执行结果: ${statusText}\n` +
              `执行步骤: ${results.length} 步\n` +
              `决策原因: ${decision.reasoning}`,
            data: {
              decisionId: decision.id,
              alertId: decision.alertId,
              action: 'auto_execute',
              severity,
              category,
              autoExecuteSuccess: allSucceeded,
              stepsExecuted: results.length,
              identity: event?.deviceInfo?.hostname || event?.deviceId || 'Unknown',
            },
          }).catch(err => {
            // 自动执行通知失败不影响主流程（修复本身已完成）
            logger.warn(`Auto-execute notification failed for decision ${decision.id}:`, err);
          });
        }

        // Requirements: critic-reflector 11.1-11.4
        // 触发 IterationLoop 进行迭代优化（如果启用）
        if (event && plan) {
          try {
            const { iterationLoop } = await import('./iterationLoop');

            // 11.2: 检查功能开关
            if (iterationLoop.isEnabled()) {
              // 11.3: 使用 startAsync() 异步触发，不阻塞主流程
              const iterationId = iterationLoop.startAsync(event, decision, plan);
              logger.info(`IterationLoop triggered for plan ${plan.id}, iteration: ${iterationId}`);
            } else {
              logger.debug('IterationLoop is disabled, skipping iteration optimization');
            }
          } catch (iterError) {
            // 迭代循环失败不影响主流程
            logger.warn('Failed to trigger IterationLoop:', iterError);
          }
        }
      } catch (error) {
        logger.error(`Auto-execution failed for plan ${plan.id}:`, error);
        throw error;
      }
    } else {
      // No plan provided, just log the decision
      logger.info(`Auto-execute decision ${decision.id} - no remediation plan provided`);
    }

    // Log audit
    await auditLogger.log({
      action: 'remediation_execute',
      actor: 'system',
      tenantId: decision.tenantId,
      deviceId: decision.deviceId,
      details: {
        trigger: 'auto_execute_decision',
        metadata: {
          decisionId: decision.id,
          alertId: decision.alertId,
          planId: plan?.id,
        },
      },
    });
  }

  /**
   * 获取有效的通知渠道
   * Requirements: 5.1, 5.2 - 默认决策通知渠道回退
   * 如果事件自带 notifyChannels，优先使用
   * 如果默认决策配置中 notifyChannels 为空，回退到使用所有已启用的通知渠道
   */
  private async getEffectiveNotifyChannels(event?: UnifiedEvent): Promise<string[]> {
    try {
      // 1. 优先使用事件自带的通知渠道 (Requirements: System Association Issue #2)
      if (event && event.notifyChannels && event.notifyChannels.length > 0) {
        return event.notifyChannels;
      }

      const channels = await notificationService.getChannels();
      const enabledChannelIds = channels
        .filter((c) => c.enabled)
        .map((c) => c.id);

      // 如果默认配置的通知渠道为空，使用所有已启用渠道 (Requirements: 5.2)
      if (this.defaultDecisionConfig.notifyChannels.length === 0) {
        logger.debug('Default notifyChannels is empty, using all enabled channels', {
          enabledChannels: enabledChannelIds.length,
        });
        return enabledChannelIds;
      }

      // 过滤出配置中存在且已启用的渠道
      const effectiveChannels = this.defaultDecisionConfig.notifyChannels.filter(
        id => enabledChannelIds.includes(id)
      );

      // 如果配置的渠道都不可用，回退到所有已启用渠道
      if (effectiveChannels.length === 0 && enabledChannelIds.length > 0) {
        logger.warn('Configured notifyChannels are not available, falling back to all enabled channels');
        return enabledChannelIds;
      }

      return effectiveChannels;
    } catch (error) {
      logger.error('Failed to get notification channels:', error);
      return [];
    }
  }

  /**
   * Execute notify_and_wait decision
   * Requirements: 8.5, 5.1, 5.4
   */
  private async executeNotifyAndWait(decision: Decision, event?: UnifiedEvent): Promise<void> {
    logger.info(`Executing notify_and_wait decision ${decision.id}`);

    // P7: 先唤醒中央大脑（fire-and-forget），确保即使通知发送挂起/失败，大脑也能感知到待处理决策
    autonomousBrainService.triggerTick('decision_pending', {
      decisionId: decision.id,
      alertId: decision.alertId
    }).catch(err => {
      logger.warn('Failed to trigger autonomous brain tick for decision pending', { error: err });
    });

    // 使用 getEffectiveNotifyChannels 获取通知渠道 (Requirements: 5.1, Issue #2)
    const enabledChannelIds = await this.getEffectiveNotifyChannels(event);

    // FIX: 跟踪通知发送结果，失败时标注到 decision 上，不再静默吞掉
    let notificationFailed = false;
    let notificationError: string | undefined;

    if (enabledChannelIds.length > 0) {
      // 构建通知标题和内容
      const severityEmoji: Record<string, string> = {
        info: '📢',
        warning: '⚠️',
        critical: '🔴',
        emergency: '🚨',
      };

      const severity = event?.severity || 'warning';
      const emoji = severityEmoji[severity] || '⚠️';
      const category = event?.category || 'Unknown';
      const message = event?.message || decision.reasoning;

      const title = `${emoji} ${severity.toUpperCase()} - ${category}`;
      const body = `${message}\n\n` +
        `决策: ${decision.action}\n` +
        `原因: ${decision.reasoning}`;

      try {
        const result = await notificationService.send(enabledChannelIds, {
          type: 'alert',
          title,
          body,
          data: {
            decisionId: decision.id,
            alertId: decision.alertId,
            action: decision.action,
            severity,
            category,
            factors: decision.factors,
            identity: event?.deviceInfo?.hostname || event?.deviceId || 'Unknown',
            ip_address: event?.deviceInfo?.ip || 'Unknown',
            current_value: event?.metadata?.currentValue ?? event?.alertRuleInfo?.currentValue ?? 'N/A',
            threshold: event?.metadata?.threshold ?? event?.alertRuleInfo?.threshold ?? 'N/A',
            metric: event?.metadata?.metric ?? event?.alertRuleInfo?.metric ?? 'Unknown',
            status: event?.metadata?.status === 'resolved' ? '✅ 已恢复' : '🔥 触发中',
          },
        });

        if (!result.success) {
          notificationFailed = true;
          notificationError = `Failed channels: ${result.failedChannels.join(', ')}`;
          logger.error(`Notification partially/fully failed for decision ${decision.id}: ${notificationError}`);
        }
      } catch (err) {
        notificationFailed = true;
        notificationError = err instanceof Error ? err.message : String(err);
        logger.error(`Notification send failed for decision ${decision.id}:`, err);
      }

      // Requirements: 5.4 - 记录使用默认决策的日志
      if (this.defaultDecisionConfig.notifyChannels.length === 0) {
        logger.info(`Notification sent using fallback channels for decision ${decision.id}`);
      }
    } else {
      notificationFailed = true;
      notificationError = 'No notification channels available';
      logger.warn(`No notification channels available for decision ${decision.id}`);
    }

    // FIX: 将通知失败状态写入 decision，供上层感知
    if (notificationFailed) {
      (decision as any).notificationFailed = true;
      (decision as any).notificationError = notificationError;
    }

    // Log audit
    await auditLogger.log({
      action: 'alert_trigger',
      actor: 'system',
      tenantId: decision.tenantId,
      deviceId: decision.deviceId,
      details: {
        trigger: 'notify_and_wait_decision',
        metadata: {
          decisionId: decision.id,
          alertId: decision.alertId,
          notifiedChannels: enabledChannelIds.length,
          notificationFailed,
          notificationError,
        },
      },
    });
  }


  /**
   * Execute escalate decision
   * Requirements: 8.6, 5.1, 5.4
   */
  private async executeEscalate(decision: Decision, event?: UnifiedEvent): Promise<void> {
    logger.info(`Executing escalate decision ${decision.id}`);

    // 使用 getEffectiveNotifyChannels 获取通知渠道 (Requirements: 5.1)
    const enabledChannelIds = await this.getEffectiveNotifyChannels();

    // FIX: 跟踪通知发送结果，失败时标注到 decision 上
    let notificationFailed = false;
    let notificationError: string | undefined;

    if (enabledChannelIds.length > 0) {
      const category = event?.category || 'Unknown';
      const message = event?.message || decision.reasoning;
      const severity = event?.severity || 'emergency';

      try {
        const result = await notificationService.send(enabledChannelIds, {
          type: 'alert',
          title: `🚨 紧急升级: ${category}`,
          body: `此告警已升级，需要立即处理！\n\n` +
            `${message}\n\n` +
            `严重级别: ${severity.toUpperCase()}\n` +
            `决策原因: ${decision.reasoning}\n\n` +
            `优先级: 高 - 请立即响应！`,
          data: {
            decisionId: decision.id,
            alertId: decision.alertId,
            action: decision.action,
            priority: 'high',
            escalated: true,
            severity,
            category,
            factors: decision.factors,
            identity: event?.deviceInfo?.hostname || event?.deviceId || 'Unknown',
            ip_address: event?.deviceInfo?.ip || 'Unknown',
            current_value: event?.metadata?.currentValue ?? event?.alertRuleInfo?.currentValue ?? 'N/A',
            threshold: event?.metadata?.threshold ?? event?.alertRuleInfo?.threshold ?? 'N/A',
            metric: event?.metadata?.metric ?? event?.alertRuleInfo?.metric ?? 'Unknown',
            status: event?.metadata?.status === 'resolved' ? '✅ 已恢复' : '🔥 触发中',
          },
        });

        if (!result.success) {
          notificationFailed = true;
          notificationError = `Failed channels: ${result.failedChannels.join(', ')}`;
          logger.error(`Escalation notification partially/fully failed for decision ${decision.id}: ${notificationError}`);
        }
      } catch (err) {
        notificationFailed = true;
        notificationError = err instanceof Error ? err.message : String(err);
        logger.error(`Escalation notification send failed for decision ${decision.id}:`, err);
      }

      // Requirements: 5.4 - 记录使用默认决策的日志
      if (this.defaultDecisionConfig.notifyChannels.length === 0) {
        logger.info(`Escalation notification sent using fallback channels for decision ${decision.id}`);
      }
    } else {
      notificationFailed = true;
      notificationError = 'No notification channels available for escalation';
      logger.warn(`No notification channels available for escalation decision ${decision.id}`);
    }

    // FIX: 将通知失败状态写入 decision
    if (notificationFailed) {
      (decision as any).notificationFailed = true;
      (decision as any).notificationError = notificationError;
    }

    // Log audit
    await auditLogger.log({
      action: 'alert_trigger',
      actor: 'system',
      tenantId: decision.tenantId,
      deviceId: decision.deviceId,
      details: {
        trigger: 'escalate_decision',
        metadata: {
          decisionId: decision.id,
          alertId: decision.alertId,
          escalatedTo: enabledChannelIds,
          notificationFailed,
          notificationError,
        },
      },
    });
  }

  /**
   * Execute silence decision
   * Requirements: 8.7
   */
  private async executeSilence(decision: Decision): Promise<void> {
    logger.info(`Executing silence decision ${decision.id}`);

    // Silence means we suppress the alert but still log it
    // No notification is sent, but audit log is recorded

    await auditLogger.log({
      action: 'alert_trigger',
      actor: 'system',
      details: {
        trigger: 'silence_decision',
        metadata: {
          decisionId: decision.id,
          alertId: decision.alertId,
          reasoning: decision.reasoning,
          silenced: true,
        },
      },
    });
  }

  /**
   * Execute observe decision
   * G3.7: observe 决策 - 记录决策日志到 decision_history，不执行主动操作
   * Similar to silence but with explicit observation logging
   */
  private async executeObserve(decision: Decision): Promise<void> {
    logger.info(`Executing observe decision ${decision.id} - logging only, no active action`);

    await auditLogger.log({
      action: 'alert_trigger',
      actor: 'system',
      tenantId: decision.tenantId,
      deviceId: decision.deviceId,
      details: {
        trigger: 'observe_decision',
        metadata: {
          decisionId: decision.id,
          alertId: decision.alertId,
          reasoning: decision.reasoning,
          observed: true,
        },
      },
    });

    // Publish event to EventBus if available
    if (this.eventBus) {
      this.eventBus.publish({
        type: 'internal',
        payload: {
          subType: 'decision_observed',
          decisionId: decision.id,
          alertId: decision.alertId,
          reasoning: decision.reasoning,
        },
        priority: 'low',
        source: 'decision_engine',
        schemaVersion: '1.0',
      }).catch(err => {
        logger.warn('Failed to publish observe event to EventBus:', err);
      });
    }
  }

  // ==================== Feedback Weight Adjustment (G3.10) ====================

  /**
   * Adjust factor weights based on decision feedback
   * Requirements: G3.10 - 通过反馈闭环优化权重
   *
   * @param feedback - { decisionId, outcome ('success'|'failure'|'partial'), score (0-1) }
   */
  async adjustWeights(feedback: { decisionId: string; outcome: string; score: number }): Promise<void> {
    await this.initialize();

    const decision = await this.getDecisionById(feedback.decisionId);
    if (!decision) {
      logger.warn(`adjustWeights: decision not found: ${feedback.decisionId}`);
      return;
    }

    // Find the matched rule
    if (!decision.matchedRule) {
      logger.debug(`adjustWeights: decision ${feedback.decisionId} has no matched rule, skipping`);
      return;
    }

    const rule = this.rules.find(r => r.id === decision.matchedRule);
    if (!rule) {
      logger.debug(`adjustWeights: rule ${decision.matchedRule} not found, skipping`);
      return;
    }

    // Adjustment rate: small increments to avoid oscillation
    const LEARNING_RATE = 0.02;
    const isPositive = feedback.outcome === 'success' && feedback.score >= 0.7;
    const isNegative = feedback.outcome === 'failure' || feedback.score < 0.3;

    if (!isPositive && !isNegative) {
      logger.debug(`adjustWeights: neutral feedback for decision ${feedback.decisionId}, no adjustment`);
      return;
    }

    // Adjust factor weights based on which factors contributed most to this decision
    for (const factorScore of decision.factors) {
      const factor = this.factors.get(factorScore.name);
      if (!factor) continue;

      // If positive outcome: reinforce factors that scored high
      // If negative outcome: reduce weight of factors that scored high
      const adjustment = isPositive
        ? LEARNING_RATE * factorScore.score
        : -LEARNING_RATE * factorScore.score;

      factor.weight = Math.max(0.01, Math.min(0.5, factor.weight + adjustment));
    }

    // Normalize weights to sum to ~1.0
    const totalWeight = Array.from(this.factors.values()).reduce((sum, f) => sum + f.weight, 0);
    if (totalWeight > 0) {
      for (const factor of this.factors.values()) {
        factor.weight = factor.weight / totalWeight;
      }
    }

    // Also adjust rule priority based on feedback
    if (isPositive && rule.priority > 2) {
      rule.priority = Math.max(rule.priority - 1, 2);
      rule.updatedAt = Date.now();
    } else if (isNegative && rule.priority < 90) {
      rule.priority = Math.min(rule.priority + 2, 90);
      rule.updatedAt = Date.now();
    }

    await this.saveRules();

    logger.info(`Weights adjusted for decision ${feedback.decisionId}: outcome=${feedback.outcome}, score=${feedback.score}`);

    // Publish feedback event to EventBus if available
    if (this.eventBus) {
      this.eventBus.publish({
        type: 'internal',
        payload: {
          subType: 'decision_feedback_applied',
          decisionId: feedback.decisionId,
          outcome: feedback.outcome,
          score: feedback.score,
          ruleId: rule.id,
        },
        priority: 'low',
        source: 'decision_engine',
        schemaVersion: '1.0',
      }).catch(err => {
        logger.warn('Failed to publish feedback event to EventBus:', err);
      });
    }
  }

  // ==================== Rule Management ====================

  /**
   * Add a decision rule
   * Requirements: 8.8
   */
  addRule(rule: DecisionRule): void {
    const existingIndex = this.rules.findIndex((r) => r.id === rule.id);
    if (existingIndex >= 0) {
      this.rules[existingIndex] = rule;
      logger.info(`Decision rule updated: ${rule.name}`);
    } else {
      this.rules.push(rule);
      logger.info(`Decision rule added: ${rule.name}`);
    }
    this.saveRules().catch((err) => logger.error('Failed to save rules:', err));
  }

  /**
   * Create a new decision rule
   * Requirements: 8.8
   */
  async createRule(input: CreateDecisionRuleInput): Promise<DecisionRule> {
    await this.initialize();

    const now = Date.now();
    const rule: DecisionRule = {
      id: uuidv4(),
      createdAt: now,
      updatedAt: now,
      ...input,
    };

    this.rules.push(rule);
    await this.saveRules();

    logger.info(`Decision rule created: ${rule.name}`);
    return rule;
  }

  /**
   * Update a decision rule
   * Requirements: 8.8
   */
  updateRule(id: string, updates: Partial<DecisionRule>): void {
    const index = this.rules.findIndex((r) => r.id === id);
    if (index === -1) {
      throw new Error(`Decision rule not found: ${id}`);
    }

    const rule = this.rules[index];
    this.rules[index] = {
      ...rule,
      ...updates,
      id: rule.id, // Preserve ID
      updatedAt: Date.now(),
    };

    logger.info(`Decision rule updated: ${this.rules[index].name}`);
    this.saveRules().catch((err) => logger.error('Failed to save rules:', err));
  }

  /**
   * Update a decision rule (async version)
   * Requirements: 8.8
   */
  async updateRuleAsync(id: string, updates: UpdateDecisionRuleInput): Promise<DecisionRule> {
    await this.initialize();

    const index = this.rules.findIndex((r) => r.id === id);
    if (index === -1) {
      throw new Error(`Decision rule not found: ${id}`);
    }

    const rule = this.rules[index];
    const updatedRule: DecisionRule = {
      ...rule,
      ...updates,
      id: rule.id,
      updatedAt: Date.now(),
    };

    this.rules[index] = updatedRule;
    await this.saveRules();

    logger.info(`Decision rule updated: ${updatedRule.name}`);
    return updatedRule;
  }

  /**
   * Remove a decision rule
   * Requirements: 8.8
   */
  removeRule(id: string): void {
    const index = this.rules.findIndex((r) => r.id === id);
    if (index === -1) {
      throw new Error(`Decision rule not found: ${id}`);
    }

    const rule = this.rules[index];
    this.rules.splice(index, 1);

    logger.info(`Decision rule removed: ${rule.name}`);
    this.saveRules().catch((err) => logger.error('Failed to save rules:', err));
  }

  /**
   * Delete a decision rule (async version)
   * Requirements: 8.8
   */
  async deleteRule(id: string): Promise<void> {
    await this.initialize();

    const index = this.rules.findIndex((r) => r.id === id);
    if (index === -1) {
      throw new Error(`Decision rule not found: ${id}`);
    }

    const rule = this.rules[index];
    this.rules.splice(index, 1);
    await this.saveRules();

    logger.info(`Decision rule deleted: ${rule.name}`);
  }

  /**
   * Get all decision rules
   * Requirements: 8.8
   */
  getRules(): DecisionRule[] {
    return [...this.rules];
  }

  /**
   * Get a decision rule by ID
   */
  async getRuleById(id: string): Promise<DecisionRule | null> {
    await this.initialize();
    return this.rules.find((r) => r.id === id) || null;
  }


  // ==================== Factor Management ====================

  /**
   * Register a decision factor
   */
  registerFactor(factor: DecisionFactor): void {
    this.factors.set(factor.name, factor);
    logger.info(`Decision factor registered: ${factor.name}`);
  }

  /**
   * Get all registered factors
   */
  getFactors(): DecisionFactor[] {
    return Array.from(this.factors.values());
  }

  /**
   * Get factor names (for serialization)
   */
  getFactorNames(): string[] {
    return Array.from(this.factors.keys());
  }

  // ==================== Decision History ====================

  /**
   * Get decision history
   */
  async getDecisionHistory(alertId?: string, limit: number = 100): Promise<Decision[]> {
    await this.initialize();

    // PostgreSQL path
    if (this.dataStore) {
      try {
        let query = 'SELECT * FROM decision_history';
        const params: any[] = [];
        let paramIdx = 1;

        if (alertId) {
          query += ` WHERE alert_id = $${paramIdx++}`;
          params.push(alertId);
        }

        query += ` ORDER BY timestamp DESC LIMIT $${paramIdx}`;
        params.push(limit);

        const rows = await this.dataStore.query<{
          id: string;
          alert_id: string;
          tenant_id: string | null;
          device_id: string | null;
          timestamp: number;
          action: string;
          reasoning: string;
          factors: string;
          matched_rule: string | null;
          executed: boolean;
          execution_result: string | null;
        }>(query, params);

        return rows.map(row => ({
          id: row.id,
          alertId: row.alert_id,
          tenantId: row.tenant_id || undefined,
          deviceId: row.device_id || undefined,
          timestamp: typeof row.timestamp === 'number' ? row.timestamp : new Date(row.timestamp as any).getTime(),
          action: row.action as DecisionType,
          reasoning: row.reasoning,
          factors: typeof row.factors === 'string' ? JSON.parse(row.factors) : row.factors,
          matchedRule: row.matched_rule || undefined,
          executed: Boolean(row.executed),
          executionResult: row.execution_result
            ? (typeof row.execution_result === 'string' ? JSON.parse(row.execution_result) : row.execution_result)
            : undefined,
        }));
      } catch (error) {
        logger.warn('Failed to get decision history from PostgreSQL, falling back to file:', error);
      }
    }

    // File-based fallback: List all history files
    let files: string[];
    try {
      files = await fs.readdir(HISTORY_DIR);
      files = files
        .filter((f) => f.endsWith('.json'))
        .map((f) => f.replace('.json', ''))
        .sort()
        .reverse(); // Most recent first
    } catch {
      return [];
    }

    // Collect decisions
    let allDecisions: Decision[] = [];

    for (const dateStr of files) {
      if (allDecisions.length >= limit) break;

      const decisions = await this.readHistoryFile(dateStr);
      allDecisions = allDecisions.concat(decisions);
    }

    // Filter by alertId if provided
    if (alertId) {
      allDecisions = allDecisions.filter((d) => d.alertId === alertId);
    }

    // Sort by timestamp (descending)
    allDecisions.sort((a, b) => b.timestamp - a.timestamp);

    // Apply limit
    return allDecisions.slice(0, limit);
  }

  /**
   * Get a decision by ID
   */
  async getDecisionById(id: string): Promise<Decision | null> {
    // Check cache first
    if (this.decisionCache.has(id)) {
      return this.decisionCache.get(id) || null;
    }

    // Search in history files
    const decisions = await this.getDecisionHistory(undefined, 1000);
    return decisions.find((d) => d.id === id) || null;
  }

  /**
   * Get decisions for a specific alert
   */
  async getDecisionsForAlert(alertId: string): Promise<Decision[]> {
    return this.getDecisionHistory(alertId);
  }

  // ==================== Statistics ====================

  /**
   * Get decision statistics
   */
  async getStatistics(): Promise<{
    totalDecisions: number;
    byAction: Record<DecisionType, number>;
    successRate: number;
    avgFactorScores: Record<string, number>;
  }> {
    const decisions = await this.getDecisionHistory(undefined, 1000);

    const byAction: Record<DecisionType, number> = {
      auto_execute: 0,
      auto_remediate: 0,
      notify_and_wait: 0,
      escalate: 0,
      silence: 0,
      observe: 0,
    };

    const factorSums: Record<string, number> = {};
    const factorCounts: Record<string, number> = {};
    let executedCount = 0;
    let successCount = 0;

    for (const decision of decisions) {
      byAction[decision.action]++;

      if (decision.executed && decision.executionResult) {
        executedCount++;
        if (decision.executionResult.success) {
          successCount++;
        }
      }

      for (const factor of decision.factors) {
        factorSums[factor.name] = (factorSums[factor.name] || 0) + factor.score;
        factorCounts[factor.name] = (factorCounts[factor.name] || 0) + 1;
      }
    }

    const avgFactorScores: Record<string, number> = {};
    for (const name of Object.keys(factorSums)) {
      avgFactorScores[name] = factorSums[name] / factorCounts[name];
    }

    return {
      totalDecisions: decisions.length,
      byAction,
      successRate: executedCount > 0 ? successCount / executedCount : 0,
      avgFactorScores,
    };
  }

  /**
   * Cleanup old decision history
   */
  async cleanup(retentionDays: number = 90): Promise<number> {
    // PostgreSQL path
    if (this.dataStore) {
      try {
        const cutoffTs = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
        const result = await this.dataStore.execute(
          'DELETE FROM decision_history WHERE timestamp < $1',
          [cutoffTs]
        );
        logger.info(`Cleaned up ${result.rowCount} expired decision history records from PostgreSQL`);
        return result.rowCount;
      } catch (error) {
        logger.warn('Failed to cleanup decision history from PostgreSQL, falling back to file:', error);
      }
    }

    // File-based fallback
    await this.ensureDataDirs();

    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - retentionDays);
    cutoffDate.setHours(0, 0, 0, 0);
    const cutoffDateStr = getDateString(cutoffDate.getTime());

    let files: string[];
    try {
      files = await fs.readdir(HISTORY_DIR);
      files = files
        .filter((f) => f.endsWith('.json'))
        .map((f) => f.replace('.json', ''));
    } catch {
      return 0;
    }

    let deletedCount = 0;

    for (const dateStr of files) {
      if (dateStr < cutoffDateStr) {
        const filePath = getHistoryFilePath(dateStr);
        try {
          const decisions = await this.readHistoryFile(dateStr);
          deletedCount += decisions.length;
          await fs.unlink(filePath);
          logger.info(`Deleted expired decision history: ${dateStr} (${decisions.length} records)`);
        } catch (error) {
          logger.error(`Failed to delete decision history ${dateStr}:`, error);
        }
      }
    }

    return deletedCount;
  }

  // ==================== Default Decision Configuration ====================

  /**
   * Set default decision configuration
   * Requirements: 9.4 - 默认决策可通过配置自定义
   */
  setDefaultDecision(config: DefaultDecisionConfig): void {
    this.defaultDecisionConfig = { ...config };
    logger.info('Default decision configuration updated', { config: this.defaultDecisionConfig });
  }

  /**
   * Get default decision configuration
   * Requirements: 9.2 - 默认决策包含 action 为 'notify' 和合理的默认参数
   */
  getDefaultDecision(): DefaultDecisionConfig {
    return { ...this.defaultDecisionConfig };
  }

  // ==================== Learning Integration ====================
  // Requirements: critic-reflector 13.1-13.4

  /**
   * 基于学习内容调整规则权重
   * Requirements: 13.1 - 实现基于学习内容调整规则权重
   */
  async adjustRuleWeightsFromLearning(): Promise<void> {
    await this.initialize();

    try {
      const { reflectorService } = await import('./reflectorService');
      const stats = await reflectorService.getStats();

      // 根据决策分布调整规则
      const totalDecisions = Object.values(stats.decisionDistribution).reduce((a, b) => a + b, 0);
      if (totalDecisions < 10) {
        logger.debug('Not enough learning data to adjust rule weights');
        return;
      }

      // 计算各决策类型的成功率
      const successRates: Record<string, number> = {};
      for (const [action, count] of Object.entries(stats.decisionDistribution)) {
        // 简化处理：假设 complete 决策表示成功
        if (action === 'complete') {
          successRates[action] = 1.0;
        } else if (action === 'escalate' || action === 'rollback') {
          successRates[action] = 0.0;
        } else {
          successRates[action] = count / totalDecisions;
        }
      }

      // 更新规则优先级（基于学习）
      for (const rule of this.rules) {
        const ruleStats = await this.getRuleSuccessRate(rule.id);
        if (ruleStats.totalExecutions >= 5) {
          // 如果规则成功率低于 50%，降低其优先级
          if (ruleStats.successRate < 0.5 && rule.priority < 90) {
            rule.priority = Math.min(rule.priority + 5, 90);
            rule.updatedAt = Date.now();
            logger.info(`Rule ${rule.name} priority decreased due to low success rate: ${ruleStats.successRate}`);
          }
          // 如果规则成功率高于 80%，提高其优先级
          else if (ruleStats.successRate > 0.8 && rule.priority > 2) {
            rule.priority = Math.max(rule.priority - 2, 2);
            rule.updatedAt = Date.now();
            logger.info(`Rule ${rule.name} priority increased due to high success rate: ${ruleStats.successRate}`);
          }
        }
      }

      await this.saveRules();
      logger.info('Rule weights adjusted based on learning data');
    } catch (error) {
      logger.warn('Failed to adjust rule weights from learning:', error);
    }
  }

  /**
   * 跟踪每个规则的成功率
   * Requirements: 13.2 - 跟踪每个规则的成功率
   */
  async getRuleSuccessRate(ruleId: string): Promise<{
    ruleId: string;
    totalExecutions: number;
    successCount: number;
    successRate: number;
  }> {
    const decisions = await this.getDecisionHistory(undefined, 500);
    const ruleDecisions = decisions.filter(d => d.matchedRule === ruleId);

    const executedDecisions = ruleDecisions.filter(d => d.executed && d.executionResult);
    const successfulDecisions = executedDecisions.filter(d => d.executionResult?.success);

    return {
      ruleId,
      totalExecutions: executedDecisions.length,
      successCount: successfulDecisions.length,
      successRate: executedDecisions.length > 0
        ? successfulDecisions.length / executedDecisions.length
        : 0,
    };
  }

  /**
   * 获取所有规则的学习调整信息
   * Requirements: 13.3 - 暴露学习调整查询 API
   */
  async getLearningAdjustments(): Promise<Array<{
    ruleId: string;
    ruleName: string;
    currentPriority: number;
    successRate: number;
    totalExecutions: number;
    adjustmentSuggestion: string;
  }>> {
    await this.initialize();

    const adjustments = [];
    for (const rule of this.rules) {
      const stats = await this.getRuleSuccessRate(rule.id);

      let suggestion = 'No adjustment needed';
      if (stats.totalExecutions >= 5) {
        if (stats.successRate < 0.3) {
          suggestion = 'Consider disabling or reviewing this rule';
        } else if (stats.successRate < 0.5) {
          suggestion = 'Rule may need condition refinement';
        } else if (stats.successRate > 0.9) {
          suggestion = 'Rule performing well, consider increasing priority';
        }
      } else {
        suggestion = 'Insufficient data for adjustment';
      }

      adjustments.push({
        ruleId: rule.id,
        ruleName: rule.name,
        currentPriority: rule.priority,
        successRate: stats.successRate,
        totalExecutions: stats.totalExecutions,
        adjustmentSuggestion: suggestion,
      });
    }

    return adjustments;
  }

  /**
   * 手动覆盖学习调整
   * Requirements: 13.4 - 支持手动覆盖学习调整
   */
  async overrideLearningAdjustment(
    ruleId: string,
    newPriority: number,
    reason: string
  ): Promise<void> {
    await this.initialize();

    const rule = this.rules.find(r => r.id === ruleId);
    if (!rule) {
      throw new Error(`Rule not found: ${ruleId}`);
    }

    const oldPriority = rule.priority;
    rule.priority = newPriority;
    rule.updatedAt = Date.now();

    await this.saveRules();

    // 记录审计日志
    await auditLogger.log({
      action: 'config_change',
      actor: 'user',
      details: {
        trigger: 'learning_adjustment_override',
        metadata: {
          ruleId,
          ruleName: rule.name,
          oldPriority,
          newPriority,
          reason,
        },
      },
    });

    logger.info(`Learning adjustment overridden for rule ${rule.name}: ${oldPriority} -> ${newPriority}`);
  }
}

// Export singleton instance
export const decisionEngine = new DecisionEngine();
