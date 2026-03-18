/**
 * SkillMetrics - Skill 使用指标追踪
 * 
 * 记录和分析 Skill 的使用情况、成功率、响应时间等指标
 * 
 * Requirements: 11.1-11.7
 * - 11.1: 使用计数记录
 * - 11.2: 成功率计算
 * - 11.3: 响应时间统计
 * - 11.4: 匹配类型分布
 * - 11.5: 反馈统计
 * - 11.6: 指标持久化
 * - 11.7: 低成功率 Skill 标记
 * 
 * AI-OPS 智能进化系统扩展 (Requirements: 4.1.1, 4.1.2, 4.1.3, 4.1.4)
 * - 4.1.1: 工具级别指标收集
 * - 4.1.2: 记录成功率、耗时、失败模式
 * - 4.1.3: 工具健康度监控
 * - 4.1.4: 失败模式分析
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { logger } from '../../../utils/logger';
import { SkillMatchType, SkillUsageMetrics } from '../../../types/skill';
import { FeedbackService } from '../feedbackService';

// ==================== 工具指标类型定义 ====================
// Requirements: 4.1.1, 4.1.2, 4.1.3, 4.1.4

/**
 * 工具失败模式
 * Requirements: 4.1.4
 */
export interface ToolFailurePattern {
  /** 失败类型 */
  failureType: string;
  /** 失败次数 */
  count: number;
  /** 最近失败时间 */
  lastOccurrence: Date;
  /** 典型参数模式 */
  typicalParams?: Record<string, unknown>;
  /** 建议的参数调整 */
  suggestedFix?: string;
}

/**
 * 工具使用指标
 * Requirements: 4.1.1, 4.1.2
 */
export interface ToolUsageMetrics {
  /** 工具名称 */
  toolName: string;
  /** 使用次数 */
  usageCount: number;
  /** 成功次数 */
  successCount: number;
  /** 失败次数 */
  failureCount: number;
  /** 总响应时间（毫秒） */
  totalResponseTime: number;
  /** 平均响应时间（毫秒） */
  avgResponseTime: number;
  /** 最小响应时间（毫秒） */
  minResponseTime: number;
  /** 最大响应时间（毫秒） */
  maxResponseTime: number;
  /** 成功率 */
  successRate: number;
  /** 最后使用时间 */
  lastUsedAt: Date;
  /** 失败模式统计 */
  failurePatterns: ToolFailurePattern[];
  /** 按 Skill 分组的使用统计 */
  usageBySkill: Record<string, number>;
  /** 健康度评分 (0-100) */
  healthScore: number;
  /** 是否处于熔断状态 */
  circuitBreakerOpen: boolean;
  /** 熔断开启时间 */
  circuitBreakerOpenedAt?: Date;
}

/**
 * 工具健康状态
 * Requirements: 4.1.3
 */
export interface ToolHealthStatus {
  /** 工具名称 */
  toolName: string;
  /** 健康状态 */
  status: 'healthy' | 'degraded' | 'unhealthy';
  /** 健康度评分 */
  healthScore: number;
  /** 成功率 */
  successRate: number;
  /** 平均响应时间 */
  avgResponseTime: number;
  /** 熔断器状态 */
  circuitBreakerOpen: boolean;
  /** 主要失败模式 */
  topFailurePatterns: ToolFailurePattern[];
  /** 建议 */
  recommendations: string[];
}

/**
 * SkillMetrics 配置
 */
export interface SkillMetricsConfig {
  /** 指标文件路径 */
  metricsFile: string;
  /** 自动保存间隔（毫秒），默认 60000 */
  autoSaveInterval: number;
  /** 低成功率阈值，默认 0.7 */
  lowSuccessRateThreshold: number;
  /** 最小使用次数（用于计算成功率），默认 10 */
  minUsageForStats: number;
  /** 是否集成 FeedbackService */
  integrateFeedbackService: boolean;
}

/**
 * 默认配置
 */
const DEFAULT_CONFIG: SkillMetricsConfig = {
  metricsFile: 'data/ai-ops/skills/metrics.json',
  autoSaveInterval: 60000,
  lowSuccessRateThreshold: 0.7,
  minUsageForStats: 10,
  integrateFeedbackService: true,
};

/**
 * SkillMetrics 类
 * 追踪和管理 Skill 使用指标
 */
export class SkillMetrics {
  private config: SkillMetricsConfig;
  private metrics: Map<string, SkillUsageMetrics> = new Map();
  private toolMetrics: Map<string, ToolUsageMetrics> = new Map(); // Requirements: 4.1.1
  private dirtyVersion: number = 0;  // 使用版本号替代布尔值，解决竞态条件
  private flushing: boolean = false;
  private saveTimer: NodeJS.Timeout | null = null;
  private initialized: boolean = false;
  private feedbackService: FeedbackService | null = null;

  constructor(config?: Partial<SkillMetricsConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * 设置 FeedbackService（用于集成）
   * Requirements: 12.1-12.5
   */
  setFeedbackService(feedbackService: FeedbackService): void {
    this.feedbackService = feedbackService;
    logger.debug('FeedbackService integrated with SkillMetrics');
  }

  /**
   * 加载指标数据
   * Requirements: 11.6, 4.1.1
   * 
   * 支持两种数据格式：
   * - v1: 直接的 skill 指标对象
   * - v2: { skills: {...}, tools: {...}, version: 2 }
   */
  async load(): Promise<void> {
    try {
      const content = await fs.readFile(this.config.metricsFile, 'utf-8');
      const data = JSON.parse(content);
      
      // 检测数据格式版本
      if (data.version === 2) {
        // v2 格式：包含 skills 和 tools
        this.loadV2Format(data);
      } else {
        // v1 格式：直接的 skill 指标对象（向后兼容）
        this.loadV1Format(data);
      }
      
      logger.info('SkillMetrics loaded', { 
        skillCount: this.metrics.size,
        toolCount: this.toolMetrics.size,
        version: data.version || 1,
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        logger.info('No existing metrics file, starting fresh');
      } else {
        logger.warn('Failed to load metrics', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    
    this.initialized = true;
    this.startAutoSave();
  }

  /**
   * 加载 v1 格式数据（向后兼容）
   */
  private loadV1Format(data: Record<string, unknown>): void {
    for (const [name, metrics] of Object.entries(data)) {
      // 跳过元数据字段
      if (name === 'savedAt' || name === 'version') {
        continue;
      }
      const m = metrics as SkillUsageMetrics;
      // 转换日期字符串
      if (m.lastUsedAt) {
        m.lastUsedAt = new Date(m.lastUsedAt);
      }
      this.metrics.set(name, m);
    }
  }

  /**
   * 加载 v2 格式数据
   * Requirements: 4.1.1
   */
  private loadV2Format(data: { skills?: Record<string, unknown>; tools?: Record<string, unknown> }): void {
    // 加载 skill 指标
    if (data.skills) {
      for (const [name, metrics] of Object.entries(data.skills)) {
        const m = metrics as SkillUsageMetrics;
        if (m.lastUsedAt) {
          m.lastUsedAt = new Date(m.lastUsedAt);
        }
        this.metrics.set(name, m);
      }
    }
    
    // 加载 tool 指标
    if (data.tools) {
      for (const [name, metrics] of Object.entries(data.tools)) {
        const m = metrics as ToolUsageMetrics;
        // 转换日期字符串
        if (m.lastUsedAt) {
          m.lastUsedAt = new Date(m.lastUsedAt);
        }
        if (m.circuitBreakerOpenedAt) {
          m.circuitBreakerOpenedAt = new Date(m.circuitBreakerOpenedAt);
        }
        // 转换失败模式中的日期
        if (m.failurePatterns) {
          for (const pattern of m.failurePatterns) {
            if (pattern.lastOccurrence) {
              pattern.lastOccurrence = new Date(pattern.lastOccurrence);
            }
          }
        }
        // 确保 minResponseTime 有效值
        if (m.minResponseTime === null || m.minResponseTime === undefined) {
          m.minResponseTime = Infinity;
        }
        this.toolMetrics.set(name, m);
      }
    }
  }

  /**
   * 启动自动保存
   */
  private startAutoSave(): void {
    if (this.saveTimer) {
      clearInterval(this.saveTimer);
    }
    
    this.saveTimer = setInterval(async () => {
      if (this.dirtyVersion > 0) {
        await this.flush();
      }
    }, this.config.autoSaveInterval);
  }

  /**
   * 停止自动保存
   */
  stopAutoSave(): void {
    if (this.saveTimer) {
      clearInterval(this.saveTimer);
      this.saveTimer = null;
    }
  }

  /**
   * 获取或创建指标
   */
  private getOrCreate(skillName: string): SkillUsageMetrics {
    let metrics = this.metrics.get(skillName);
    if (!metrics) {
      metrics = {
        skillName,
        usageCount: 0,
        successCount: 0,
        failureCount: 0,
        totalResponseTime: 0,
        avgResponseTime: 0,
        successRate: 0,
        lastUsedAt: new Date(),
        matchTypeDistribution: {
          [SkillMatchType.EXPLICIT]: 0,
          [SkillMatchType.TRIGGER]: 0,
          [SkillMatchType.INTENT]: 0,
          [SkillMatchType.SEMANTIC]: 0,
          [SkillMatchType.CONTEXT]: 0,
          [SkillMatchType.FALLBACK]: 0,
        },
        feedbackStats: {
          positive: 0,
          negative: 0,
          satisfaction: 0,
        },
      };
      this.metrics.set(skillName, metrics);
    }
    return metrics;
  }

  /**
   * 记录 Skill 使用
   * Requirements: 11.1, 11.4
   */
  recordUsage(skillName: string, matchType: SkillMatchType): void {
    const metrics = this.getOrCreate(skillName);
    metrics.usageCount++;
    metrics.lastUsedAt = new Date();
    metrics.matchTypeDistribution[matchType] = 
      (metrics.matchTypeDistribution[matchType] || 0) + 1;
    
    this.dirtyVersion++;
    
    logger.debug('Skill usage recorded', {
      skillName,
      matchType,
      usageCount: metrics.usageCount,
    });
  }

  /**
   * 记录任务完成
   * Requirements: 11.2, 11.3
   */
  recordCompletion(skillName: string, success: boolean, responseTime: number): void {
    const metrics = this.getOrCreate(skillName);
    
    if (success) {
      metrics.successCount++;
    } else {
      metrics.failureCount++;
    }
    
    metrics.totalResponseTime += responseTime;
    
    // 重新计算平均值和成功率
    const totalCompletions = metrics.successCount + metrics.failureCount;
    if (totalCompletions > 0) {
      metrics.avgResponseTime = metrics.totalResponseTime / totalCompletions;
      metrics.successRate = metrics.successCount / totalCompletions;
    }
    
    this.dirtyVersion++;
    
    logger.debug('Skill completion recorded', {
      skillName,
      success,
      responseTime,
      successRate: metrics.successRate,
    });
  }

  /**
   * 记录用户反馈
   * Requirements: 11.5
   */
  recordFeedback(skillName: string, positive: boolean): void {
    const metrics = this.getOrCreate(skillName);
    
    if (positive) {
      metrics.feedbackStats.positive++;
    } else {
      metrics.feedbackStats.negative++;
    }
    
    // 重新计算满意度
    const totalFeedback = metrics.feedbackStats.positive + metrics.feedbackStats.negative;
    if (totalFeedback > 0) {
      metrics.feedbackStats.satisfaction = 
        metrics.feedbackStats.positive / totalFeedback;
    }
    
    this.dirtyVersion++;
    
    logger.debug('Skill feedback recorded', {
      skillName,
      positive,
      satisfaction: metrics.feedbackStats.satisfaction,
    });
  }

  /**
   * 获取 Skill 指标
   */
  getMetrics(skillName: string): SkillUsageMetrics | undefined {
    return this.metrics.get(skillName);
  }

  /**
   * 获取所有指标
   */
  getAllMetrics(): SkillUsageMetrics[] {
    return Array.from(this.metrics.values());
  }

  /**
   * 获取需要审查的 Skill（低成功率）
   * Requirements: 11.7
   */
  getSkillsNeedingReview(): SkillUsageMetrics[] {
    return this.getAllMetrics()
      .filter(m => 
        m.usageCount >= this.config.minUsageForStats && 
        m.successRate < this.config.lowSuccessRateThreshold
      )
      .sort((a, b) => a.successRate - b.successRate);
  }

  /**
   * 获取热门 Skill
   */
  getTopSkills(limit: number = 10): SkillUsageMetrics[] {
    return this.getAllMetrics()
      .sort((a, b) => b.usageCount - a.usageCount)
      .slice(0, limit);
  }

  /**
   * 获取最近使用的 Skill
   */
  getRecentlyUsedSkills(limit: number = 10): SkillUsageMetrics[] {
    return this.getAllMetrics()
      .filter(m => m.lastUsedAt)
      .sort((a, b) => {
        const aTime = a.lastUsedAt?.getTime() || 0;
        const bTime = b.lastUsedAt?.getTime() || 0;
        return bTime - aTime;
      })
      .slice(0, limit);
  }

  /**
   * 获取匹配类型统计
   */
  getMatchTypeStats(): Record<SkillMatchType, number> {
    const stats: Record<string, number> = {
      [SkillMatchType.EXPLICIT]: 0,
      [SkillMatchType.TRIGGER]: 0,
      [SkillMatchType.INTENT]: 0,
      [SkillMatchType.SEMANTIC]: 0,
      [SkillMatchType.CONTEXT]: 0,
      [SkillMatchType.FALLBACK]: 0,
    };
    
    for (const metrics of this.metrics.values()) {
      for (const [type, count] of Object.entries(metrics.matchTypeDistribution)) {
        stats[type] = (stats[type] || 0) + count;
      }
    }
    
    return stats as Record<SkillMatchType, number>;
  }

  /**
   * 获取总体统计
   */
  getOverallStats(): {
    totalUsage: number;
    totalSuccess: number;
    totalFailure: number;
    overallSuccessRate: number;
    avgResponseTime: number;
    totalPositiveFeedback: number;
    totalNegativeFeedback: number;
    overallSatisfaction: number;
  } {
    let totalUsage = 0;
    let totalSuccess = 0;
    let totalFailure = 0;
    let totalResponseTime = 0;
    let totalPositiveFeedback = 0;
    let totalNegativeFeedback = 0;
    
    for (const metrics of this.metrics.values()) {
      totalUsage += metrics.usageCount;
      totalSuccess += metrics.successCount;
      totalFailure += metrics.failureCount;
      totalResponseTime += metrics.totalResponseTime;
      totalPositiveFeedback += metrics.feedbackStats.positive;
      totalNegativeFeedback += metrics.feedbackStats.negative;
    }
    
    const totalCompletions = totalSuccess + totalFailure;
    const totalFeedback = totalPositiveFeedback + totalNegativeFeedback;
    
    return {
      totalUsage,
      totalSuccess,
      totalFailure,
      overallSuccessRate: totalCompletions > 0 ? totalSuccess / totalCompletions : 0,
      avgResponseTime: totalCompletions > 0 ? totalResponseTime / totalCompletions : 0,
      totalPositiveFeedback,
      totalNegativeFeedback,
      overallSatisfaction: totalFeedback > 0 ? totalPositiveFeedback / totalFeedback : 0,
    };
  }

  /**
   * 重置 Skill 指标
   */
  resetMetrics(skillName: string): boolean {
    if (!this.metrics.has(skillName)) {
      return false;
    }
    
    this.metrics.delete(skillName);
    this.dirtyVersion++;
    
    logger.info('Skill metrics reset', { skillName });
    return true;
  }

  /**
   * 清空所有指标
   */
  clearAllMetrics(): void {
    this.metrics.clear();
    this.dirtyVersion++;
    logger.info('All skill metrics cleared');
  }

  /**
   * 持久化指标
   * Requirements: 11.6, 4.1.1
   * 
   * 使用版本号和 flushing 标志防止并发写入时的数据丢失
   */
  async flush(): Promise<void> {
    // 检查是否需要 flush
    const versionAtStart = this.dirtyVersion;
    if (versionAtStart === 0 || this.flushing) {
      return;
    }
    
    // 标记开始 flush
    this.flushing = true;
    
    try {
      // 确保目录存在
      const dir = path.dirname(this.config.metricsFile);
      await fs.mkdir(dir, { recursive: true });
      
      // 转换为普通对象（创建快照）
      const skillData: Record<string, SkillUsageMetrics> = {};
      for (const [name, metrics] of this.metrics) {
        // 深拷贝以避免在写入期间数据被修改
        skillData[name] = { ...metrics };
      }
      
      // 工具指标数据 (Requirements: 4.1.1)
      const toolData: Record<string, ToolUsageMetrics> = {};
      for (const [name, metrics] of this.toolMetrics) {
        toolData[name] = { ...metrics };
      }
      
      // 合并数据
      const data = {
        skills: skillData,
        tools: toolData,
        version: 2, // 数据格式版本
        savedAt: new Date().toISOString(),
      };
      
      await fs.writeFile(
        this.config.metricsFile,
        JSON.stringify(data, null, 2),
        'utf-8'
      );
      
      // 只有在 flush 期间没有新的写入时才清除版本号
      // 如果版本号增加了，说明有新数据需要在下次 flush 时保存
      if (this.dirtyVersion === versionAtStart) {
        this.dirtyVersion = 0;
      }
      
      logger.debug('SkillMetrics flushed to disk');
    } catch (error) {
      logger.error('Failed to flush metrics', {
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      this.flushing = false;
    }
  }

  /**
   * 检查是否已初始化
   */
  isInitialized(): boolean {
    return this.initialized;
  }

  /**
   * 关闭指标服务
   */
  async shutdown(): Promise<void> {
    this.stopAutoSave();
    await this.flush();
    logger.info('SkillMetrics shutdown');
  }

  // ==================== 工具指标方法 ====================
  // Requirements: 4.1.1, 4.1.2, 4.1.3, 4.1.4

  /**
   * 获取或创建工具指标
   * Requirements: 4.1.1
   */
  private getOrCreateToolMetrics(toolName: string): ToolUsageMetrics {
    let metrics = this.toolMetrics.get(toolName);
    if (!metrics) {
      metrics = {
        toolName,
        usageCount: 0,
        successCount: 0,
        failureCount: 0,
        totalResponseTime: 0,
        avgResponseTime: 0,
        minResponseTime: Infinity,
        maxResponseTime: 0,
        successRate: 1,
        lastUsedAt: new Date(),
        failurePatterns: [],
        usageBySkill: {},
        healthScore: 100,
        circuitBreakerOpen: false,
      };
      this.toolMetrics.set(toolName, metrics);
    }
    return metrics;
  }

  /**
   * 记录工具使用
   * Requirements: 4.1.1, 4.1.2
   * 
   * @param toolName 工具名称
   * @param skillName 调用该工具的 Skill 名称（可选）
   */
  recordToolUsage(toolName: string, skillName?: string): void {
    const metrics = this.getOrCreateToolMetrics(toolName);
    metrics.usageCount++;
    metrics.lastUsedAt = new Date();
    
    // 记录按 Skill 分组的使用
    if (skillName) {
      metrics.usageBySkill[skillName] = (metrics.usageBySkill[skillName] || 0) + 1;
    }
    
    this.dirtyVersion++;
    
    logger.debug('Tool usage recorded', {
      toolName,
      skillName,
      usageCount: metrics.usageCount,
    });
  }

  /**
   * 记录工具执行完成
   * Requirements: 4.1.2
   * 
   * @param toolName 工具名称
   * @param success 是否成功
   * @param responseTime 响应时间（毫秒）
   * @param failureType 失败类型（失败时）
   * @param params 调用参数（用于失败模式分析）
   */
  recordToolCompletion(
    toolName: string,
    success: boolean,
    responseTime: number,
    failureType?: string,
    params?: Record<string, unknown>
  ): void {
    const metrics = this.getOrCreateToolMetrics(toolName);
    
    if (success) {
      metrics.successCount++;
    } else {
      metrics.failureCount++;
      
      // 记录失败模式
      if (failureType) {
        this.recordToolFailurePattern(toolName, failureType, params);
      }
    }
    
    // 更新响应时间统计
    metrics.totalResponseTime += responseTime;
    metrics.minResponseTime = Math.min(metrics.minResponseTime, responseTime);
    metrics.maxResponseTime = Math.max(metrics.maxResponseTime, responseTime);
    
    // 重新计算平均值和成功率
    const totalCompletions = metrics.successCount + metrics.failureCount;
    if (totalCompletions > 0) {
      metrics.avgResponseTime = metrics.totalResponseTime / totalCompletions;
      metrics.successRate = metrics.successCount / totalCompletions;
    }
    
    // 更新健康度评分
    this.updateToolHealthScore(toolName);
    
    this.dirtyVersion++;
    
    logger.debug('Tool completion recorded', {
      toolName,
      success,
      responseTime,
      successRate: metrics.successRate,
      healthScore: metrics.healthScore,
    });
  }

  /**
   * 记录工具失败模式
   * Requirements: 4.1.4
   */
  private recordToolFailurePattern(
    toolName: string,
    failureType: string,
    params?: Record<string, unknown>
  ): void {
    const metrics = this.getOrCreateToolMetrics(toolName);
    
    // 查找现有的失败模式
    let pattern = metrics.failurePatterns.find(p => p.failureType === failureType);
    
    if (pattern) {
      pattern.count++;
      pattern.lastOccurrence = new Date();
      // 更新典型参数（保留最近的）
      if (params) {
        pattern.typicalParams = params;
      }
    } else {
      // 创建新的失败模式
      pattern = {
        failureType,
        count: 1,
        lastOccurrence: new Date(),
        typicalParams: params,
        suggestedFix: this.generateFailureFix(failureType),
      };
      metrics.failurePatterns.push(pattern);
    }
    
    // 限制失败模式数量（保留最常见的 10 个）
    if (metrics.failurePatterns.length > 10) {
      metrics.failurePatterns.sort((a, b) => b.count - a.count);
      metrics.failurePatterns = metrics.failurePatterns.slice(0, 10);
    }
  }

  /**
   * 生成失败修复建议
   * Requirements: 4.1.4
   */
  private generateFailureFix(failureType: string): string {
    const fixes: Record<string, string> = {
      'timeout': '考虑增加超时时间或使用 limit 参数减少数据量',
      'parameter_error': '检查参数格式，确保使用正确的 API 路径',
      'permission': '检查用户权限配置',
      'resource': '确认资源存在且路径正确',
      'network': '检查网络连接，稍后重试',
      'unknown': '查看详细日志进行诊断',
    };
    return fixes[failureType] || fixes['unknown'];
  }

  /**
   * 更新工具健康度评分
   * Requirements: 4.1.3
   */
  private updateToolHealthScore(toolName: string): void {
    const metrics = this.getOrCreateToolMetrics(toolName);
    
    // 健康度评分计算：
    // - 成功率权重: 60%
    // - 响应时间权重: 30%（基于阈值）
    // - 失败模式多样性权重: 10%
    
    let score = 100;
    
    // 成功率影响（60%）
    score -= (1 - metrics.successRate) * 60;
    
    // 响应时间影响（30%）
    // 假设 5000ms 为阈值，超过则扣分
    const responseTimeThreshold = 5000;
    if (metrics.avgResponseTime > responseTimeThreshold) {
      const penalty = Math.min(30, (metrics.avgResponseTime - responseTimeThreshold) / 1000 * 5);
      score -= penalty;
    }
    
    // 失败模式多样性影响（10%）
    // 多种失败模式表示问题更复杂
    const patternPenalty = Math.min(10, metrics.failurePatterns.length * 2);
    score -= patternPenalty;
    
    metrics.healthScore = Math.max(0, Math.min(100, Math.round(score)));
    
    // 检查是否需要触发熔断
    if (metrics.healthScore < 30 && !metrics.circuitBreakerOpen) {
      this.openCircuitBreaker(toolName);
    } else if (metrics.healthScore >= 50 && metrics.circuitBreakerOpen) {
      this.closeCircuitBreaker(toolName);
    }
  }

  /**
   * 开启熔断器
   * Requirements: 4.1.3
   */
  openCircuitBreaker(toolName: string): void {
    const metrics = this.getOrCreateToolMetrics(toolName);
    metrics.circuitBreakerOpen = true;
    metrics.circuitBreakerOpenedAt = new Date();
    
    this.dirtyVersion++;
    
    logger.warn('Tool circuit breaker opened', {
      toolName,
      healthScore: metrics.healthScore,
      successRate: metrics.successRate,
    });
  }

  /**
   * 关闭熔断器
   * Requirements: 4.1.3
   */
  closeCircuitBreaker(toolName: string): void {
    const metrics = this.getOrCreateToolMetrics(toolName);
    metrics.circuitBreakerOpen = false;
    metrics.circuitBreakerOpenedAt = undefined;
    
    this.dirtyVersion++;
    
    logger.info('Tool circuit breaker closed', {
      toolName,
      healthScore: metrics.healthScore,
      successRate: metrics.successRate,
    });
  }

  /**
   * 获取工具指标
   * Requirements: 4.1.1
   */
  getToolMetrics(toolName: string): ToolUsageMetrics | undefined {
    return this.toolMetrics.get(toolName);
  }

  /**
   * 获取所有工具指标
   * Requirements: 4.1.1
   */
  getAllToolMetrics(): ToolUsageMetrics[] {
    return Array.from(this.toolMetrics.values());
  }

  /**
   * 获取工具健康状态
   * Requirements: 4.1.3
   */
  getToolHealthStatus(toolName: string): ToolHealthStatus | undefined {
    const metrics = this.toolMetrics.get(toolName);
    if (!metrics) {
      return undefined;
    }
    
    // 确定健康状态
    let status: 'healthy' | 'degraded' | 'unhealthy';
    if (metrics.healthScore >= 80) {
      status = 'healthy';
    } else if (metrics.healthScore >= 50) {
      status = 'degraded';
    } else {
      status = 'unhealthy';
    }
    
    // 生成建议
    const recommendations: string[] = [];
    if (metrics.successRate < 0.8) {
      recommendations.push('成功率较低，建议检查常见失败模式');
    }
    if (metrics.avgResponseTime > 5000) {
      recommendations.push('平均响应时间较长，建议优化查询参数');
    }
    if (metrics.circuitBreakerOpen) {
      recommendations.push('熔断器已开启，工具暂时不可用');
    }
    if (metrics.failurePatterns.length > 3) {
      recommendations.push('存在多种失败模式，建议进行全面诊断');
    }
    
    return {
      toolName,
      status,
      healthScore: metrics.healthScore,
      successRate: metrics.successRate,
      avgResponseTime: metrics.avgResponseTime,
      circuitBreakerOpen: metrics.circuitBreakerOpen,
      topFailurePatterns: metrics.failurePatterns.slice(0, 3),
      recommendations,
    };
  }

  /**
   * 获取所有工具健康状态
   * Requirements: 4.1.3
   */
  getAllToolHealthStatus(): ToolHealthStatus[] {
    return this.getAllToolMetrics()
      .map(m => this.getToolHealthStatus(m.toolName)!)
      .filter(s => s !== undefined);
  }

  /**
   * 获取不健康的工具
   * Requirements: 4.1.3
   */
  getUnhealthyTools(): ToolHealthStatus[] {
    return this.getAllToolHealthStatus()
      .filter(s => s.status === 'unhealthy' || s.status === 'degraded')
      .sort((a, b) => a.healthScore - b.healthScore);
  }

  /**
   * 获取工具优先级排序（基于健康度和成功率）
   * Requirements: 4.2.1, 4.2.2
   */
  getToolPriorityRanking(): Array<{ toolName: string; score: number; rank: number }> {
    const tools = this.getAllToolMetrics();
    
    // 计算综合得分
    const scored = tools.map(m => ({
      toolName: m.toolName,
      score: this.calculateToolPriorityScore(m),
    }));
    
    // 排序
    scored.sort((a, b) => b.score - a.score);
    
    // 添加排名
    return scored.map((t, index) => ({
      ...t,
      rank: index + 1,
    }));
  }

  /**
   * 计算工具优先级得分
   * Requirements: 4.2.2
   */
  private calculateToolPriorityScore(metrics: ToolUsageMetrics): number {
    // 综合得分 = 健康度 * 0.4 + 成功率 * 100 * 0.4 + 使用频率归一化 * 0.2
    const healthComponent = metrics.healthScore * 0.4;
    const successComponent = metrics.successRate * 100 * 0.4;
    
    // 使用频率归一化（假设 100 次为满分）
    const usageComponent = Math.min(100, metrics.usageCount) * 0.2;
    
    return healthComponent + successComponent + usageComponent;
  }

  /**
   * 重置工具指标
   */
  resetToolMetrics(toolName: string): boolean {
    if (!this.toolMetrics.has(toolName)) {
      return false;
    }
    
    this.toolMetrics.delete(toolName);
    this.dirtyVersion++;
    
    logger.info('Tool metrics reset', { toolName });
    return true;
  }

  /**
   * 清空所有工具指标
   */
  clearAllToolMetrics(): void {
    this.toolMetrics.clear();
    this.dirtyVersion++;
    logger.info('All tool metrics cleared');
  }

  // ==================== 失败模式分析方法 ====================
  // Requirements: 4.3.1, 4.3.2, 4.3.3, 4.3.4

  /**
   * 分析工具失败模式
   * Requirements: 4.3.1, 4.3.2
   * 
   * @param toolName 工具名称
   * @returns 失败模式分析结果
   */
  analyzeFailurePatterns(toolName: string): {
    toolName: string;
    totalFailures: number;
    patterns: ToolFailurePattern[];
    dominantPattern?: ToolFailurePattern;
    parameterCorrelations: Array<{ param: string; failureRate: number }>;
    recommendations: string[];
  } | undefined {
    const metrics = this.toolMetrics.get(toolName);
    if (!metrics) {
      return undefined;
    }

    const patterns = [...metrics.failurePatterns].sort((a, b) => b.count - a.count);
    const dominantPattern = patterns.length > 0 ? patterns[0] : undefined;

    // 分析参数相关性
    const parameterCorrelations = this.analyzeParameterCorrelations(patterns);

    // 生成建议
    const recommendations = this.generateFailureRecommendations(metrics, patterns);

    return {
      toolName,
      totalFailures: metrics.failureCount,
      patterns,
      dominantPattern,
      parameterCorrelations,
      recommendations,
    };
  }

  /**
   * 分析参数与失败的相关性
   * Requirements: 4.3.2
   */
  private analyzeParameterCorrelations(
    patterns: ToolFailurePattern[]
  ): Array<{ param: string; failureRate: number }> {
    const paramCounts: Record<string, { total: number; failures: number }> = {};

    for (const pattern of patterns) {
      if (pattern.typicalParams) {
        for (const param of Object.keys(pattern.typicalParams)) {
          if (!paramCounts[param]) {
            paramCounts[param] = { total: 0, failures: 0 };
          }
          paramCounts[param].total += pattern.count;
          paramCounts[param].failures += pattern.count;
        }
      }
    }

    return Object.entries(paramCounts)
      .map(([param, counts]) => ({
        param,
        failureRate: counts.total > 0 ? counts.failures / counts.total : 0,
      }))
      .sort((a, b) => b.failureRate - a.failureRate);
  }

  /**
   * 生成失败修复建议
   * Requirements: 4.3.3
   */
  private generateFailureRecommendations(
    metrics: ToolUsageMetrics,
    patterns: ToolFailurePattern[]
  ): string[] {
    const recommendations: string[] = [];

    // 基于成功率的建议
    if (metrics.successRate < 0.5) {
      recommendations.push('成功率极低，建议暂停使用该工具并进行全面诊断');
    } else if (metrics.successRate < 0.8) {
      recommendations.push('成功率较低，建议检查常见失败模式并优化参数');
    }

    // 基于主要失败模式的建议
    if (patterns.length > 0) {
      const dominant = patterns[0];
      if (dominant.suggestedFix) {
        recommendations.push(`主要失败类型 "${dominant.failureType}": ${dominant.suggestedFix}`);
      }
    }

    // 基于失败模式多样性的建议
    if (patterns.length > 5) {
      recommendations.push('存在多种失败模式，建议进行系统性排查');
    }

    // 基于响应时间的建议
    if (metrics.avgResponseTime > 10000) {
      recommendations.push('响应时间过长，建议检查网络连接或减少数据量');
    }

    return recommendations;
  }

  /**
   * 获取参数调整建议
   * Requirements: 4.3.3, 4.3.4
   * 
   * @param toolName 工具名称
   * @param currentParams 当前参数
   * @returns 调整后的参数建议
   */
  getParameterAdjustmentSuggestions(
    toolName: string,
    currentParams: Record<string, unknown>
  ): {
    adjustedParams: Record<string, unknown>;
    changes: Array<{ param: string; from: unknown; to: unknown; reason: string }>;
  } {
    const metrics = this.toolMetrics.get(toolName);
    const adjustedParams = { ...currentParams };
    const changes: Array<{ param: string; from: unknown; to: unknown; reason: string }> = [];

    if (!metrics || metrics.failurePatterns.length === 0) {
      return { adjustedParams, changes };
    }

    // 分析失败模式中的参数
    for (const pattern of metrics.failurePatterns) {
      if (pattern.typicalParams) {
        for (const [param, failedValue] of Object.entries(pattern.typicalParams)) {
          // 如果当前参数与失败模式中的参数相同，建议调整
          if (currentParams[param] === failedValue) {
            const suggestion = this.suggestParameterValue(param, failedValue, pattern.failureType);
            if (suggestion !== undefined && suggestion !== failedValue) {
              adjustedParams[param] = suggestion;
              changes.push({
                param,
                from: failedValue,
                to: suggestion,
                reason: `避免 "${pattern.failureType}" 类型失败`,
              });
            }
          }
        }
      }
    }

    return { adjustedParams, changes };
  }

  /**
   * 建议参数值
   * Requirements: 4.3.4
   */
  private suggestParameterValue(
    param: string,
    currentValue: unknown,
    failureType: string
  ): unknown {
    // 基于失败类型和参数名称的启发式建议
    if (failureType === 'timeout') {
      if (param === 'limit' && typeof currentValue === 'number') {
        return Math.max(10, Math.floor(currentValue / 2));
      }
      if (param === 'timeout' && typeof currentValue === 'number') {
        return currentValue * 2;
      }
    }

    if (failureType === 'parameter_error') {
      // 对于路径参数，尝试添加前缀
      if (param === 'path' && typeof currentValue === 'string') {
        if (!currentValue.startsWith('/')) {
          return '/' + currentValue;
        }
      }
    }

    return undefined;
  }

  /**
   * 获取全局失败模式统计
   * Requirements: 4.3.1
   */
  getGlobalFailureStats(): {
    totalFailures: number;
    failuresByType: Record<string, number>;
    mostProblematicTools: Array<{ toolName: string; failureCount: number; successRate: number }>;
  } {
    let totalFailures = 0;
    const failuresByType: Record<string, number> = {};
    const toolStats: Array<{ toolName: string; failureCount: number; successRate: number }> = [];

    for (const metrics of this.toolMetrics.values()) {
      totalFailures += metrics.failureCount;
      toolStats.push({
        toolName: metrics.toolName,
        failureCount: metrics.failureCount,
        successRate: metrics.successRate,
      });

      for (const pattern of metrics.failurePatterns) {
        failuresByType[pattern.failureType] = 
          (failuresByType[pattern.failureType] || 0) + pattern.count;
      }
    }

    // 按失败次数排序
    toolStats.sort((a, b) => b.failureCount - a.failureCount);

    return {
      totalFailures,
      failuresByType,
      mostProblematicTools: toolStats.slice(0, 5),
    };
  }
}

// 导出单例实例
export const skillMetrics = new SkillMetrics();
