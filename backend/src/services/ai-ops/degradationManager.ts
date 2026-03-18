/**
 * DegradationManager - 降级管理器
 * 
 * 管理各能力的降级状态和恢复
 * 
 * Requirements: 10.6.4, 10.6.5
 * - 10.6.4: 各能力的降级开关
 * - 10.6.5: 降级状态管理和恢复
 */

import { logger } from '../../utils/logger';
import { EventEmitter } from 'events';
import type { DataStore } from '../dataStore';

/**
 * 能力名称
 */
export type CapabilityName =
  | 'reflection'        // 反思与自我修正
  | 'experience'        // 长短期记忆
  | 'planRevision'      // 计划动态修订
  | 'toolFeedback'      // 工具反馈闭环
  | 'proactiveOps'      // 主动式运维
  | 'intentDriven'      // Intent-Driven 自动化
  | 'selfHealing'       // Self-Healing 自愈
  | 'continuousLearning' // 持续学习
  | 'tracing'           // 分布式追踪
  | 'vectorOperations'; // Python Core 向量操作 (PC.3)

/**
 * 降级原因
 */
export enum DegradationReason {
  /** 手动降级 */
  MANUAL = 'manual',
  /** 错误触发 */
  ERROR = 'error',
  /** 资源不足 */
  RESOURCE = 'resource',
  /** 依赖不可用 */
  DEPENDENCY = 'dependency',
  /** 超时 */
  TIMEOUT = 'timeout',
  /** 熔断 */
  CIRCUIT_BREAKER = 'circuit_breaker',
}

/**
 * 降级状态
 */
export interface DegradationState {
  /** 能力名称 */
  capability: CapabilityName;
  /** 是否降级 */
  degraded: boolean;
  /** 降级原因 */
  reason?: DegradationReason;
  /** 降级时间 */
  degradedAt?: number;
  /** 预计恢复时间 */
  estimatedRecoveryAt?: number;
  /** 连续失败次数 */
  consecutiveFailures: number;
  /** 最后一次错误 */
  lastError?: string;
  /** 降级次数 */
  degradationCount: number;
}

/**
 * 降级配置
 */
export interface DegradationConfig {
  /** 自动恢复延迟 (ms) */
  autoRecoveryDelay: number;
  /** 最大连续失败次数触发降级 */
  maxConsecutiveFailures: number;
  /** 恢复后的观察期 (ms) */
  recoveryObservationPeriod: number;
  /** 是否启用自动恢复 */
  autoRecoveryEnabled: boolean;
}

const DEFAULT_CONFIG: DegradationConfig = {
  autoRecoveryDelay: 60000, // 1 分钟
  maxConsecutiveFailures: 5,
  recoveryObservationPeriod: 30000, // 30 秒
  autoRecoveryEnabled: true,
};

const ALL_CAPABILITIES: CapabilityName[] = [
  'reflection',
  'experience',
  'planRevision',
  'toolFeedback',
  'proactiveOps',
  'intentDriven',
  'selfHealing',
  'continuousLearning',
  'tracing',
  'vectorOperations',
];

/**
 * DegradationManager 类
 */
export class DegradationManager extends EventEmitter {
  private config: DegradationConfig;
  private states: Map<CapabilityName, DegradationState> = new Map();
  private recoveryTimers: Map<CapabilityName, NodeJS.Timeout> = new Map();
  private initialized: boolean = false;
  private pgDataStore: DataStore | null = null;

  constructor(config?: Partial<DegradationConfig>) {
    super();
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.initializeStates();
    logger.debug('DegradationManager created', { config: this.config });
  }

  /**
   * 注入 PgDataStore 实例，启用 PostgreSQL 持久化
   */
  setPgDataStore(dataStore: DataStore): void {
    this.pgDataStore = dataStore;
    logger.info('DegradationManager: PgDataStore injected, persistence enabled');
  }

  /**
   * 从 PostgreSQL 恢复降级状态（启动时调用）
   * Requirements: I1.2, I1.3
   */
  async restoreFromPostgres(): Promise<void> {
    if (!this.pgDataStore) {
      logger.debug('DegradationManager: No PgDataStore, skipping restore');
      return;
    }

    try {
      const rows = await this.pgDataStore.query<{
        capability: string;
        is_degraded: boolean;
        failure_count: number;
        degraded_at: string | null;
        recovery_at: string | null;
        reason: string | null;
      }>('SELECT capability, is_degraded, failure_count, degraded_at, recovery_at, reason FROM degradation_states');

      for (const row of rows) {
        const capability = row.capability as CapabilityName;
        const state = this.states.get(capability);
        if (!state) continue;

        state.degraded = row.is_degraded;
        state.consecutiveFailures = row.failure_count;
        state.reason = row.reason as DegradationReason | undefined;
        state.degradedAt = row.degraded_at ? new Date(row.degraded_at).getTime() : undefined;

        if (state.degraded && this.config.autoRecoveryEnabled) {
          this.scheduleRecovery(capability);
        }
      }

      logger.info('DegradationManager: Restored states from PostgreSQL', {
        degraded: this.getDegradedCapabilities(),
      });
    } catch (error) {
      logger.warn('DegradationManager: Failed to restore from PostgreSQL', { error });
    }
  }

  /**
   * 初始化所有能力状态
   */
  private initializeStates(): void {
    for (const capability of ALL_CAPABILITIES) {
      this.states.set(capability, {
        capability,
        degraded: false,
        consecutiveFailures: 0,
        degradationCount: 0,
      });
    }
    this.initialized = true;
  }

  /**
   * 降级指定能力
   * Requirements: 10.6.4
   */
  degrade(
    capability: CapabilityName,
    reason: DegradationReason,
    errorMessage?: string
  ): void {
    const state = this.states.get(capability);
    if (!state) {
      logger.warn('Unknown capability', { capability });
      return;
    }

    if (state.degraded) {
      logger.debug('Capability already degraded', { capability });
      return;
    }

    const now = Date.now();
    state.degraded = true;
    state.reason = reason;
    state.degradedAt = now;
    state.estimatedRecoveryAt = now + this.config.autoRecoveryDelay;
    state.lastError = errorMessage;
    state.degradationCount++;

    logger.warn('Capability degraded', {
      capability,
      reason,
      degradationCount: state.degradationCount,
      errorMessage,
    });

    this.emit('degraded', { capability, reason, state: { ...state } });

    // 持久化到 PostgreSQL
    this.persistState(capability, state);

    // 设置自动恢复定时器
    if (this.config.autoRecoveryEnabled) {
      this.scheduleRecovery(capability);
    }
  }

  /**
   * 恢复指定能力
   * Requirements: 10.6.5
   */
  recover(capability: CapabilityName): boolean {
    const state = this.states.get(capability);
    if (!state) {
      logger.warn('Unknown capability', { capability });
      return false;
    }

    if (!state.degraded) {
      logger.debug('Capability not degraded', { capability });
      return true;
    }

    // 清除恢复定时器
    this.clearRecoveryTimer(capability);

    state.degraded = false;
    state.reason = undefined;
    state.degradedAt = undefined;
    state.estimatedRecoveryAt = undefined;
    state.consecutiveFailures = 0;

    logger.info('Capability recovered', { capability });

    this.emit('recovered', { capability, state: { ...state } });

    // 持久化到 PostgreSQL
    this.persistState(capability, state);

    return true;
  }

  /**
   * 记录失败
   */
  recordFailure(capability: CapabilityName, errorMessage?: string): void {
    const state = this.states.get(capability);
    if (!state) return;

    state.consecutiveFailures++;
    state.lastError = errorMessage;

    logger.debug('Failure recorded', {
      capability,
      consecutiveFailures: state.consecutiveFailures,
    });

    // 检查是否应该降级（degrade 内部会持久化）
    if (state.consecutiveFailures >= this.config.maxConsecutiveFailures && !state.degraded) {
      this.degrade(capability, DegradationReason.ERROR, errorMessage);
    } else {
      // 仅更新 failure_count
      this.persistState(capability, state);
    }
  }

  /**
   * 记录成功
   */
  recordSuccess(capability: CapabilityName): void {
    const state = this.states.get(capability);
    if (!state) return;

    state.consecutiveFailures = 0;
    state.lastError = undefined;

    // 持久化重置后的计数
    this.persistState(capability, state);
  }

  /**
   * 检查能力是否可用
   */
  isAvailable(capability: CapabilityName): boolean {
    const state = this.states.get(capability);
    return state ? !state.degraded : false;
  }

  /**
   * 获取能力状态
   */
  getState(capability: CapabilityName): DegradationState | undefined {
    const state = this.states.get(capability);
    return state ? { ...state } : undefined;
  }

  /**
   * 获取所有状态
   */
  getAllStates(): DegradationState[] {
    return Array.from(this.states.values()).map(s => ({ ...s }));
  }

  /**
   * 获取降级的能力列表
   */
  getDegradedCapabilities(): CapabilityName[] {
    return Array.from(this.states.entries())
      .filter(([_, state]) => state.degraded)
      .map(([capability]) => capability);
  }

  /**
   * 获取可用的能力列表
   */
  getAvailableCapabilities(): CapabilityName[] {
    return Array.from(this.states.entries())
      .filter(([_, state]) => !state.degraded)
      .map(([capability]) => capability);
  }

  /**
   * 批量降级
   */
  degradeAll(reason: DegradationReason): void {
    for (const capability of ALL_CAPABILITIES) {
      this.degrade(capability, reason);
    }
  }

  /**
   * 批量恢复
   */
  recoverAll(): void {
    for (const capability of ALL_CAPABILITIES) {
      this.recover(capability);
    }
  }

  /**
   * 获取状态摘要
   */
  getSummary(): {
    total: number;
    available: number;
    degraded: number;
    degradedList: CapabilityName[];
  } {
    const degradedList = this.getDegradedCapabilities();
    return {
      total: ALL_CAPABILITIES.length,
      available: ALL_CAPABILITIES.length - degradedList.length,
      degraded: degradedList.length,
      degradedList,
    };
  }

  /**
   * 更新配置
   */
  updateConfig(config: Partial<DegradationConfig>): void {
    this.config = { ...this.config, ...config };
    logger.debug('DegradationManager config updated', { config: this.config });
  }

  /**
   * 关闭管理器
   */
  shutdown(): void {
    // 清除所有恢复定时器
    for (const [capability] of this.recoveryTimers) {
      this.clearRecoveryTimer(capability);
    }
    this.removeAllListeners();
    logger.info('DegradationManager shutdown');
  }

  // ==================== 私有方法 ====================

  /**
   * 持久化降级状态到 PostgreSQL（fire-and-forget，不阻塞主流程）
   */
  private persistState(capability: CapabilityName, state: DegradationState): void {
    if (!this.pgDataStore) return;

    this.pgDataStore.execute(
      `INSERT INTO degradation_states (capability, is_degraded, failure_count, degraded_at, recovery_at, reason, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, NOW())
       ON CONFLICT (capability) DO UPDATE SET
         is_degraded = EXCLUDED.is_degraded,
         failure_count = EXCLUDED.failure_count,
         degraded_at = EXCLUDED.degraded_at,
         recovery_at = EXCLUDED.recovery_at,
         reason = EXCLUDED.reason,
         updated_at = NOW()`,
      [
        capability,
        state.degraded,
        state.consecutiveFailures,
        state.degradedAt ? new Date(state.degradedAt).toISOString() : null,
        state.degraded ? null : new Date().toISOString(),
        state.reason ?? null,
      ]
    ).catch(err => {
      logger.warn('DegradationManager: Failed to persist state', { capability, error: err });
    });
  }

  private scheduleRecovery(capability: CapabilityName): void {
    // 清除现有定时器
    this.clearRecoveryTimer(capability);

    const timer = setTimeout(() => {
      this.attemptRecovery(capability);
    }, this.config.autoRecoveryDelay);

    this.recoveryTimers.set(capability, timer);

    logger.debug('Recovery scheduled', {
      capability,
      delay: this.config.autoRecoveryDelay,
    });
  }

  private clearRecoveryTimer(capability: CapabilityName): void {
    const timer = this.recoveryTimers.get(capability);
    if (timer) {
      clearTimeout(timer);
      this.recoveryTimers.delete(capability);
    }
  }

  private attemptRecovery(capability: CapabilityName): void {
    const state = this.states.get(capability);
    if (!state || !state.degraded) return;

    logger.info('Attempting automatic recovery', { capability });

    // 尝试恢复
    this.recover(capability);

    this.emit('recoveryAttempted', { capability, success: true });
  }
}

// 导出单例实例
export const degradationManager = new DegradationManager();
