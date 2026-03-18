/**
 * ContinuousLearner 持续学习协调器
 * 管理模式学习、策略评估和知识图谱更新的定时任务
 *
 * Requirements: 5.1, 5.4, 5.5, 5.6
 * - 5.1: 在 ReAct 执行完成后记录用户操作序列，调用 identifyPatterns() 识别重复操作模式
 * - 5.4: 启动定时任务评估当前策略的有效性指标（成功率、平均耗时变化趋势）
 * - 5.5: 启动定时任务执行 discoverTopology() 进行知识图谱增量更新
 * - 5.6: 未启用时停止所有学习相关的定时任务，recordOperation() 不执行
 */

import { patternLearner, UserOperation } from './patternLearner';
import { knowledgeGraphBuilder } from './knowledgeGraphBuilder';
import {
  isCapabilityEnabled,
  getCapabilityConfig,
  ContinuousLearningConfig,
} from './evolutionConfig';
import { logger } from '../../utils/logger';

// ==================== 持续学习协调器 ====================

export class ContinuousLearner {
  private patternLearningTimer: NodeJS.Timeout | null = null;
  private strategyEvalTimer: NodeJS.Timeout | null = null;
  private knowledgeGraphTimer: NodeJS.Timeout | null = null;
  private currentConfig: ContinuousLearningConfig | null = null;

  /**
   * 启动所有定时任务
   * @param config 持续学习配置
   */
  start(config: ContinuousLearningConfig): void {
    // 先停止已有的定时任务
    this.stop();
    this.currentConfig = config;

    logger.info('ContinuousLearner starting with config', {
      patternLearningEnabled: config.patternLearningEnabled,
      strategyEvaluationIntervalDays: config.strategyEvaluationIntervalDays,
      knowledgeGraphUpdateIntervalHours: config.knowledgeGraphUpdateIntervalHours,
    });

    // 1. 模式学习定时器 - 定期调用 patternLearner.identifyPatterns()
    if (config.patternLearningEnabled) {
      // 使用 patternLearningDelayDays 作为检查间隔（每天检查一次）
      const patternIntervalMs = 24 * 60 * 60 * 1000; // 每天一次
      this.patternLearningTimer = setInterval(async () => {
        try {
          logger.debug('ContinuousLearner: Running pattern learning cycle');
          // triggerLearnPatterns 会调用 identifyPatterns 并将结果（含 verified 标记）存储到 patterns Map
          const allPatterns = patternLearner.getAllPatterns();
          for (const [userId] of allPatterns) {
            patternLearner.triggerLearnPatterns(userId);
          }
          // 检查最佳实践提升
          await this.checkBestPracticePromotion(config.bestPracticeThreshold);
        } catch (error) {
          logger.error('ContinuousLearner: Pattern learning cycle failed', error);
        }
      }, patternIntervalMs);
      logger.debug('ContinuousLearner: Pattern learning timer started (interval: 24h)');
    }

    // 2. 策略评估定时器
    const strategyIntervalMs = config.strategyEvaluationIntervalDays * 24 * 60 * 60 * 1000;
    if (strategyIntervalMs > 0) {
      this.strategyEvalTimer = setInterval(async () => {
        try {
          await this.evaluateStrategies();
        } catch (error) {
          logger.error('ContinuousLearner: Strategy evaluation failed', error);
        }
      }, strategyIntervalMs);
      logger.debug('ContinuousLearner: Strategy evaluation timer started', {
        intervalDays: config.strategyEvaluationIntervalDays,
      });
    }

    // 3. 知识图谱更新定时器
    const kgIntervalMs = config.knowledgeGraphUpdateIntervalHours * 60 * 60 * 1000;
    if (kgIntervalMs > 0) {
      this.knowledgeGraphTimer = setInterval(async () => {
        try {
          await this.updateKnowledgeGraph();
        } catch (error) {
          logger.error('ContinuousLearner: Knowledge graph update failed', error);
        }
      }, kgIntervalMs);
      logger.debug('ContinuousLearner: Knowledge graph update timer started', {
        intervalHours: config.knowledgeGraphUpdateIntervalHours,
      });
    }

    logger.info('ContinuousLearner started successfully');
  }

  /**
   * 停止所有定时任务
   */
  stop(): void {
    if (this.patternLearningTimer) {
      clearInterval(this.patternLearningTimer);
      this.patternLearningTimer = null;
      logger.debug('ContinuousLearner: Pattern learning timer stopped');
    }

    if (this.strategyEvalTimer) {
      clearInterval(this.strategyEvalTimer);
      this.strategyEvalTimer = null;
      logger.debug('ContinuousLearner: Strategy evaluation timer stopped');
    }

    if (this.knowledgeGraphTimer) {
      clearInterval(this.knowledgeGraphTimer);
      this.knowledgeGraphTimer = null;
      logger.debug('ContinuousLearner: Knowledge graph update timer stopped');
    }

    logger.info('ContinuousLearner stopped all timers');
  }

  /**
   * 记录用户操作 - 委托给 patternLearner
   * 当 continuousLearning 未启用或 patternLearningEnabled 为 false 时不执行
   * @param userId 用户 ID
   * @param operation 用户操作（不含 id）
   */
  recordOperation(userId: string, operation: Omit<UserOperation, 'id'>): void {
    try {
      if (!isCapabilityEnabled('continuousLearning')) {
        return;
      }

      const config = getCapabilityConfig('continuousLearning');
      if (!config.patternLearningEnabled) {
        return;
      }

      patternLearner.recordOperation(operation);
      logger.debug('ContinuousLearner: Operation recorded', {
        userId,
        toolName: operation.toolName,
      });
    } catch (error) {
      logger.warn('ContinuousLearner: Failed to record operation', error);
    }
  }

  /**
   * 评估策略有效性
   * 分析当前操作模式的成功率和平均耗时变化趋势
   */
  private async evaluateStrategies(): Promise<void> {
    logger.info('ContinuousLearner: Evaluating strategies');

    try {
      const stats = patternLearner.getStats();
      const allPatterns = patternLearner.getAllPatterns();

      let totalPatterns = 0;
      let highConfidencePatterns = 0;
      let totalSuccessRate = 0;

      for (const [, patterns] of allPatterns) {
        for (const pattern of patterns) {
          totalPatterns++;
          totalSuccessRate += pattern.successRate;
          if (pattern.confidence >= 0.8) {
            highConfidencePatterns++;
          }
        }
      }

      const avgSuccessRate = totalPatterns > 0 ? totalSuccessRate / totalPatterns : 0;

      logger.info('ContinuousLearner: Strategy evaluation complete', {
        totalUsers: stats.totalUsers,
        totalOperations: stats.totalOperations,
        totalPatterns,
        highConfidencePatterns,
        avgSuccessRate: avgSuccessRate.toFixed(2),
      });
    } catch (error) {
      logger.error('ContinuousLearner: Strategy evaluation error', error);
    }
  }

  /**
   * 触发知识图谱更新
   * 调用 knowledgeGraphBuilder.discoverTopology() 进行增量更新
   */
  private async updateKnowledgeGraph(): Promise<void> {
    logger.info('ContinuousLearner: Updating knowledge graph');

    try {
      const topology = await knowledgeGraphBuilder.discoverTopology();
      logger.info('ContinuousLearner: Knowledge graph updated', {
        nodeCount: topology.nodes.length,
        edgeCount: topology.edges.length,
      });
    } catch (error) {
      logger.error('ContinuousLearner: Knowledge graph update error', error);
    }
  }

  /**
   * 检查并提升最佳实践
   * 当操作模式的正面反馈次数达到阈值时，将其提取为最佳实践
   * @param threshold 最佳实践提取阈值（正面反馈次数）
   */
  private async checkBestPracticePromotion(threshold: number): Promise<void> {
    logger.debug('ContinuousLearner: Checking best practice promotion', { threshold });

    try {
      const allPatterns = patternLearner.getAllPatterns();

      for (const [userId, patterns] of allPatterns) {
        for (const pattern of patterns) {
          // 使用 frequency 作为正面反馈的代理指标
          // 高频率 + 高成功率的模式视为候选最佳实践
          if (pattern.frequency >= threshold && pattern.successRate >= 0.8) {
            logger.info('ContinuousLearner: Pattern eligible for best practice promotion', {
              patternId: pattern.id,
              userId,
              frequency: pattern.frequency,
              successRate: pattern.successRate,
              sequence: pattern.sequence,
            });
            // 调用 patternLearner.promoteToBestPractice 将模式提取为最佳实践
            await patternLearner.promoteToBestPractice(pattern.id);
          }
        }
      }
    } catch (error) {
      logger.error('ContinuousLearner: Best practice promotion check failed', error);
    }
  }

  /**
   * 动态更新配置
   * 停止当前定时任务并使用新配置重新启动
   * @param config 新的持续学习配置
   */
  updateConfig(config: ContinuousLearningConfig): void {
    logger.info('ContinuousLearner: Updating config', {
      enabled: config.enabled,
      patternLearningEnabled: config.patternLearningEnabled,
    });

    if (config.enabled) {
      this.start(config);
    } else {
      this.stop();
    }
  }

  /**
   * 清理资源，停止所有定时任务
   */
  shutdown(): void {
    logger.info('ContinuousLearner: Shutting down');
    this.stop();
    this.currentConfig = null;
    logger.info('ContinuousLearner: Shutdown complete');
  }

  /**
   * 获取当前配置（用于测试和调试）
   */
  getCurrentConfig(): ContinuousLearningConfig | null {
    return this.currentConfig;
  }

  /**
   * 检查定时器是否在运行（用于测试和调试）
   */
  isRunning(): {
    patternLearning: boolean;
    strategyEval: boolean;
    knowledgeGraph: boolean;
  } {
    return {
      patternLearning: this.patternLearningTimer !== null,
      strategyEval: this.strategyEvalTimer !== null,
      knowledgeGraph: this.knowledgeGraphTimer !== null,
    };
  }
}

// 导出单例
export const continuousLearner = new ContinuousLearner();
