/**
 * CredibilityCalculator - 可信度计算器
 * 
 * 计算知识条目的可信度分数，基于多维度指标
 * 
 * Requirements: 4.1, 4.2, 4.3, 4.4, 4.5
 * - 4.1: 计算可信度分数（优化后的权重）
 *        反馈评分×0.3 + 来源权重×0.25 + 内容质量×0.2 + 时效性×0.15 + 使用频率×0.1
 * - 4.2: 根据来源类型赋予权重（manual 类型提高权重）
 * - 4.3: 可信度分数低于 0.4 标记为低可信度
 * - 4.4: 知识被成功应用时增加使用频率计数
 * - 4.5: 用户提供正面反馈时更新反馈评分
 */

import { logger } from '../../../utils/logger';
import { KnowledgeEntry } from './knowledgeBase';
import {
  CredibilityWeights,
  CredibilityConfig,
  CredibilityLevel,
  ScoredKnowledgeEntry,
  CredibilityInput,
  CredibilityDetails,
  FeedbackType,
  DEFAULT_CREDIBILITY_CONFIG,
  SOURCE_WEIGHTS,
  FEEDBACK_SCORES,
  CONTENT_QUALITY_INDICATORS,
  DEVICE_COMMAND_PATHS,
} from './types/credibility';
import { KnowledgeSource } from './types/intelligentRetrieval';

/**
 * 可信度计算器类
 */
export class CredibilityCalculator {
  private config: CredibilityConfig;

  constructor(config?: Partial<CredibilityConfig>) {
    this.config = { ...DEFAULT_CREDIBILITY_CONFIG, ...config };
    logger.debug('CredibilityCalculator created', { config: this.config });
  }

  /**
   * 计算单个知识条目的可信度分数
   * Requirements: 4.1
   * 
   * @param entry 知识条目
   * @returns 可信度分数 (0-1)
   */
  calculate(entry: KnowledgeEntry): number {
    const input = this.extractCredibilityInput(entry);
    return this.calculateFromInput(input);
  }

  /**
   * 从输入计算可信度分数
   * Requirements: 4.1
   * 
   * 优化后的公式:
   * 反馈评分×0.3 + 来源权重×0.25 + 内容质量×0.2 + 时效性×0.15 + 使用频率×0.1
   */
  calculateFromInput(input: CredibilityInput): number {
    const { weights } = this.config;

    // 归一化各分量
    const normalizedFeedback = this.normalizeFeedbackScore(input.feedbackScore, input.feedbackCount);
    const normalizedUsage = this.normalizeUsageCount(input.usageCount);
    const recencyScore = this.calculateRecencyScore(input.timestamp);
    const sourceWeight = this.getSourceWeight(input.sourceType);
    const contentQualityScore = this.calculateContentQualityScore(input.content || '');

    // 计算加权和
    const score = 
      normalizedFeedback * weights.feedbackWeight +
      normalizedUsage * weights.usageWeight +
      recencyScore * weights.recencyWeight +
      sourceWeight * weights.sourceWeight +
      contentQualityScore * weights.contentQualityWeight;

    // 确保分数在 [0, 1] 范围内
    return Math.max(0, Math.min(1, score));
  }

  /**
   * 计算可信度详情
   * 
   * @param entry 知识条目
   * @returns 可信度详情
   */
  calculateDetails(entry: KnowledgeEntry): CredibilityDetails {
    const input = this.extractCredibilityInput(entry);
    
    const normalizedFeedback = this.normalizeFeedbackScore(input.feedbackScore, input.feedbackCount);
    const normalizedUsage = this.normalizeUsageCount(input.usageCount);
    const recencyScore = this.calculateRecencyScore(input.timestamp);
    const sourceWeight = this.getSourceWeight(input.sourceType);
    const contentQualityScore = this.calculateContentQualityScore(input.content || '');

    const score = this.calculateFromInput(input);
    const level = this.getCredibilityLevel(score);

    return {
      score,
      level,
      components: {
        normalizedFeedback,
        normalizedUsage,
        recencyScore,
        sourceWeight,
        contentQualityScore,
      },
      calculatedAt: Date.now(),
    };
  }

  /**
   * 批量计算可信度
   * 
   * @param entries 知识条目列表
   * @returns 带可信度的条目列表
   */
  calculateBatch(entries: KnowledgeEntry[]): ScoredKnowledgeEntry[] {
    return entries.map(entry => {
      const score = this.calculate(entry);
      const level = this.getCredibilityLevel(score);
      
      return {
        ...entry,
        credibilityScore: score,
        credibilityLevel: level,
      };
    });
  }

  /**
   * 获取来源权重
   * Requirements: 4.2
   * 
   * @param source 来源类型
   * @returns 权重值 (0-1)
   */
  getSourceWeight(source: KnowledgeSource | 'manual'): number {
    return this.config.sourceWeights[source] ?? SOURCE_WEIGHTS.auto_generated;
  }

  /**
   * 获取可信度等级
   * Requirements: 4.3
   * 
   * @param score 可信度分数
   * @returns 可信度等级
   */
  getCredibilityLevel(score: number): CredibilityLevel {
    if (score < this.config.lowCredibilityThreshold) {
      return 'low';
    }
    if (score >= this.config.highCredibilityThreshold) {
      return 'high';
    }
    return 'medium';
  }

  /**
   * 判断是否为低可信度
   * Requirements: 4.3
   */
  isLowCredibility(score: number): boolean {
    return score < this.config.lowCredibilityThreshold;
  }

  /**
   * 计算反馈更新后的新分数
   * Requirements: 4.5
   * 
   * @param currentScore 当前反馈分数
   * @param currentCount 当前反馈数量
   * @param feedback 新反馈类型
   * @returns 更新后的反馈分数
   */
  calculateUpdatedFeedbackScore(
    currentScore: number,
    currentCount: number,
    feedback: FeedbackType
  ): number {
    const feedbackValue = FEEDBACK_SCORES[feedback];
    
    // 使用加权平均更新分数
    if (currentCount === 0) {
      // 第一次反馈，直接使用反馈值（映射到 0-5 范围）
      return Math.max(0, Math.min(5, 2.5 + feedbackValue * 2.5));
    }
    
    // 增量更新：新分数 = (旧分数 * 旧数量 + 新反馈值) / (旧数量 + 1)
    const newScore = (currentScore * currentCount + (2.5 + feedbackValue * 2.5)) / (currentCount + 1);
    return Math.max(0, Math.min(5, newScore));
  }

  // ==================== 私有方法 ====================

  /**
   * 从知识条目提取可信度计算输入
   */
  private extractCredibilityInput(entry: KnowledgeEntry): CredibilityInput {
    const metadata = entry.metadata;
    
    // 确定来源类型
    let sourceType: KnowledgeSource | 'manual' = 'auto_generated';
    
    // 优先检查 entry.type
    if (entry.type === 'manual') {
      sourceType = 'manual';
    } else if (metadata.source) {
      const sourceLower = metadata.source.toLowerCase();
      if (sourceLower.includes('official') || sourceLower.includes('doc')) {
        sourceType = 'official_doc';
      } else if (sourceLower.includes('manual') || sourceLower.includes('user-added')) {
        sourceType = 'manual';
      } else if (sourceLower.includes('case') || sourceLower.includes('history') || sourceLower.includes('alert')) {
        sourceType = 'historical_case';
      } else if (sourceLower.includes('feedback') || sourceLower.includes('user')) {
        sourceType = 'user_feedback';
      }
    }

    return {
      feedbackScore: metadata.feedbackScore || 0,
      feedbackCount: metadata.feedbackCount || 0,
      usageCount: metadata.usageCount || 0,
      timestamp: metadata.timestamp || entry.createdAt,
      sourceType,
      content: entry.content,
    };
  }

  /**
   * 归一化反馈分数到 [0, 1]
   * Requirements: 3.3
   * 
   * 优化：新知识没有反馈时给予较高的基础分
   */
  private normalizeFeedbackScore(score: number, count: number): number {
    if (count === 0) {
      // 没有反馈时返回配置的基础分（默认 0.6）
      return this.config.newKnowledgeBaseScore;
    }
    // 假设反馈分数范围是 0-5，归一化到 0-1
    return Math.max(0, Math.min(1, score / this.config.maxFeedbackScore));
  }

  /**
   * 归一化使用次数到 [0, 1]
   * Requirements: 3.4
   */
  private normalizeUsageCount(count: number): number {
    if (count <= 0) {
      // 没有使用记录时给予中等分数，避免新知识被惩罚
      return 0.5;
    }
    // 使用对数归一化，避免高使用次数过度影响
    // 公式: log(1 + count) / log(1 + maxCount)
    const normalizedLog = Math.log(1 + count) / Math.log(1 + this.config.maxUsageCount);
    return Math.max(0, Math.min(1, normalizedLog));
  }

  /**
   * 计算时效性分数
   * Requirements: 3.2
   * 
   * 公式: max(0, 1 - age/maxAge)
   */
  private calculateRecencyScore(timestamp: number): number {
    const now = Date.now();
    const age = now - timestamp;
    
    if (age <= 0) {
      return 1;
    }
    
    const score = 1 - age / this.config.maxAgeMs;
    return Math.max(0, Math.min(1, score));
  }

  /**
   * 计算内容质量分数
   * 
   * 检测知识是否包含具体方案/步骤/命令
   * 
   * @param content 知识内容
   * @returns 质量分数 (0-1)
   */
  private calculateContentQualityScore(content: string): number {
    if (!content || content.length === 0) {
      return 0.3; // 空内容给予低分
    }

    const contentLower = content.toLowerCase();
    let score = 0.5; // 基础分

    // 1. 检查设备命令路径（精确匹配）
    const deviceCommandMatches = DEVICE_COMMAND_PATHS.filter(
      cmdPath => content.includes(cmdPath)  // 区分大小写，设备命令通常是小写
    );
    
    // 每个设备命令增加 0.05 分，最多增加 0.25
    // 包含具体命令说明知识有实际操作价值
    score += Math.min(0.25, deviceCommandMatches.length * 0.05);

    // 2. 检查高质量指标（通用）
    const highQualityMatches = CONTENT_QUALITY_INDICATORS.highQuality.filter(
      indicator => contentLower.includes(indicator.toLowerCase())
    );
    
    // 每个高质量指标增加 0.05 分，最多增加 0.15
    score += Math.min(0.15, highQualityMatches.length * 0.05);

    // 3. 检查中等质量指标
    const mediumQualityMatches = CONTENT_QUALITY_INDICATORS.mediumQuality.filter(
      indicator => contentLower.includes(indicator.toLowerCase())
    );
    
    // 每个中等质量指标增加 0.03 分，最多增加 0.1
    score += Math.min(0.1, mediumQualityMatches.length * 0.03);

    // 4. 内容长度加分（较长的内容通常更详细）
    if (content.length > 500) {
      score += 0.03;
    }
    if (content.length > 1000) {
      score += 0.02;
    }

    return Math.max(0, Math.min(1, score));
  }
}

// 导出单例实例
export const credibilityCalculator = new CredibilityCalculator();
