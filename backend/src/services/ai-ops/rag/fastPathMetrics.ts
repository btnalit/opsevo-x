/**
 * FastPathMetrics - 快速路径指标记录服务
 * 
 * 实现快速路径统计、决策日志记录和反馈闭环。
 * 
 * Requirements: 6.4, 7.1, 7.2, 7.3, 7.4, 7.5
 * - 6.4: 记录快速路径命中率指标
 * - 7.1: 记录每次快速路径决策
 * - 7.2: 支持用户反馈调整阈值
 * - 7.3: 检测假阳性
 * - 7.4: 检测假阴性
 * - 7.5: 提供统计 API
 */

import { logger } from '../../../utils/logger';
import { v4 as uuidv4 } from 'uuid';
import * as fs from 'fs/promises';
import * as path from 'path';
import {
  FastPathStats,
  FastPathFeedback,
  FastPathDecisionLog,
  ResponseMode,
  IntentClassification,
} from '../../../types/fast-path';

// ==================== 常量定义 ====================

const METRICS_DATA_DIR = 'data/ai-ops/rag/fast-path-metrics';
const DECISION_LOGS_FILE = 'decision-logs.json';
const STATS_FILE = 'stats.json';
const FEEDBACK_FILE = 'feedback.json';

// 最大保留的决策日志数量
const MAX_DECISION_LOGS = 10000;

// ==================== FastPathMetrics 类 ====================

/**
 * FastPathMetrics 配置
 */
export interface FastPathMetricsConfig {
  /** 数据目录 */
  dataDir: string;
  /** 是否启用持久化 */
  enablePersistence: boolean;
  /** 自动保存间隔（毫秒） */
  autoSaveIntervalMs: number;
  /** 最大决策日志数量 */
  maxDecisionLogs: number;
}

/**
 * 默认配置
 */
const DEFAULT_CONFIG: FastPathMetricsConfig = {
  dataDir: METRICS_DATA_DIR,
  enablePersistence: true,
  autoSaveIntervalMs: 60000, // 1 分钟
  maxDecisionLogs: MAX_DECISION_LOGS,
};

/**
 * 时间窗口统计
 */
interface TimeWindowStats {
  /** 窗口开始时间 */
  windowStart: number;
  /** 窗口结束时间 */
  windowEnd: number;
  /** 查询数量 */
  queryCount: number;
  /** 直达命中数 */
  directHits: number;
  /** 增强命中数 */
  enhancedHits: number;
  /** 探索数 */
  explorationCount: number;
  /** 平均响应时间 */
  avgResponseTime: number;
  /** 平均置信度 */
  avgConfidence: number;
}

/**
 * FastPathMetrics 类
 * 
 * 快速路径指标记录和分析服务。
 */
export class FastPathMetrics {
  private config: FastPathMetricsConfig;
  private stats: FastPathStats;
  private decisionLogs: FastPathDecisionLog[] = [];
  private feedbackRecords: FastPathFeedback[] = [];
  private autoSaveTimer: ReturnType<typeof setInterval> | null = null;
  private initialized = false;

  // 累计值（用于计算平均值）
  private totalResponseTime = 0;
  private totalRetryCount = 0;
  private totalConfidence = 0;

  constructor(config?: Partial<FastPathMetricsConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.stats = this.createEmptyStats();
    logger.info('FastPathMetrics created', { config: this.config });
  }

  /**
   * 初始化
   */
  async initialize(): Promise<void> {
    if (this.initialized) {
      return;
    }

    try {
      if (this.config.enablePersistence) {
        await fs.mkdir(this.config.dataDir, { recursive: true });
        await this.loadData();
        this.startAutoSave();
      }

      this.initialized = true;
      logger.info('FastPathMetrics initialized', { 
        logsCount: this.decisionLogs.length,
        feedbackCount: this.feedbackRecords.length,
      });
    } catch (error) {
      logger.error('Failed to initialize FastPathMetrics', { error });
      // 不抛出错误，允许在无持久化的情况下运行
      this.initialized = true;
    }
  }

  /**
   * 记录决策
   * Requirements: 7.1
   */
  recordDecision(
    query: string,
    intentClassification: IntentClassification,
    responseMode: ResponseMode,
    confidence: number,
    retryCount: number,
    processingTime: number
  ): string {
    const logId = uuidv4();
    const queryId = uuidv4();

    const log: FastPathDecisionLog = {
      id: logId,
      queryId,
      query,
      intentClassification,
      responseMode,
      confidence,
      retryCount,
      processingTime,
      timestamp: Date.now(),
    };

    // 添加到日志列表
    this.decisionLogs.push(log);

    // 限制日志数量
    if (this.decisionLogs.length > this.config.maxDecisionLogs) {
      this.decisionLogs = this.decisionLogs.slice(-this.config.maxDecisionLogs);
    }

    // 更新统计
    this.updateStats(responseMode, confidence, retryCount, processingTime);

    logger.debug('Decision recorded', { logId, responseMode, confidence });
    return queryId;
  }

  /**
   * 记录反馈
   * Requirements: 7.2, 7.3, 7.4
   */
  recordFeedback(feedback: FastPathFeedback): void {
    this.feedbackRecords.push(feedback);

    // 查找对应的决策日志
    const log = this.decisionLogs.find(l => l.queryId === feedback.queryId);
    if (log) {
      log.feedback = feedback;

      // 检测假阳性（直达响应但答案错误）
      if (log.responseMode === 'direct' && !feedback.correct) {
        this.stats.falsePositives++;
        logger.info('False positive detected', { queryId: feedback.queryId });
      }

      // 检测假阴性（进入探索但知识存在）
      if (log.responseMode === 'exploration' && feedback.useful && feedback.correct) {
        // 如果用户反馈表明答案有用且正确，但我们进入了探索模式
        // 这可能是假阴性
        if (feedback.comment?.includes('知识库') || feedback.comment?.includes('应该直接')) {
          this.stats.falseNegatives++;
          logger.info('False negative detected', { queryId: feedback.queryId });
        }
      }
    }

    logger.info('Feedback recorded', { queryId: feedback.queryId, useful: feedback.useful });
  }

  /**
   * 更新统计
   */
  private updateStats(
    mode: ResponseMode,
    confidence: number,
    retryCount: number,
    processingTime: number
  ): void {
    this.stats.totalQueries++;
    this.totalResponseTime += processingTime;
    this.totalRetryCount += retryCount;
    this.totalConfidence += confidence;

    switch (mode) {
      case 'direct':
        this.stats.directHits++;
        break;
      case 'enhanced':
        this.stats.enhancedHits++;
        break;
      case 'exploration':
        this.stats.explorationCount++;
        break;
      case 'explicit_notification':
        this.stats.explicitNotificationCount++;
        break;
    }

    // 更新平均值
    this.stats.avgResponseTime = this.totalResponseTime / this.stats.totalQueries;
    this.stats.avgRetryCount = this.totalRetryCount / this.stats.totalQueries;
  }

  /**
   * 获取统计信息
   * Requirements: 7.5
   */
  getStats(): FastPathStats {
    return { ...this.stats };
  }

  /**
   * 获取命中率
   */
  getHitRate(): { direct: number; enhanced: number; total: number } {
    const total = this.stats.totalQueries;
    if (total === 0) {
      return { direct: 0, enhanced: 0, total: 0 };
    }

    return {
      direct: this.stats.directHits / total,
      enhanced: this.stats.enhancedHits / total,
      total: (this.stats.directHits + this.stats.enhancedHits) / total,
    };
  }

  /**
   * 获取时间窗口统计
   */
  getTimeWindowStats(windowMs: number = 3600000): TimeWindowStats {
    const now = Date.now();
    const windowStart = now - windowMs;

    const windowLogs = this.decisionLogs.filter(l => l.timestamp >= windowStart);

    if (windowLogs.length === 0) {
      return {
        windowStart,
        windowEnd: now,
        queryCount: 0,
        directHits: 0,
        enhancedHits: 0,
        explorationCount: 0,
        avgResponseTime: 0,
        avgConfidence: 0,
      };
    }

    const directHits = windowLogs.filter(l => l.responseMode === 'direct').length;
    const enhancedHits = windowLogs.filter(l => l.responseMode === 'enhanced').length;
    const explorationCount = windowLogs.filter(l => l.responseMode === 'exploration').length;
    const avgResponseTime = windowLogs.reduce((sum, l) => sum + l.processingTime, 0) / windowLogs.length;
    const avgConfidence = windowLogs.reduce((sum, l) => sum + l.confidence, 0) / windowLogs.length;

    return {
      windowStart,
      windowEnd: now,
      queryCount: windowLogs.length,
      directHits,
      enhancedHits,
      explorationCount,
      avgResponseTime,
      avgConfidence,
    };
  }

  /**
   * 获取决策日志
   */
  getDecisionLogs(limit?: number): FastPathDecisionLog[] {
    const logs = [...this.decisionLogs].reverse();
    return limit ? logs.slice(0, limit) : logs;
  }

  /**
   * 获取反馈记录
   */
  getFeedbackRecords(limit?: number): FastPathFeedback[] {
    const records = [...this.feedbackRecords].reverse();
    return limit ? records.slice(0, limit) : records;
  }

  /**
   * 分析假阳性/假阴性模式
   */
  analyzeErrorPatterns(): {
    falsePositivePatterns: string[];
    falseNegativePatterns: string[];
    suggestedThresholdAdjustment: { direct?: number; enhanced?: number };
  } {
    const falsePositiveLogs = this.decisionLogs.filter(
      l => l.feedback && !l.feedback.correct && l.responseMode === 'direct'
    );
    const falseNegativeLogs = this.decisionLogs.filter(
      l => l.feedback && l.feedback.useful && l.responseMode === 'exploration'
    );

    // 提取模式（简化实现）
    const falsePositivePatterns = falsePositiveLogs
      .slice(0, 10)
      .map(l => l.query.substring(0, 50));
    const falseNegativePatterns = falseNegativeLogs
      .slice(0, 10)
      .map(l => l.query.substring(0, 50));

    // 建议阈值调整
    const suggestedThresholdAdjustment: { direct?: number; enhanced?: number } = {};

    // 如果假阳性较多，建议提高直达阈值
    if (falsePositiveLogs.length > this.stats.directHits * 0.1) {
      const avgFalsePositiveConfidence = falsePositiveLogs.reduce((sum, l) => sum + l.confidence, 0) / falsePositiveLogs.length;
      suggestedThresholdAdjustment.direct = Math.min(0.95, avgFalsePositiveConfidence + 0.05);
    }

    // 如果假阴性较多，建议降低增强阈值
    if (falseNegativeLogs.length > this.stats.explorationCount * 0.1) {
      const avgFalseNegativeConfidence = falseNegativeLogs.reduce((sum, l) => sum + l.confidence, 0) / falseNegativeLogs.length;
      suggestedThresholdAdjustment.enhanced = Math.max(0.4, avgFalseNegativeConfidence - 0.05);
    }

    return {
      falsePositivePatterns,
      falseNegativePatterns,
      suggestedThresholdAdjustment,
    };
  }

  /**
   * 重置统计
   */
  resetStats(): void {
    this.stats = this.createEmptyStats();
    this.totalResponseTime = 0;
    this.totalRetryCount = 0;
    this.totalConfidence = 0;
    logger.info('FastPathMetrics stats reset');
  }

  /**
   * 清除所有数据
   */
  clearAll(): void {
    this.resetStats();
    this.decisionLogs = [];
    this.feedbackRecords = [];
    logger.info('FastPathMetrics all data cleared');
  }

  /**
   * 创建空统计对象
   */
  private createEmptyStats(): FastPathStats {
    return {
      totalQueries: 0,
      directHits: 0,
      enhancedHits: 0,
      explorationCount: 0,
      explicitNotificationCount: 0,
      avgResponseTime: 0,
      avgRetryCount: 0,
      falsePositives: 0,
      falseNegatives: 0,
      knowledgeGaps: 0,
    };
  }

  /**
   * 加载数据
   */
  private async loadData(): Promise<void> {
    try {
      // 加载统计
      const statsPath = path.join(this.config.dataDir, STATS_FILE);
      try {
        const statsData = await fs.readFile(statsPath, 'utf-8');
        const loaded = JSON.parse(statsData);
        this.stats = { ...this.createEmptyStats(), ...loaded.stats };
        this.totalResponseTime = loaded.totalResponseTime || 0;
        this.totalRetryCount = loaded.totalRetryCount || 0;
        this.totalConfidence = loaded.totalConfidence || 0;
      } catch {
        // 文件不存在，使用默认值
      }

      // 加载决策日志
      const logsPath = path.join(this.config.dataDir, DECISION_LOGS_FILE);
      try {
        const logsData = await fs.readFile(logsPath, 'utf-8');
        this.decisionLogs = JSON.parse(logsData);
      } catch {
        // 文件不存在，使用空数组
      }

      // 加载反馈记录
      const feedbackPath = path.join(this.config.dataDir, FEEDBACK_FILE);
      try {
        const feedbackData = await fs.readFile(feedbackPath, 'utf-8');
        this.feedbackRecords = JSON.parse(feedbackData);
      } catch {
        // 文件不存在，使用空数组
      }
    } catch (error) {
      logger.error('Failed to load FastPathMetrics data', { error });
    }
  }

  /**
   * 保存数据
   */
  async saveData(): Promise<void> {
    if (!this.config.enablePersistence) {
      return;
    }

    try {
      // 保存统计
      const statsPath = path.join(this.config.dataDir, STATS_FILE);
      await fs.writeFile(statsPath, JSON.stringify({
        stats: this.stats,
        totalResponseTime: this.totalResponseTime,
        totalRetryCount: this.totalRetryCount,
        totalConfidence: this.totalConfidence,
        savedAt: Date.now(),
      }, null, 2));

      // 保存决策日志
      const logsPath = path.join(this.config.dataDir, DECISION_LOGS_FILE);
      await fs.writeFile(logsPath, JSON.stringify(this.decisionLogs, null, 2));

      // 保存反馈记录
      const feedbackPath = path.join(this.config.dataDir, FEEDBACK_FILE);
      await fs.writeFile(feedbackPath, JSON.stringify(this.feedbackRecords, null, 2));

      logger.debug('FastPathMetrics data saved');
    } catch (error) {
      logger.error('Failed to save FastPathMetrics data', { error });
    }
  }

  /**
   * 启动自动保存
   */
  private startAutoSave(): void {
    if (this.autoSaveTimer) {
      clearInterval(this.autoSaveTimer);
    }

    this.autoSaveTimer = setInterval(() => {
      this.saveData().catch(error => {
        logger.error('Auto-save failed', { error });
      });
    }, this.config.autoSaveIntervalMs);
  }

  /**
   * 停止自动保存
   */
  stopAutoSave(): void {
    if (this.autoSaveTimer) {
      clearInterval(this.autoSaveTimer);
      this.autoSaveTimer = null;
    }
  }

  /**
   * 销毁
   */
  async destroy(): Promise<void> {
    this.stopAutoSave();
    if (this.config.enablePersistence) {
      await this.saveData();
    }
    logger.info('FastPathMetrics destroyed');
  }
}

/**
 * 创建 FastPathMetrics 实例的工厂函数
 */
export function createFastPathMetrics(
  config?: Partial<FastPathMetricsConfig>
): FastPathMetrics {
  return new FastPathMetrics(config);
}

// 导出单例实例
export const fastPathMetrics = new FastPathMetrics();
