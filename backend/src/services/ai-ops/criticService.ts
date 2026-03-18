/**
 * CriticService 评估服务
 * 负责评估执行结果，分析失败原因，生成改进建议
 *
 * Requirements: 1.1-4.6, 20.1
 * - 1.1-1.7: 多维度评估执行结果
 * - 2.1-2.4: 生成评估报告
 * - 3.1-3.9: 失败分类
 * - 4.1-4.6: 改进建议生成
 * - 20.1: 数据持久化
 */

import fs from 'fs/promises';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import {
  RemediationStep,
  ExecutionResult,
  EvaluationDimensions,
  FailureCategory,
  ImprovementSuggestion,
  StepEvaluation,
  EvaluationReport,
  EvaluationContext,
  CriticStats,
  ICriticService,
  SystemMetrics,
} from '../../types/ai-ops';
import { logger } from '../../utils/logger';
import { aiAnalyzer } from './aiAnalyzer';
import { auditLogger } from './auditLogger';
import type { DataStore } from '../dataStore';

const DATA_DIR = path.join(process.cwd(), 'data', 'ai-ops');
const CRITIC_DIR = path.join(DATA_DIR, 'critic');
const EVALUATIONS_DIR = path.join(CRITIC_DIR, 'evaluations');

/**
 * 获取日期字符串 (YYYY-MM-DD)
 */
function getDateString(timestamp: number): string {
  const date = new Date(timestamp);
  return date.toISOString().split('T')[0];
}

/**
 * 评估维度权重配置
 * Requirements: 1.7 - 加权评分
 */
const DIMENSION_WEIGHTS: Record<keyof EvaluationDimensions, number> = {
  symptomElimination: 0.30,
  metricRecovery: 0.25,
  sideEffects: 0.20,
  executionQuality: 0.15,
  timeEfficiency: 0.10,
};

/**
 * 失败类型到改进建议的映射
 * Requirements: 4.2-4.5
 */
const FAILURE_TO_SUGGESTIONS: Record<FailureCategory, ImprovementSuggestion[]> = {
  execution_error: ['retry', 'alternative', 'learn'],
  verification_failed: ['retry', 'alternative', 'learn'],
  wrong_diagnosis: ['alternative', 'escalate', 'learn'],
  insufficient_action: ['alternative', 'retry', 'learn'],
  side_effect: ['rollback', 'alternative', 'learn'],
  timeout: ['retry', 'escalate', 'learn'],
  external_factor: ['retry', 'escalate', 'learn'],
};

export class CriticService implements ICriticService {
  private initialized = false;
  private evaluationsCache: Map<string, EvaluationReport> = new Map();
  private planToReportMap: Map<string, string> = new Map(); // planId -> reportId

  // 缓存清理定时器
  private cacheCleanupTimer: NodeJS.Timeout | null = null;

  // 最大缓存条目数
  private readonly MAX_CACHE_SIZE = 200;

  // 缓存 TTL（24 小时）
  private readonly CACHE_TTL_MS = 24 * 60 * 60 * 1000;

  // PostgreSQL DataStore (Requirements: C3.12)
  private pgDataStore: DataStore | null = null;

  /** Check if PostgreSQL DataStore is available */
  private get usePg(): boolean {
    return this.pgDataStore !== null;
  }

  /**
   * 设置 PostgreSQL DataStore 实例
   * Requirements: C3.12 - 统一迁移至 PostgreSQL
   */
  setDataStore(ds: DataStore): void {
    this.pgDataStore = ds;
    logger.info('CriticService: PgDataStore configured, PostgreSQL persistence enabled');
  }

  /**
   * 确保数据目录存在
   */
  private async ensureDataDirs(): Promise<void> {
    try {
      await fs.mkdir(EVALUATIONS_DIR, { recursive: true });
    } catch (error) {
      logger.error('Failed to create critic directories:', error);
    }
  }

  /**
   * 初始化服务
   * Requirements: 20.1, 20.4
   */
  async initialize(): Promise<void> {
    if (this.initialized) return;
    await this.ensureDataDirs();
    await this.loadRecentEvaluations();

    // 启动缓存清理定时器
    this.startCacheCleanupTimer();

    this.initialized = true;
    logger.info('CriticService initialized');
  }

  /**
   * 启动缓存清理定时器
   */
  private startCacheCleanupTimer(): void {
    if (this.cacheCleanupTimer) {
      clearInterval(this.cacheCleanupTimer);
    }

    // 每 30 分钟清理一次过期缓存
    const CLEANUP_INTERVAL_MS = 30 * 60 * 1000;
    this.cacheCleanupTimer = setInterval(() => {
      this.cleanupExpiredCache();
    }, CLEANUP_INTERVAL_MS);

    logger.debug('CriticService cache cleanup timer started');
  }

  /**
   * 停止缓存清理定时器
   */
  stopCleanupTimer(): void {
    if (this.cacheCleanupTimer) {
      clearInterval(this.cacheCleanupTimer);
      this.cacheCleanupTimer = null;
      logger.debug('CriticService cache cleanup timer stopped');
    }
  }

  /**
   * 清理过期缓存
   */
  private cleanupExpiredCache(): void {
    const now = Date.now();
    let cleanedCount = 0;

    for (const [id, report] of this.evaluationsCache) {
      if (now - report.timestamp > this.CACHE_TTL_MS) {
        this.evaluationsCache.delete(id);
        // 同时清理 planToReportMap
        for (const [planId, reportId] of this.planToReportMap) {
          if (reportId === id) {
            this.planToReportMap.delete(planId);
          }
        }
        cleanedCount++;
      }
    }

    // 如果缓存仍然过大，删除最旧的条目
    if (this.evaluationsCache.size > this.MAX_CACHE_SIZE) {
      const entries = Array.from(this.evaluationsCache.entries())
        .sort((a, b) => a[1].timestamp - b[1].timestamp);

      const toRemove = entries.slice(0, this.evaluationsCache.size - this.MAX_CACHE_SIZE);
      for (const [id] of toRemove) {
        this.evaluationsCache.delete(id);
        for (const [planId, reportId] of this.planToReportMap) {
          if (reportId === id) {
            this.planToReportMap.delete(planId);
          }
        }
        cleanedCount++;
      }
    }

    if (cleanedCount > 0) {
      logger.info(`CriticService cleaned up ${cleanedCount} expired cache entries`);
    }
  }

  /**
   * 加载最近的评估报告
   */
  private async loadRecentEvaluations(): Promise<void> {
    // PostgreSQL path
    if (this.usePg) {
      try {
        const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
        const rows = await this.pgDataStore!.query<{
          id: string;
          plan_id: string;
          data: string;
        }>('SELECT id, plan_id, data FROM evaluation_reports WHERE timestamp >= $1 ORDER BY timestamp DESC', [sevenDaysAgo]);

        for (const row of rows) {
          const report: EvaluationReport = typeof row.data === 'string' ? JSON.parse(row.data) : row.data;
          this.evaluationsCache.set(report.id, report);
          this.planToReportMap.set(report.planId, report.id);
        }
        logger.info(`Loaded ${this.evaluationsCache.size} evaluation reports from PostgreSQL`);
        return;
      } catch (error) {
        logger.warn('Failed to load evaluations from PostgreSQL, falling back to file:', error);
      }
    }

    // File-based fallback
    try {
      const files = await fs.readdir(EVALUATIONS_DIR);
      // 只加载最近 7 天的数据
      const recentFiles = files
        .filter(f => f.endsWith('.json'))
        .sort()
        .slice(-7);

      for (const file of recentFiles) {
        try {
          const content = await fs.readFile(path.join(EVALUATIONS_DIR, file), 'utf-8');
          const reports = JSON.parse(content) as EvaluationReport[];
          for (const report of reports) {
            this.evaluationsCache.set(report.id, report);
            this.planToReportMap.set(report.planId, report.id);
          }
        } catch (error) {
          logger.warn(`Failed to load evaluation file ${file}:`, error);
        }
      }
      logger.info(`Loaded ${this.evaluationsCache.size} evaluation reports`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        logger.error('Failed to load evaluations:', error);
      }
    }
  }


  /**
   * 保存评估报告到磁盘
   * Requirements: 2.4, 20.1
   */
  private async saveReport(report: EvaluationReport): Promise<void> {
    // Update in-memory cache first
    this.evaluationsCache.set(report.id, report);
    this.planToReportMap.set(report.planId, report.id);

    // PostgreSQL path
    if (this.usePg) {
      try {
        await this.pgDataStore!.execute(
          `INSERT INTO evaluation_reports (id, plan_id, alert_id, timestamp, overall_success, overall_score, failure_category, data)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
           ON CONFLICT (id) DO UPDATE SET
             overall_success = EXCLUDED.overall_success, overall_score = EXCLUDED.overall_score,
             failure_category = EXCLUDED.failure_category, data = EXCLUDED.data`,
          [
            report.id,
            report.planId,
            report.alertId,
            report.timestamp,
            report.overallSuccess,
            report.overallScore,
            report.failureCategory || null,
            JSON.stringify(report),
          ]
        );
        logger.debug(`Evaluation report saved to PostgreSQL: ${report.id}`);
        return;
      } catch (error) {
        logger.warn('Failed to save evaluation report to PostgreSQL, falling back to file:', error);
      }
    }

    // File-based fallback
    await this.ensureDataDirs();
    const dateStr = getDateString(report.timestamp);
    const filePath = path.join(EVALUATIONS_DIR, `${dateStr}.json`);

    let reports: EvaluationReport[] = [];
    try {
      const content = await fs.readFile(filePath, 'utf-8');
      reports = JSON.parse(content);
    } catch {
      // 文件不存在，从空数组开始
    }

    const existingIndex = reports.findIndex(r => r.id === report.id);
    if (existingIndex >= 0) {
      reports[existingIndex] = report;
    } else {
      reports.push(report);
    }

    await fs.writeFile(filePath, JSON.stringify(reports, null, 2), 'utf-8');
  }

  /**
   * 评估单步执行结果
   * Requirements: 1.1-1.7
   */
  async evaluateStep(
    step: RemediationStep,
    result: ExecutionResult,
    context: EvaluationContext
  ): Promise<StepEvaluation> {
    await this.initialize();

    // 计算各维度评分
    const dimensions = await this.calculateDimensions(step, result, context);

    // 计算加权总分
    const qualityScore = this.calculateQualityScore(dimensions);

    // 判断是否成功
    const success = result.success && (result.verificationPassed !== false) && qualityScore >= 60;

    // 如果失败，分析失败原因
    let failureCategory: FailureCategory | undefined;
    let failureDetails: string | undefined;

    if (!success) {
      const failureAnalysis = await this.analyzeFailure(result, context);
      failureCategory = failureAnalysis.category;
      failureDetails = failureAnalysis.details;
    }

    const evaluation: StepEvaluation = {
      stepOrder: step.order,
      dimensions,
      qualityScore,
      success,
      failureCategory,
      failureDetails,
      confidence: this.calculateConfidence(result, context),
    };

    // 记录审计日志
    await auditLogger.log({
      action: 'remediation_execute',
      actor: 'system',
      details: {
        trigger: 'critic_evaluate',
        metadata: {
          stepOrder: step.order,
          qualityScore,
          success,
          failureCategory,
        },
      },
    });

    return evaluation;
  }

  /**
   * 计算评估维度
   * Requirements: 1.1-1.6
   */
  private async calculateDimensions(
    step: RemediationStep,
    result: ExecutionResult,
    context: EvaluationContext
  ): Promise<EvaluationDimensions> {
    // 1.1 症状消除评估 - 比较系统状态
    const symptomElimination = this.evaluateSymptomElimination(context);

    // 1.2 指标恢复评估 - 检查指标阈值
    const metricRecovery = this.evaluateMetricRecovery(context);

    // 1.3 副作用检测 - 检测意外变更
    const sideEffects = this.evaluateSideEffects(context);

    // 1.4 执行质量评估 - 命令执行质量
    const executionQuality = this.evaluateExecutionQuality(result);

    // 1.5 时间效率评估 - 时间效率
    const timeEfficiency = this.evaluateTimeEfficiency(step, result);

    return {
      symptomElimination,
      metricRecovery,
      sideEffects,
      executionQuality,
      timeEfficiency,
    };
  }

  /**
   * 症状消除评估
   * Requirements: 1.1
   */
  private evaluateSymptomElimination(context: EvaluationContext): number {
    const { preExecutionState, postExecutionState, alertEvent } = context;

    // 如果没有告警事件，返回默认分数
    if (!alertEvent) {
      return 50;
    }

    // 根据告警类型评估症状是否消除
    const category = alertEvent.category.toLowerCase();

    if (category.includes('cpu')) {
      const preCpu = preExecutionState.cpu.usage;
      const postCpu = postExecutionState.cpu.usage;
      // CPU 使用率下降越多，分数越高
      if (postCpu < preCpu) {
        const improvement = ((preCpu - postCpu) / preCpu) * 100;
        return Math.min(100, 50 + improvement);
      }
      return postCpu < 80 ? 60 : 30;
    }

    if (category.includes('memory')) {
      const preMem = preExecutionState.memory.usage;
      const postMem = postExecutionState.memory.usage;
      if (postMem < preMem) {
        const improvement = ((preMem - postMem) / preMem) * 100;
        return Math.min(100, 50 + improvement);
      }
      return postMem < 85 ? 60 : 30;
    }

    if (category.includes('disk')) {
      const preDisk = preExecutionState.disk.usage;
      const postDisk = postExecutionState.disk.usage;
      if (postDisk < preDisk) {
        const improvement = ((preDisk - postDisk) / preDisk) * 100;
        return Math.min(100, 50 + improvement);
      }
      return postDisk < 90 ? 60 : 30;
    }

    // 默认评估：如果执行后状态整体改善
    return this.compareOverallState(preExecutionState, postExecutionState);
  }

  /**
   * 比较整体系统状态
   */
  private compareOverallState(pre: SystemMetrics, post: SystemMetrics): number {
    let score = 50; // 基础分

    // CPU 改善
    if (post.cpu.usage < pre.cpu.usage) score += 15;
    else if (post.cpu.usage > pre.cpu.usage + 10) score -= 10;

    // 内存改善
    if (post.memory.usage < pre.memory.usage) score += 15;
    else if (post.memory.usage > pre.memory.usage + 10) score -= 10;

    // 磁盘改善
    if (post.disk.usage < pre.disk.usage) score += 10;
    else if (post.disk.usage > pre.disk.usage + 5) score -= 5;

    return Math.max(0, Math.min(100, score));
  }

  /**
   * 指标恢复评估
   * Requirements: 1.2
   */
  private evaluateMetricRecovery(context: EvaluationContext): number {
    const { postExecutionState } = context;

    let score = 0;
    let factors = 0;

    // CPU 恢复评估
    if (postExecutionState.cpu.usage < 70) score += 100;
    else if (postExecutionState.cpu.usage < 85) score += 70;
    else if (postExecutionState.cpu.usage < 95) score += 40;
    else score += 10;
    factors++;

    // 内存恢复评估
    if (postExecutionState.memory.usage < 75) score += 100;
    else if (postExecutionState.memory.usage < 85) score += 70;
    else if (postExecutionState.memory.usage < 95) score += 40;
    else score += 10;
    factors++;

    // 磁盘恢复评估
    if (postExecutionState.disk.usage < 80) score += 100;
    else if (postExecutionState.disk.usage < 90) score += 70;
    else if (postExecutionState.disk.usage < 95) score += 40;
    else score += 10;
    factors++;

    return Math.round(score / factors);
  }

  /**
   * 副作用检测
   * Requirements: 1.3
   */
  private evaluateSideEffects(context: EvaluationContext): number {
    const { preExecutionState, postExecutionState } = context;

    let score = 100; // 满分表示无副作用

    // 检查 CPU 是否异常升高
    if (postExecutionState.cpu.usage > preExecutionState.cpu.usage + 20) {
      score -= 30;
    }

    // 检查内存是否异常升高
    if (postExecutionState.memory.usage > preExecutionState.memory.usage + 15) {
      score -= 30;
    }

    // 检查磁盘是否异常升高
    if (postExecutionState.disk.usage > preExecutionState.disk.usage + 10) {
      score -= 20;
    }

    // 检查系统运行时间是否重置（可能发生了重启）
    if (postExecutionState.uptime < preExecutionState.uptime) {
      score -= 20; // 意外重启是副作用
    }

    return Math.max(0, score);
  }

  /**
   * 执行质量评估
   * Requirements: 1.4
   */
  private evaluateExecutionQuality(result: ExecutionResult): number {
    let score = 0;

    // 执行成功
    if (result.success) {
      score += 50;
    }

    // 验证通过
    if (result.verificationPassed === true) {
      score += 30;
    } else if (result.verificationPassed === undefined) {
      score += 15; // 未验证，给予部分分数
    }

    // 无错误输出
    if (!result.error) {
      score += 20;
    } else if (result.error.toLowerCase().includes('warning')) {
      score += 10; // 只是警告
    }

    return score;
  }

  /**
   * 时间效率评估
   * Requirements: 1.5
   */
  private evaluateTimeEfficiency(step: RemediationStep, result: ExecutionResult): number {
    const expectedDuration = step.estimatedDuration * 1000; // 转换为毫秒
    const actualDuration = result.duration;

    if (actualDuration <= expectedDuration) {
      return 100; // 在预期时间内完成
    }

    const ratio = actualDuration / expectedDuration;

    if (ratio <= 1.5) return 80;
    if (ratio <= 2.0) return 60;
    if (ratio <= 3.0) return 40;
    if (ratio <= 5.0) return 20;

    return 10; // 严重超时
  }


  /**
   * 计算加权质量分数
   * Requirements: 1.7
   */
  calculateQualityScore(dimensions: EvaluationDimensions): number {
    let score = 0;

    score += dimensions.symptomElimination * DIMENSION_WEIGHTS.symptomElimination;
    score += dimensions.metricRecovery * DIMENSION_WEIGHTS.metricRecovery;
    score += dimensions.sideEffects * DIMENSION_WEIGHTS.sideEffects;
    score += dimensions.executionQuality * DIMENSION_WEIGHTS.executionQuality;
    score += dimensions.timeEfficiency * DIMENSION_WEIGHTS.timeEfficiency;

    // 确保分数在 0-100 范围内
    return Math.max(0, Math.min(100, Math.round(score)));
  }

  /**
   * 计算置信度
   */
  private calculateConfidence(result: ExecutionResult, context: EvaluationContext): number {
    let confidence = 0.5; // 基础置信度

    // 有验证结果增加置信度
    if (result.verificationPassed !== undefined) {
      confidence += 0.2;
    }

    // 有历史失败数据增加置信度
    if (context.historicalFailures && context.historicalFailures.length > 0) {
      confidence += 0.1;
    }

    // 有根因分析增加置信度
    if (context.rootCauseAnalysis) {
      confidence += 0.2;
    }

    return Math.min(1, confidence);
  }

  /**
   * 评估整体修复方案
   * Requirements: 2.1-2.4
   */
  async evaluatePlan(
    plan: { id: string; alertId: string; steps: RemediationStep[] },
    results: ExecutionResult[],
    context: EvaluationContext
  ): Promise<EvaluationReport> {
    await this.initialize();

    const reportId = uuidv4();
    const now = Date.now();

    // 评估每个步骤
    const stepEvaluations: StepEvaluation[] = [];
    for (let i = 0; i < plan.steps.length && i < results.length; i++) {
      const evaluation = await this.evaluateStep(plan.steps[i], results[i], context);
      stepEvaluations.push(evaluation);
    }

    // 计算整体成功和分数
    const overallSuccess = stepEvaluations.every(e => e.success);
    const overallScore = stepEvaluations.length > 0
      ? Math.round(stepEvaluations.reduce((sum, e) => sum + e.qualityScore, 0) / stepEvaluations.length)
      : 0;

    // 评估根因是否解决
    const rootCauseAddressed = this.evaluateRootCauseAddressed(context, stepEvaluations);

    // 识别残留问题
    const residualIssues = this.identifyResidualIssues(context, stepEvaluations);

    // 确定整体失败类型
    const failureCategory = !overallSuccess
      ? this.determineOverallFailureCategory(stepEvaluations)
      : undefined;

    // 生成改进建议
    const report: EvaluationReport = {
      id: reportId,
      planId: plan.id,
      alertId: plan.alertId,
      timestamp: now,
      overallSuccess,
      overallScore,
      stepEvaluations,
      rootCauseAddressed,
      residualIssues,
      failureCategory,
      improvementSuggestions: [], // 先创建空数组，后面填充
    };

    // 生成改进建议
    report.improvementSuggestions = this.generateSuggestions(report);

    // 尝试获取 AI 分析
    try {
      const aiAnalysis = await this.getAIAnalysis(report, context);
      report.aiAnalysis = aiAnalysis;
    } catch (error) {
      logger.warn('AI analysis failed, using rule-based evaluation:', error);
    }

    // 保存报告
    await this.saveReport(report);

    // 记录审计日志
    await auditLogger.log({
      action: 'remediation_execute',
      actor: 'system',
      details: {
        trigger: 'critic_evaluate',
        metadata: {
          reportId,
          planId: plan.id,
          overallSuccess,
          overallScore,
          failureCategory,
        },
      },
    });

    logger.info(`Evaluation report generated: ${reportId}, success: ${overallSuccess}, score: ${overallScore}`);
    return report;
  }

  /**
   * 评估根因是否解决
   * Requirements: 2.3
   */
  private evaluateRootCauseAddressed(
    context: EvaluationContext,
    stepEvaluations: StepEvaluation[]
  ): boolean {
    // 如果所有步骤都成功且症状消除评分高，认为根因已解决
    const allSuccess = stepEvaluations.every(e => e.success);
    const avgSymptomElimination = stepEvaluations.length > 0
      ? stepEvaluations.reduce((sum, e) => sum + e.dimensions.symptomElimination, 0) / stepEvaluations.length
      : 0;

    // 检查执行后状态是否正常
    const { postExecutionState } = context;
    const stateNormal =
      postExecutionState.cpu.usage < 80 &&
      postExecutionState.memory.usage < 85 &&
      postExecutionState.disk.usage < 90;

    return allSuccess && avgSymptomElimination >= 70 && stateNormal;
  }

  /**
   * 识别残留问题
   * Requirements: 2.3
   */
  private identifyResidualIssues(
    context: EvaluationContext,
    stepEvaluations: StepEvaluation[]
  ): string[] {
    const issues: string[] = [];
    const { postExecutionState } = context;

    // 检查系统状态
    if (postExecutionState.cpu.usage >= 80) {
      issues.push(`CPU 使用率仍然较高 (${postExecutionState.cpu.usage.toFixed(1)}%)`);
    }

    if (postExecutionState.memory.usage >= 85) {
      issues.push(`内存使用率仍然较高 (${postExecutionState.memory.usage.toFixed(1)}%)`);
    }

    if (postExecutionState.disk.usage >= 90) {
      issues.push(`磁盘使用率仍然较高 (${postExecutionState.disk.usage.toFixed(1)}%)`);
    }

    // 检查失败的步骤
    const failedSteps = stepEvaluations.filter(e => !e.success);
    for (const step of failedSteps) {
      if (step.failureDetails) {
        issues.push(`步骤 ${step.stepOrder} 失败: ${step.failureDetails}`);
      }
    }

    // 检查副作用
    const sideEffectSteps = stepEvaluations.filter(e => e.dimensions.sideEffects < 70);
    for (const step of sideEffectSteps) {
      issues.push(`步骤 ${step.stepOrder} 可能产生了副作用`);
    }

    return issues;
  }

  /**
   * 确定整体失败类型
   */
  private determineOverallFailureCategory(stepEvaluations: StepEvaluation[]): FailureCategory {
    // 统计各类失败
    const failureCounts: Record<FailureCategory, number> = {
      execution_error: 0,
      verification_failed: 0,
      wrong_diagnosis: 0,
      insufficient_action: 0,
      side_effect: 0,
      timeout: 0,
      external_factor: 0,
    };

    for (const step of stepEvaluations) {
      if (step.failureCategory) {
        failureCounts[step.failureCategory]++;
      }
    }

    // 返回最常见的失败类型
    let maxCategory: FailureCategory = 'execution_error';
    let maxCount = 0;

    for (const [category, count] of Object.entries(failureCounts)) {
      if (count > maxCount) {
        maxCount = count;
        maxCategory = category as FailureCategory;
      }
    }

    return maxCategory;
  }

  /**
   * 分析失败原因
   * Requirements: 3.1-3.9
   */
  async analyzeFailure(
    result: ExecutionResult,
    context: EvaluationContext
  ): Promise<{ category: FailureCategory; confidence: number; details: string }> {
    const error = result.error || '';
    const output = result.output || '';

    // 3.1 执行错误分类
    if (this.isExecutionError(error, output)) {
      return {
        category: 'execution_error',
        confidence: 0.9,
        details: this.extractErrorDetails(error, output, 'execution_error'),
      };
    }

    // 3.2 验证失败分类
    if (result.success && result.verificationPassed === false) {
      return {
        category: 'verification_failed',
        confidence: 0.85,
        details: '命令执行成功但验证未通过',
      };
    }

    // 3.6 超时分类
    if (this.isTimeout(error, result.duration)) {
      return {
        category: 'timeout',
        confidence: 0.95,
        details: `执行超时 (${result.duration}ms)`,
      };
    }

    // 3.5 副作用分类
    if (this.hasSideEffects(context)) {
      return {
        category: 'side_effect',
        confidence: 0.8,
        details: '执行后系统状态异常变化',
      };
    }

    // 3.4 行动不足分类
    if (result.success && !this.isSymptomResolved(context)) {
      return {
        category: 'insufficient_action',
        confidence: 0.75,
        details: '执行成功但症状未完全消除',
      };
    }

    // 3.7 外部因素分类
    if (this.isExternalFactor(error, output)) {
      return {
        category: 'external_factor',
        confidence: 0.7,
        details: this.extractErrorDetails(error, output, 'external_factor'),
      };
    }

    // 3.3 诊断错误分类 - 使用 AI 分析
    try {
      const aiResult = await this.analyzeFailureWithAI(result, context);
      if (aiResult) {
        return aiResult;
      }
    } catch (error) {
      logger.debug('AI failure analysis failed:', error);
    }

    // 默认返回执行错误
    return {
      category: 'execution_error',
      confidence: 0.5,
      details: error || '未知错误',
    };
  }

  /**
   * 检查是否为执行错误
   */
  private isExecutionError(error: string, output: string): boolean {
    const errorPatterns = [
      /syntax error/i,
      /command not found/i,
      /permission denied/i,
      /access denied/i,
      /connection refused/i,
      /connection reset/i,
      /invalid argument/i,
      /no such/i,
      /not found/i,
      /failed to/i,
    ];

    const combined = `${error} ${output}`;
    return errorPatterns.some(pattern => pattern.test(combined));
  }

  /**
   * 检查是否超时
   */
  private isTimeout(error: string, duration: number): boolean {
    if (/timeout|timed out/i.test(error)) {
      return true;
    }
    // 超过 60 秒认为是超时
    return duration > 60000;
  }

  /**
   * 检查是否有副作用
   */
  private hasSideEffects(context: EvaluationContext): boolean {
    const { preExecutionState, postExecutionState } = context;

    // CPU 异常升高
    if (postExecutionState.cpu.usage > preExecutionState.cpu.usage + 25) {
      return true;
    }

    // 内存异常升高
    if (postExecutionState.memory.usage > preExecutionState.memory.usage + 20) {
      return true;
    }

    // 系统重启
    if (postExecutionState.uptime < preExecutionState.uptime) {
      return true;
    }

    return false;
  }

  /**
   * 检查症状是否解决
   */
  private isSymptomResolved(context: EvaluationContext): boolean {
    const { postExecutionState } = context;

    return (
      postExecutionState.cpu.usage < 80 &&
      postExecutionState.memory.usage < 85 &&
      postExecutionState.disk.usage < 90
    );
  }

  /**
   * 检查是否为外部因素
   */
  private isExternalFactor(error: string, output: string): boolean {
    const externalPatterns = [
      /network unreachable/i,
      /host unreachable/i,
      /dns resolution/i,
      /external service/i,
      /upstream/i,
      /third.?party/i,
    ];

    const combined = `${error} ${output}`;
    return externalPatterns.some(pattern => pattern.test(combined));
  }

  /**
   * 提取错误详情
   */
  private extractErrorDetails(error: string, output: string, category: FailureCategory): string {
    const combined = `${error} ${output}`.trim();

    if (category === 'execution_error') {
      // 提取关键错误信息
      const match = combined.match(/(error|failed|denied|refused|invalid)[^.]*[.!]?/i);
      return match ? match[0].trim() : combined.slice(0, 200);
    }

    if (category === 'external_factor') {
      const match = combined.match(/(network|host|dns|external|upstream)[^.]*[.!]?/i);
      return match ? match[0].trim() : '外部服务或网络问题';
    }

    return combined.slice(0, 200);
  }

  /**
   * 使用 AI 分析失败原因
   * Requirements: 3.9
   */
  private async analyzeFailureWithAI(
    result: ExecutionResult,
    context: EvaluationContext
  ): Promise<{ category: FailureCategory; confidence: number; details: string } | null> {
    try {
      const analysisResult = await aiAnalyzer.analyze({
        type: 'fault_diagnosis',
        context: {
          executionResult: result,
          alertEvent: context.alertEvent,
          preState: context.preExecutionState,
          postState: context.postExecutionState,
          analysisType: 'failure_classification',
        },
      });

      // 解析 AI 返回的分类
      const summary = analysisResult.summary.toLowerCase();

      if (summary.includes('wrong diagnosis') || summary.includes('诊断错误')) {
        return {
          category: 'wrong_diagnosis',
          confidence: analysisResult.confidence || 0.7,
          details: analysisResult.summary,
        };
      }

      if (summary.includes('insufficient') || summary.includes('不足')) {
        return {
          category: 'insufficient_action',
          confidence: analysisResult.confidence || 0.7,
          details: analysisResult.summary,
        };
      }

      return null;
    } catch {
      return null;
    }
  }


  /**
   * 生成改进建议
   * Requirements: 4.1-4.6
   */
  generateSuggestions(evaluation: EvaluationReport): ImprovementSuggestion[] {
    const suggestions: Set<ImprovementSuggestion> = new Set();

    // 4.6 learn 建议始终包含
    suggestions.add('learn');

    if (evaluation.failureCategory) {
      // 根据失败类型映射建议
      const mappedSuggestions = FAILURE_TO_SUGGESTIONS[evaluation.failureCategory];
      for (const suggestion of mappedSuggestions) {
        suggestions.add(suggestion);
      }
    }

    // 根据评估结果添加额外建议
    if (!evaluation.overallSuccess) {
      // 4.1 如果整体失败，建议重试或替代方案
      if (evaluation.overallScore >= 50) {
        suggestions.add('retry');
      } else {
        suggestions.add('alternative');
      }

      // 4.4 如果有副作用，建议回滚
      const hasSideEffects = evaluation.stepEvaluations.some(
        e => e.dimensions.sideEffects < 60
      );
      if (hasSideEffects) {
        suggestions.add('rollback');
      }

      // 4.3 如果分数很低，建议升级
      if (evaluation.overallScore < 30) {
        suggestions.add('escalate');
      }
    }

    // 如果根因未解决，建议替代方案
    if (!evaluation.rootCauseAddressed) {
      suggestions.add('alternative');
    }

    return Array.from(suggestions);
  }

  /**
   * 获取 AI 分析
   */
  private async getAIAnalysis(
    report: EvaluationReport,
    context: EvaluationContext
  ): Promise<string> {
    const result = await aiAnalyzer.analyze({
      type: 'fault_diagnosis',
      context: {
        evaluationReport: report,
        alertEvent: context.alertEvent,
        preState: context.preExecutionState,
        postState: context.postExecutionState,
        analysisType: 'evaluation_summary',
      },
    });

    return result.summary;
  }

  /**
   * 获取评估报告
   */
  async getReport(reportId: string): Promise<EvaluationReport | null> {
    await this.initialize();

    // 先从缓存查找
    const cached = this.evaluationsCache.get(reportId);
    if (cached) {
      return cached;
    }

    // PostgreSQL path
    if (this.usePg) {
      try {
        const row = await this.pgDataStore!.queryOne<{ data: string }>(
          'SELECT data FROM evaluation_reports WHERE id = $1', [reportId]
        );
        if (row) {
          const report: EvaluationReport = typeof row.data === 'string' ? JSON.parse(row.data) : row.data;
          this.evaluationsCache.set(report.id, report);
          this.planToReportMap.set(report.planId, report.id);
          return report;
        }
      } catch (error) {
        logger.warn('Failed to get report from PostgreSQL, falling back to file:', error);
      }
    }

    // File-based fallback: 从磁盘查找（遍历最近的文件）
    try {
      const files = await fs.readdir(EVALUATIONS_DIR);
      for (const file of files.sort().reverse()) {
        if (!file.endsWith('.json')) continue;

        const content = await fs.readFile(path.join(EVALUATIONS_DIR, file), 'utf-8');
        const reports = JSON.parse(content) as EvaluationReport[];
        const found = reports.find(r => r.id === reportId);
        if (found) {
          this.evaluationsCache.set(found.id, found);
          return found;
        }
      }
    } catch (error) {
      logger.error('Failed to search for report:', error);
    }

    return null;
  }

  /**
   * 按方案 ID 获取评估报告
   */
  async getReportByPlanId(planId: string): Promise<EvaluationReport | null> {
    await this.initialize();

    // 先从映射查找
    const reportId = this.planToReportMap.get(planId);
    if (reportId) {
      return this.getReport(reportId);
    }

    // 从缓存中查找
    for (const report of this.evaluationsCache.values()) {
      if (report.planId === planId) {
        return report;
      }
    }

    // PostgreSQL path
    if (this.usePg) {
      try {
        const row = await this.pgDataStore!.queryOne<{ data: string }>(
          'SELECT data FROM evaluation_reports WHERE plan_id = $1', [planId]
        );
        if (row) {
          const report: EvaluationReport = typeof row.data === 'string' ? JSON.parse(row.data) : row.data;
          this.evaluationsCache.set(report.id, report);
          this.planToReportMap.set(planId, report.id);
          return report;
        }
      } catch (error) {
        logger.warn('Failed to get report by planId from PostgreSQL, falling back to file:', error);
      }
    }

    // File-based fallback: 从磁盘查找
    try {
      const files = await fs.readdir(EVALUATIONS_DIR);
      for (const file of files.sort().reverse()) {
        if (!file.endsWith('.json')) continue;

        const content = await fs.readFile(path.join(EVALUATIONS_DIR, file), 'utf-8');
        const reports = JSON.parse(content) as EvaluationReport[];
        const found = reports.find(r => r.planId === planId);
        if (found) {
          this.evaluationsCache.set(found.id, found);
          this.planToReportMap.set(planId, found.id);
          return found;
        }
      }
    } catch (error) {
      logger.error('Failed to search for report by planId:', error);
    }

    return null;
  }

  /**
   * 获取最近的失败报告 (用于经验闭环注入)
   * @param limit 个数限制
   */
  async getRecentFailedReports(limit: number = 5): Promise<EvaluationReport[]> {
    await this.initialize();

    // 从缓存中获取并按时间排序
    const reports = Array.from(this.evaluationsCache.values())
      .filter(r => !r.overallSuccess)
      .sort((a, b) => b.timestamp - a.timestamp)
      .slice(0, limit);

    return reports;
  }

  /**
   * 获取评估统计
   * Requirements: 18.1, 18.2
   */
  async getStats(): Promise<CriticStats> {
    await this.initialize();

    const reports = Array.from(this.evaluationsCache.values());

    // 计算总评估数
    const totalEvaluations = reports.length;

    // 计算平均分数
    const averageScore = totalEvaluations > 0
      ? reports.reduce((sum, r) => sum + r.overallScore, 0) / totalEvaluations
      : 0;

    // 统计失败类型分布
    const failureCategoryDistribution: Record<FailureCategory, number> = {
      execution_error: 0,
      verification_failed: 0,
      wrong_diagnosis: 0,
      insufficient_action: 0,
      side_effect: 0,
      timeout: 0,
      external_factor: 0,
    };

    for (const report of reports) {
      if (report.failureCategory) {
        failureCategoryDistribution[report.failureCategory]++;
      }
    }

    // 统计改进建议分布
    const improvementSuggestionDistribution: Record<ImprovementSuggestion, number> = {
      retry: 0,
      alternative: 0,
      escalate: 0,
      rollback: 0,
      learn: 0,
    };

    for (const report of reports) {
      for (const suggestion of report.improvementSuggestions) {
        improvementSuggestionDistribution[suggestion]++;
      }
    }

    return {
      totalEvaluations,
      averageScore: Math.round(averageScore * 100) / 100,
      failureCategoryDistribution,
      improvementSuggestionDistribution,
      lastUpdated: Date.now(),
    };
  }
}

// 导出单例
export const criticService = new CriticService();
