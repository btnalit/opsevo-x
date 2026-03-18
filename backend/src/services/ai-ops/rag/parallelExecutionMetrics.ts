/**
 * ParallelExecutionMetrics - 并行执行指标
 * 
 * 记录和分析并行执行的性能指标
 * 
 * Requirements: 7.1, 7.2, 7.3, 7.4, 7.5, 7.6
 * - 7.1: 记录每次执行的指标
 * - 7.2: 计算理论 vs 实际加速比
 * - 7.3: 追踪模式选择准确性
 * - 7.4: 暴露指标到现有 API
 * - 7.5: 支持 verbose 模式详细日志
 * - 7.6: 报告平均响应时间改进
 */

import { logger } from '../../../utils/logger';
import {
  ExecutionMode,
  ParallelExecutionMetrics as Metrics,
  ModeSelectionAccuracy,
} from '../../../types/parallel-execution';

/**
 * 指标配置
 */
export interface MetricsConfig {
  /** 是否启用指标收集 */
  enabled: boolean;
  /** 最大历史记录数 */
  maxHistorySize: number;
  /** 是否启用详细日志 */
  verbose: boolean;
}

/**
 * 默认配置
 */
const DEFAULT_CONFIG: MetricsConfig = {
  enabled: true,
  maxHistorySize: 1000,
  verbose: false,
};

/**
 * 聚合指标
 */
export interface AggregatedMetrics {
  /** 总执行次数 */
  totalExecutions: number;
  /** 按模式的执行次数 */
  executionsByMode: Record<ExecutionMode, number>;
  /** 平均加速比 */
  avgSpeedupRatio: number;
  /** 平均并行度 */
  avgParallelism: number;
  /** 平均失败率 */
  avgFailureRate: number;
  /** 平均工具调用数 */
  avgToolCallCount: number;
  /** 模式选择准确率 */
  modeSelectionAccuracy: number;
  /** 平均响应时间改进（百分比） */
  avgResponseTimeImprovement: number;
  /** 时间范围 */
  timeRange: {
    from: number;
    to: number;
  };
}

/**
 * ParallelExecutionMetrics 类
 * 管理并行执行的性能指标
 */
export class ParallelExecutionMetricsCollector {
  private config: MetricsConfig;
  
  /** 执行指标历史 */
  private metricsHistory: Metrics[] = [];
  
  /** 模式选择准确性历史 */
  private accuracyHistory: ModeSelectionAccuracy[] = [];

  constructor(config?: Partial<MetricsConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    logger.debug('ParallelExecutionMetrics initialized', { config: this.config });
  }

  /**
   * 记录执行指标
   * Requirements: 7.1, 7.2, 7.6
   * 
   * @param metrics 执行指标
   */
  recordExecution(metrics: Omit<Metrics, 'timestamp'>): void {
    if (!this.config.enabled) return;

    const fullMetrics: Metrics = {
      ...metrics,
      timestamp: Date.now(),
    };

    this.metricsHistory.push(fullMetrics);

    // 限制历史大小
    if (this.metricsHistory.length > this.config.maxHistorySize) {
      this.metricsHistory.shift();
    }

    if (this.config.verbose) {
      logger.info('Parallel execution metrics recorded', {
        executionId: metrics.executionId,
        mode: metrics.mode,
        toolCallCount: metrics.toolCallCount,
        speedupRatio: metrics.speedupRatio.toFixed(2),
        avgParallelism: metrics.avgParallelism.toFixed(2),
      });
    }
  }

  /**
   * 记录模式选择准确性
   * Requirements: 7.3
   * 
   * @param predicted 预测的工具调用数
   * @param actual 实际工具调用数
   * @param predictedMode 预测的模式
   */
  recordModeSelectionAccuracy(
    predicted: number,
    actual: number,
    predictedMode: ExecutionMode
  ): void {
    if (!this.config.enabled) return;

    // 如果预测和实际相差不超过 1，认为是准确的
    const accurate = Math.abs(predicted - actual) <= 1;

    const accuracy: ModeSelectionAccuracy = {
      predictedToolCalls: predicted,
      actualToolCalls: actual,
      predictedMode,
      accurate,
      timestamp: Date.now(),
    };

    this.accuracyHistory.push(accuracy);

    // 限制历史大小
    if (this.accuracyHistory.length > this.config.maxHistorySize) {
      this.accuracyHistory.shift();
    }

    if (this.config.verbose) {
      logger.info('Mode selection accuracy recorded', {
        predicted,
        actual,
        predictedMode,
        accurate,
      });
    }
  }

  /**
   * 获取聚合指标
   * Requirements: 7.4, 7.6
   * 
   * @param from 开始时间（可选）
   * @param to 结束时间（可选）
   * @returns 聚合指标
   */
  getAggregatedMetrics(from?: number, to?: number): AggregatedMetrics {
    const now = Date.now();
    const startTime = from || 0;
    const endTime = to || now;

    // 过滤时间范围内的指标
    const filteredMetrics = this.metricsHistory.filter(
      m => m.timestamp >= startTime && m.timestamp <= endTime
    );

    const filteredAccuracy = this.accuracyHistory.filter(
      a => a.timestamp >= startTime && a.timestamp <= endTime
    );

    if (filteredMetrics.length === 0) {
      return {
        totalExecutions: 0,
        executionsByMode: {
          [ExecutionMode.SEQUENTIAL]: 0,
          [ExecutionMode.PARALLEL]: 0,
          [ExecutionMode.PLANNED]: 0,
        },
        avgSpeedupRatio: 1,
        avgParallelism: 1,
        avgFailureRate: 0,
        avgToolCallCount: 0,
        modeSelectionAccuracy: 0,
        avgResponseTimeImprovement: 0,
        timeRange: { from: startTime, to: endTime },
      };
    }

    // 计算按模式的执行次数
    const executionsByMode: Record<ExecutionMode, number> = {
      [ExecutionMode.SEQUENTIAL]: 0,
      [ExecutionMode.PARALLEL]: 0,
      [ExecutionMode.PLANNED]: 0,
    };

    for (const m of filteredMetrics) {
      executionsByMode[m.mode]++;
    }

    // 计算平均值
    const avgSpeedupRatio = filteredMetrics.reduce((sum, m) => sum + m.speedupRatio, 0) / filteredMetrics.length;
    const avgParallelism = filteredMetrics.reduce((sum, m) => sum + m.avgParallelism, 0) / filteredMetrics.length;
    const avgFailureRate = filteredMetrics.reduce((sum, m) => sum + m.failureRate, 0) / filteredMetrics.length;
    const avgToolCallCount = filteredMetrics.reduce((sum, m) => sum + m.toolCallCount, 0) / filteredMetrics.length;

    // 计算模式选择准确率
    const accurateCount = filteredAccuracy.filter(a => a.accurate).length;
    const modeSelectionAccuracy = filteredAccuracy.length > 0
      ? accurateCount / filteredAccuracy.length
      : 0;

    // 计算平均响应时间改进
    // 改进 = (理论串行时间 - 实际时间) / 理论串行时间 * 100
    const avgResponseTimeImprovement = filteredMetrics.reduce((sum, m) => {
      if (m.theoreticalSequentialDuration > 0) {
        const improvement = (m.theoreticalSequentialDuration - m.totalDuration) / m.theoreticalSequentialDuration * 100;
        return sum + Math.max(0, improvement);
      }
      return sum;
    }, 0) / filteredMetrics.length;

    return {
      totalExecutions: filteredMetrics.length,
      executionsByMode,
      avgSpeedupRatio,
      avgParallelism,
      avgFailureRate,
      avgToolCallCount,
      modeSelectionAccuracy,
      avgResponseTimeImprovement,
      timeRange: { from: startTime, to: endTime },
    };
  }

  /**
   * 获取最近的执行指标
   * 
   * @param count 数量
   * @returns 最近的执行指标
   */
  getRecentMetrics(count: number = 10): Metrics[] {
    return this.metricsHistory.slice(-count);
  }

  /**
   * 获取最近的准确性记录
   * 
   * @param count 数量
   * @returns 最近的准确性记录
   */
  getRecentAccuracy(count: number = 10): ModeSelectionAccuracy[] {
    return this.accuracyHistory.slice(-count);
  }

  /**
   * 计算加速比
   * Requirements: 7.2
   * 
   * @param totalDuration 实际总耗时
   * @param toolDurations 各工具调用耗时
   * @returns 加速比
   */
  calculateSpeedupRatio(totalDuration: number, toolDurations: number[]): number {
    if (totalDuration <= 0 || toolDurations.length === 0) {
      return 1;
    }

    const theoreticalSequential = toolDurations.reduce((sum, d) => sum + d, 0);
    if (theoreticalSequential <= 0) {
      return 1;
    }

    return theoreticalSequential / totalDuration;
  }

  /**
   * 清除历史记录
   */
  clearHistory(): void {
    this.metricsHistory = [];
    this.accuracyHistory = [];
    logger.info('Metrics history cleared');
  }

  /**
   * 更新配置
   */
  updateConfig(config: Partial<MetricsConfig>): void {
    this.config = { ...this.config, ...config };
    logger.debug('ParallelExecutionMetrics config updated', { config: this.config });
  }

  /**
   * 获取配置
   */
  getConfig(): MetricsConfig {
    return { ...this.config };
  }

  /**
   * 导出指标（用于 API）
   * Requirements: 7.4
   */
  exportMetrics(): {
    aggregated: AggregatedMetrics;
    recent: Metrics[];
    accuracy: ModeSelectionAccuracy[];
  } {
    return {
      aggregated: this.getAggregatedMetrics(),
      recent: this.getRecentMetrics(20),
      accuracy: this.getRecentAccuracy(20),
    };
  }
}

// 导出单例实例
export const parallelExecutionMetrics = new ParallelExecutionMetricsCollector();
