/**
 * UsageTracker - 使用追踪器
 * 
 * 记录知识的使用情况和效果
 * 
 * Requirements: 11.1, 11.2, 11.3, 11.4, 11.5, 12.1, 12.2, 12.3, 12.4, 12.5
 * - 11.1: 知识被引用时增加使用计数
 * - 11.2: 记录使用时间戳
 * - 11.3: 记录使用上下文
 * - 11.4: 用户提供反馈时更新反馈评分
 * - 11.5: 知识长期未被使用时降低推荐权重
 * - 12.1: 记录是否成功解决告警
 * - 12.2: 增加成功解决计数
 * - 12.3: 计算成功率
 * - 12.4: 使用公式：成功次数/总应用次数
 * - 12.5: 成功率低于 0.3 时标记需要审核
 */

import { logger } from '../../../utils/logger';
import { IntentType } from './types/intelligentRetrieval';
import { FeedbackType } from './types/credibility';

// ==================== 类型定义 ====================

/**
 * 使用上下文
 * Requirements: 11.3
 */
export interface UsageContext {
  /** 会话 ID（可选） */
  sessionId?: string;
  /** 用户意图类型（可选） */
  intentType?: IntentType;
  /** 原始查询 */
  query: string;
  /** 使用时间戳 */
  timestamp: number;
  /** 引用 ID（可选） */
  referenceId?: string;
}

/**
 * 解决结果
 * Requirements: 12.1
 */
export interface ResolutionResult {
  /** 是否成功解决 */
  resolved: boolean;
  /** 关联的告警 ID */
  alertId?: string;
  /** 解决耗时（毫秒） */
  resolutionTime?: number;
}

/**
 * 使用统计
 * Requirements: 11.1, 11.2
 */
export interface UsageStats {
  /** 总使用次数 */
  totalUsage: number;
  /** 最后使用时间 */
  lastUsedAt: number;
  /** 使用上下文分布 */
  contextDistribution: Record<IntentType, number>;
}

/**
 * 效果统计
 * Requirements: 12.3, 12.4, 12.5
 */
export interface EffectivenessStats {
  /** 总应用次数 */
  totalApplications: number;
  /** 成功解决次数 */
  resolvedCount: number;
  /** 成功率 */
  successRate: number;
  /** 平均解决时间 */
  avgResolutionTime: number;
  /** 需要审核标记 */
  needsReview: boolean;
}

/**
 * 知识使用记录
 */
interface UsageRecord {
  referenceId: string;
  usageCount: number;
  lastUsedAt: number;
  contexts: UsageContext[];
  resolutions: ResolutionResult[];
  feedbackScores: number[];
}

/**
 * 使用追踪器配置
 */
export interface UsageTrackerConfig {
  /** 成功率审核阈值，默认 0.3 */
  reviewThreshold: number;
  /** 最大上下文记录数，默认 100 */
  maxContextRecords: number;
  /** 最大解决记录数，默认 100 */
  maxResolutionRecords: number;
  /** 最大反馈记录数，默认 100 */
  maxFeedbackRecords: number;
  /** 未使用天数阈值（用于降权），默认 30 */
  unusedDaysThreshold: number;
}

const DEFAULT_CONFIG: UsageTrackerConfig = {
  reviewThreshold: 0.3,
  maxContextRecords: 100,
  maxResolutionRecords: 100,
  maxFeedbackRecords: 100,
  unusedDaysThreshold: 30,
};

/**
 * 使用追踪器类
 */
export class UsageTracker {
  private config: UsageTrackerConfig;
  private records: Map<string, UsageRecord> = new Map();

  constructor(config?: Partial<UsageTrackerConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    logger.debug('UsageTracker created', { config: this.config });
  }

  /**
   * 记录知识使用
   * Requirements: 11.1, 11.2, 11.3
   * 
   * @param referenceId 知识引用 ID
   * @param context 使用上下文
   */
  async recordUsage(referenceId: string, context: UsageContext): Promise<void> {
    let record = this.records.get(referenceId);

    if (!record) {
      record = {
        referenceId,
        usageCount: 0,
        lastUsedAt: 0,
        contexts: [],
        resolutions: [],
        feedbackScores: [],
      };
      this.records.set(referenceId, record);
    }

    // 增加使用计数
    record.usageCount += 1;

    // 更新最后使用时间
    record.lastUsedAt = context.timestamp;

    // 记录上下文
    record.contexts.push(context);

    // 限制上下文记录数量
    if (record.contexts.length > this.config.maxContextRecords) {
      record.contexts = record.contexts.slice(-this.config.maxContextRecords);
    }

    logger.debug('Usage recorded', {
      referenceId,
      usageCount: record.usageCount,
      intentType: context.intentType,
    });
  }

  /**
   * 记录解决结果
   * Requirements: 12.1, 12.2
   * 
   * @param referenceId 知识引用 ID
   * @param result 解决结果
   */
  async recordResolutionResult(referenceId: string, result: ResolutionResult): Promise<void> {
    let record = this.records.get(referenceId);

    if (!record) {
      record = {
        referenceId,
        usageCount: 0,
        lastUsedAt: Date.now(),
        contexts: [],
        resolutions: [],
        feedbackScores: [],
      };
      this.records.set(referenceId, record);
    }

    record.resolutions.push(result);

    // 限制解决记录数量，防止内存泄漏
    if (record.resolutions.length > this.config.maxResolutionRecords) {
      record.resolutions = record.resolutions.slice(-this.config.maxResolutionRecords);
    }

    logger.debug('Resolution result recorded', {
      referenceId,
      resolved: result.resolved,
      alertId: result.alertId,
    });
  }

  /**
   * 记录反馈
   * Requirements: 11.4
   * 
   * @param referenceId 知识引用 ID
   * @param feedback 反馈类型
   */
  async recordFeedback(referenceId: string, feedback: FeedbackType): Promise<void> {
    let record = this.records.get(referenceId);

    if (!record) {
      record = {
        referenceId,
        usageCount: 0,
        lastUsedAt: Date.now(),
        contexts: [],
        resolutions: [],
        feedbackScores: [],
      };
      this.records.set(referenceId, record);
    }

    // 将反馈类型转换为分数
    const scoreMap: Record<FeedbackType, number> = {
      positive: 5,
      neutral: 3,
      negative: 1,
    };

    record.feedbackScores.push(scoreMap[feedback]);

    // 限制反馈记录数量，防止内存泄漏
    if (record.feedbackScores.length > this.config.maxFeedbackRecords) {
      record.feedbackScores = record.feedbackScores.slice(-this.config.maxFeedbackRecords);
    }

    logger.debug('Feedback recorded', {
      referenceId,
      feedback,
    });
  }

  /**
   * 获取使用统计
   * Requirements: 11.1, 11.2
   * 
   * @param referenceId 知识引用 ID
   * @returns 使用统计
   */
  async getUsageStats(referenceId: string): Promise<UsageStats> {
    const record = this.records.get(referenceId);

    if (!record) {
      return {
        totalUsage: 0,
        lastUsedAt: 0,
        contextDistribution: {
          troubleshooting: 0,
          configuration: 0,
          monitoring: 0,
          historical_analysis: 0,
          general: 0,
        },
      };
    }

    // 计算上下文分布
    const contextDistribution: Record<IntentType, number> = {
      troubleshooting: 0,
      configuration: 0,
      monitoring: 0,
      historical_analysis: 0,
      general: 0,
    };

    for (const ctx of record.contexts) {
      if (ctx.intentType) {
        contextDistribution[ctx.intentType] = (contextDistribution[ctx.intentType] || 0) + 1;
      }
    }

    return {
      totalUsage: record.usageCount,
      lastUsedAt: record.lastUsedAt,
      contextDistribution,
    };
  }

  /**
   * 获取效果统计
   * Requirements: 12.3, 12.4, 12.5
   * 
   * @param referenceId 知识引用 ID
   * @returns 效果统计
   */
  async getEffectivenessStats(referenceId: string): Promise<EffectivenessStats> {
    const record = this.records.get(referenceId);

    if (!record || record.resolutions.length === 0) {
      return {
        totalApplications: 0,
        resolvedCount: 0,
        successRate: 0,
        avgResolutionTime: 0,
        needsReview: false,
      };
    }

    const totalApplications = record.resolutions.length;
    const resolvedCount = record.resolutions.filter(r => r.resolved).length;
    
    // 计算成功率
    const successRate = totalApplications > 0 ? resolvedCount / totalApplications : 0;

    // 计算平均解决时间
    const resolutionTimes = record.resolutions
      .filter(r => r.resolved && r.resolutionTime !== undefined)
      .map(r => r.resolutionTime!);
    
    const avgResolutionTime = resolutionTimes.length > 0
      ? resolutionTimes.reduce((a, b) => a + b, 0) / resolutionTimes.length
      : 0;

    // 判断是否需要审核
    const needsReview = totalApplications > 0 && successRate < this.config.reviewThreshold;

    return {
      totalApplications,
      resolvedCount,
      successRate,
      avgResolutionTime,
      needsReview,
    };
  }

  /**
   * 获取平均反馈分数
   * 
   * @param referenceId 知识引用 ID
   * @returns 平均反馈分数 (0-5)
   */
  async getAverageFeedbackScore(referenceId: string): Promise<number> {
    const record = this.records.get(referenceId);

    if (!record || record.feedbackScores.length === 0) {
      return 0;
    }

    const sum = record.feedbackScores.reduce((a, b) => a + b, 0);
    return sum / record.feedbackScores.length;
  }

  /**
   * 检查知识是否长期未使用
   * Requirements: 11.5
   * 
   * @param referenceId 知识引用 ID
   * @returns 是否长期未使用
   */
  isUnused(referenceId: string): boolean {
    const record = this.records.get(referenceId);

    if (!record || record.lastUsedAt === 0) {
      return true;
    }

    const daysSinceLastUse = (Date.now() - record.lastUsedAt) / (24 * 60 * 60 * 1000);
    return daysSinceLastUse > this.config.unusedDaysThreshold;
  }

  /**
   * 获取所有需要审核的知识 ID
   * Requirements: 12.5
   */
  async getKnowledgeNeedingReview(): Promise<string[]> {
    const needsReview: string[] = [];

    for (const [referenceId, record] of this.records) {
      if (record.resolutions.length > 0) {
        const stats = await this.getEffectivenessStats(referenceId);
        if (stats.needsReview) {
          needsReview.push(referenceId);
        }
      }
    }

    return needsReview;
  }

  /**
   * 批量记录使用
   * 
   * @param referenceIds 知识引用 ID 列表
   * @param context 使用上下文
   */
  async recordBatchUsage(referenceIds: string[], context: UsageContext): Promise<void> {
    for (const referenceId of referenceIds) {
      await this.recordUsage(referenceId, context);
    }
  }

  /**
   * 清除记录（用于测试）
   */
  clearRecords(): void {
    this.records.clear();
  }

  /**
   * 获取所有记录数量
   */
  getRecordCount(): number {
    return this.records.size;
  }
}

// 导出单例实例
export const usageTracker = new UsageTracker();
