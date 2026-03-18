/**
 * EvolutionErrorHandler - 进化错误处理器
 * 
 * 实现错误分类、重试和降级策略
 * 
 * Requirements: 10.6.1, 10.6.2, 10.6.3
 * - 10.6.1: 错误分类逻辑
 * - 10.6.2: 重试策略
 * - 10.6.3: 降级策略
 */

import { logger } from '../../utils/logger';

/**
 * 错误类型分类
 */
export enum EvolutionErrorType {
  /** 临时性错误 - 可重试 */
  TRANSIENT = 'transient',
  /** 配置错误 - 需要修复配置 */
  CONFIGURATION = 'configuration',
  /** 资源错误 - 资源不可用 */
  RESOURCE = 'resource',
  /** 超时错误 */
  TIMEOUT = 'timeout',
  /** 授权错误 */
  AUTHORIZATION = 'authorization',
  /** 验证错误 */
  VALIDATION = 'validation',
  /** 依赖错误 - 外部服务不可用 */
  DEPENDENCY = 'dependency',
  /** 未知错误 */
  UNKNOWN = 'unknown',
}

/**
 * 错误严重级别
 */
export enum ErrorSeverity {
  LOW = 'low',
  MEDIUM = 'medium',
  HIGH = 'high',
  CRITICAL = 'critical',
}

/**
 * 分类后的错误
 */
export interface ClassifiedError {
  /** 原始错误 */
  originalError: Error;
  /** 错误类型 */
  type: EvolutionErrorType;
  /** 严重级别 */
  severity: ErrorSeverity;
  /** 是否可重试 */
  retryable: boolean;
  /** 建议的重试延迟 (ms) */
  suggestedRetryDelay?: number;
  /** 最大重试次数 */
  maxRetries: number;
  /** 是否应该降级 */
  shouldDegrade: boolean;
  /** 降级的能力名称 */
  degradeCapability?: string;
  /** 错误上下文 */
  context?: Record<string, unknown>;
}

/**
 * 重试配置
 */
export interface RetryConfig {
  /** 最大重试次数 */
  maxRetries: number;
  /** 基础延迟 (ms) */
  baseDelay: number;
  /** 最大延迟 (ms) */
  maxDelay: number;
  /** 退避因子 */
  backoffFactor: number;
  /** 是否添加抖动 */
  jitter: boolean;
}

/**
 * 重试状态
 */
export interface RetryState {
  /** 当前重试次数 */
  attempt: number;
  /** 下次重试延迟 */
  nextDelay: number;
  /** 是否应该继续重试 */
  shouldRetry: boolean;
  /** 总耗时 */
  totalElapsed: number;
}

const DEFAULT_RETRY_CONFIG: RetryConfig = {
  maxRetries: 3,
  baseDelay: 1000,
  maxDelay: 30000,
  backoffFactor: 2,
  jitter: true,
};

/**
 * 错误模式匹配规则
 */
const ERROR_PATTERNS: Array<{
  pattern: RegExp | string;
  type: EvolutionErrorType;
  severity: ErrorSeverity;
  retryable: boolean;
  maxRetries: number;
}> = [
  // 超时错误
  { pattern: /timeout|timed out|ETIMEDOUT/i, type: EvolutionErrorType.TIMEOUT, severity: ErrorSeverity.MEDIUM, retryable: true, maxRetries: 3 },
  // 连接错误
  { pattern: /ECONNREFUSED|ECONNRESET|ENOTFOUND|connection refused/i, type: EvolutionErrorType.DEPENDENCY, severity: ErrorSeverity.HIGH, retryable: true, maxRetries: 3 },
  // 授权错误
  { pattern: /unauthorized|forbidden|401|403|authentication/i, type: EvolutionErrorType.AUTHORIZATION, severity: ErrorSeverity.HIGH, retryable: false, maxRetries: 0 },
  // 验证错误
  { pattern: /validation|invalid|malformed|bad request|400/i, type: EvolutionErrorType.VALIDATION, severity: ErrorSeverity.LOW, retryable: false, maxRetries: 0 },
  // 资源错误
  { pattern: /not found|404|ENOENT|no such file/i, type: EvolutionErrorType.RESOURCE, severity: ErrorSeverity.MEDIUM, retryable: false, maxRetries: 0 },
  // 配置错误
  { pattern: /config|configuration|missing.*required/i, type: EvolutionErrorType.CONFIGURATION, severity: ErrorSeverity.HIGH, retryable: false, maxRetries: 0 },
  // 临时性错误
  { pattern: /temporary|retry|again|busy|overloaded|503|429/i, type: EvolutionErrorType.TRANSIENT, severity: ErrorSeverity.LOW, retryable: true, maxRetries: 5 },
];

/**
 * EvolutionErrorHandler 类
 */
export class EvolutionErrorHandler {
  private retryConfig: RetryConfig;
  private errorStats: Map<EvolutionErrorType, number> = new Map();

  constructor(retryConfig?: Partial<RetryConfig>) {
    this.retryConfig = { ...DEFAULT_RETRY_CONFIG, ...retryConfig };
    logger.debug('EvolutionErrorHandler created', { config: this.retryConfig });
  }

  /**
   * 分类错误
   * Requirements: 10.6.1
   */
  classifyError(error: Error, context?: Record<string, unknown>): ClassifiedError {
    const errorMessage = error.message || '';
    const errorName = error.name || '';
    const fullText = `${errorName} ${errorMessage}`;

    // 匹配错误模式
    for (const rule of ERROR_PATTERNS) {
      const pattern = typeof rule.pattern === 'string' 
        ? new RegExp(rule.pattern, 'i') 
        : rule.pattern;
      
      if (pattern.test(fullText)) {
        const classified: ClassifiedError = {
          originalError: error,
          type: rule.type,
          severity: rule.severity,
          retryable: rule.retryable,
          maxRetries: rule.maxRetries,
          shouldDegrade: rule.severity === ErrorSeverity.CRITICAL || rule.severity === ErrorSeverity.HIGH,
          context,
        };

        if (rule.retryable) {
          classified.suggestedRetryDelay = this.calculateRetryDelay(0);
        }

        this.recordError(rule.type);
        logger.debug('Error classified', { type: rule.type, severity: rule.severity, retryable: rule.retryable });
        return classified;
      }
    }

    // 未匹配到任何模式，返回未知错误
    const unknown: ClassifiedError = {
      originalError: error,
      type: EvolutionErrorType.UNKNOWN,
      severity: ErrorSeverity.MEDIUM,
      retryable: true,
      maxRetries: 1,
      shouldDegrade: false,
      suggestedRetryDelay: this.retryConfig.baseDelay,
      context,
    };

    this.recordError(EvolutionErrorType.UNKNOWN);
    return unknown;
  }

  /**
   * 计算重试延迟（指数退避）
   * Requirements: 10.6.2
   */
  calculateRetryDelay(attempt: number): number {
    let delay = this.retryConfig.baseDelay * Math.pow(this.retryConfig.backoffFactor, attempt);
    delay = Math.min(delay, this.retryConfig.maxDelay);

    if (this.retryConfig.jitter) {
      // 添加 ±25% 的抖动
      const jitterRange = delay * 0.25;
      delay = delay + (Math.random() * 2 - 1) * jitterRange;
    }

    return Math.round(delay);
  }

  /**
   * 获取重试状态
   * Requirements: 10.6.2
   */
  getRetryState(classifiedError: ClassifiedError, currentAttempt: number, totalElapsed: number = 0): RetryState {
    const shouldRetry = classifiedError.retryable && currentAttempt < classifiedError.maxRetries;
    const nextDelay = shouldRetry ? this.calculateRetryDelay(currentAttempt) : 0;

    return {
      attempt: currentAttempt,
      nextDelay,
      shouldRetry,
      totalElapsed,
    };
  }

  /**
   * 执行带重试的操作
   * Requirements: 10.6.2
   */
  async executeWithRetry<T>(
    operation: () => Promise<T>,
    operationName: string,
    customConfig?: Partial<RetryConfig>
  ): Promise<T> {
    const config = { ...this.retryConfig, ...customConfig };
    let lastError: Error | null = null;
    let totalElapsed = 0;
    const startTime = Date.now();

    for (let attempt = 0; attempt <= config.maxRetries; attempt++) {
      try {
        return await operation();
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        const classified = this.classifyError(lastError, { operationName, attempt });
        totalElapsed = Date.now() - startTime;

        const retryState = this.getRetryState(classified, attempt + 1, totalElapsed);

        if (!retryState.shouldRetry) {
          logger.warn('Operation failed, no more retries', {
            operationName,
            attempt: attempt + 1,
            errorType: classified.type,
            totalElapsed,
          });
          break;
        }

        logger.info('Operation failed, retrying', {
          operationName,
          attempt: attempt + 1,
          maxRetries: config.maxRetries,
          nextDelay: retryState.nextDelay,
          errorType: classified.type,
        });

        await this.sleep(retryState.nextDelay);
      }
    }

    throw lastError;
  }

  /**
   * 判断是否应该降级
   * Requirements: 10.6.3
   */
  shouldDegrade(classifiedError: ClassifiedError, consecutiveFailures: number): boolean {
    // 严重错误立即降级
    if (classifiedError.severity === ErrorSeverity.CRITICAL) {
      return true;
    }

    // 高严重性错误连续失败 3 次降级
    if (classifiedError.severity === ErrorSeverity.HIGH && consecutiveFailures >= 3) {
      return true;
    }

    // 中等严重性错误连续失败 5 次降级
    if (classifiedError.severity === ErrorSeverity.MEDIUM && consecutiveFailures >= 5) {
      return true;
    }

    // 依赖错误连续失败 2 次降级
    if (classifiedError.type === EvolutionErrorType.DEPENDENCY && consecutiveFailures >= 2) {
      return true;
    }

    return classifiedError.shouldDegrade;
  }

  /**
   * 获取错误统计
   */
  getErrorStats(): Record<EvolutionErrorType, number> {
    const stats: Record<string, number> = {};
    for (const [type, count] of this.errorStats) {
      stats[type] = count;
    }
    return stats as Record<EvolutionErrorType, number>;
  }

  /**
   * 重置错误统计
   */
  resetErrorStats(): void {
    this.errorStats.clear();
  }

  /**
   * 更新重试配置
   */
  updateConfig(config: Partial<RetryConfig>): void {
    this.retryConfig = { ...this.retryConfig, ...config };
    logger.debug('EvolutionErrorHandler config updated', { config: this.retryConfig });
  }

  // ==================== 私有方法 ====================

  private recordError(type: EvolutionErrorType): void {
    const current = this.errorStats.get(type) || 0;
    this.errorStats.set(type, current + 1);
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

// 导出单例实例
export const evolutionErrorHandler = new EvolutionErrorHandler();
