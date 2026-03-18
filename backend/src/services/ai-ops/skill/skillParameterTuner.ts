/**
 * SkillParameterTuner - Skill 参数自动调优服务
 * 
 * 收集参数使用统计，分析参数组合与成功率的关系，生成优化建议
 * 
 * Requirements: 12.3, 12.4
 * - 收集每个 Skill 的参数使用统计
 * - 分析参数组合与成功率的关系
 * - 生成参数优化建议
 * - 实现参数变更的 A/B 测试框架
 * - 自动应用经过验证的优化（需用户批准）
 */

import { logger } from '../../../utils/logger';
import { Skill, SkillConfig, SkillCaps } from '../../../types/skill';
import { SkillRegistry } from './skillRegistry';
import { SkillMetrics } from './skillMetrics';
import type { DataStore } from '../../dataStore';

// ==================== 类型定义 ====================

/**
 * 参数使用记录
 */
export interface ParameterUsageRecord {
  /** 记录 ID */
  id: string;
  /** Skill 名称 */
  skillName: string;
  /** 使用的参数配置 */
  parameters: ParameterSnapshot;
  /** 是否成功 */
  success: boolean;
  /** 响应时间（毫秒） */
  responseTime: number;
  /** 用户满意度（-1: 负面, 0: 无反馈, 1: 正面） */
  satisfaction: number;
  /** 记录时间 */
  timestamp: Date;
}

/**
 * 参数快照
 */
export interface ParameterSnapshot {
  /** 温度参数 */
  temperature: number;
  /** 最大迭代次数 */
  maxIterations: number;
  /** 最大 token 数 */
  maxTokens: number;
  /** 知识检索最小分数 */
  knowledgeMinScore?: number;
  /** 其他自定义参数 */
  custom?: Record<string, unknown>;
}

/**
 * 参数统计
 */
export interface ParameterStats {
  /** 参数名称 */
  paramName: string;
  /** 参数值 */
  value: number | string;
  /** 使用次数 */
  usageCount: number;
  /** 成功次数 */
  successCount: number;
  /** 成功率 */
  successRate: number;
  /** 平均响应时间 */
  avgResponseTime: number;
  /** 平均满意度 */
  avgSatisfaction: number;
}

/**
 * 参数优化建议
 */
export interface ParameterRecommendation {
  /** 建议 ID */
  id: string;
  /** Skill 名称 */
  skillName: string;
  /** 参数名称 */
  paramName: string;
  /** 当前值 */
  currentValue: number | string;
  /** 建议值 */
  recommendedValue: number | string;
  /** 预期改进（百分比） */
  expectedImprovement: number;
  /** 置信度（0-1） */
  confidence: number;
  /** 建议原因 */
  reason: string;
  /** 创建时间 */
  createdAt: Date;
  /** 状态 */
  status: 'pending' | 'approved' | 'rejected' | 'applied' | 'testing';
}

/**
 * A/B 测试配置
 */
export interface ABTestConfig {
  /** 测试 ID */
  testId: string;
  /** Skill 名称 */
  skillName: string;
  /** 参数名称 */
  paramName: string;
  /** 控制组值（当前值） */
  controlValue: number | string;
  /** 实验组值（建议值） */
  experimentValue: number | string;
  /** 实验组流量比例（0-1） */
  experimentRatio: number;
  /** 最小样本数 */
  minSampleSize: number;
  /** 开始时间 */
  startedAt: Date;
  /** 结束时间 */
  endedAt?: Date;
  /** 状态 */
  status: 'running' | 'completed' | 'cancelled';
  /** 控制组统计 */
  controlStats: {
    count: number;
    successCount: number;
    totalResponseTime: number;
  };
  /** 实验组统计 */
  experimentStats: {
    count: number;
    successCount: number;
    totalResponseTime: number;
  };
}

/**
 * 参数调优配置
 */
export interface ParameterTunerConfig {
  /** 最小样本数（用于生成建议） */
  minSampleSize: number;
  /** 显著性阈值（用于判断改进是否显著） */
  significanceThreshold: number;
  /** 最大保留记录数 */
  maxRecords: number;
  /** 自动保存间隔（毫秒） */
  autoSaveInterval: number;
  /** A/B 测试默认流量比例 */
  defaultExperimentRatio: number;
}

/**
 * 默认配置
 */
const DEFAULT_CONFIG: ParameterTunerConfig = {
  minSampleSize: 20,
  significanceThreshold: 0.05,
  maxRecords: 10000,
  autoSaveInterval: 300000, // 5 分钟
  defaultExperimentRatio: 0.2,
};

/**
 * SkillParameterTuner 类
 * 自动参数调优服务
 */
export class SkillParameterTuner {
  private config: ParameterTunerConfig;
  private registry: SkillRegistry;
  private metrics: SkillMetrics;
  private dataStore: DataStore | null = null;
  
  // 参数使用记录（内存缓存，定期刷入 PostgreSQL）
  private usageRecords: ParameterUsageRecord[] = [];
  
  // 优化建议
  private recommendations: Map<string, ParameterRecommendation> = new Map();
  
  // A/B 测试
  private abTests: Map<string, ABTestConfig> = new Map();
  
  // 状态
  private dirty: boolean = false;
  private saveTimer: NodeJS.Timeout | null = null;
  private initialized: boolean = false;

  constructor(
    registry: SkillRegistry,
    metrics: SkillMetrics,
    config?: Partial<ParameterTunerConfig>
  ) {
    this.registry = registry;
    this.metrics = metrics;
    this.config = { ...DEFAULT_CONFIG, ...config };
    
    logger.info('SkillParameterTuner created', { config: this.config });
  }

  /**
   * 注入 DataStore（PostgreSQL），启用持久化
   */
  setDataStore(dataStore: DataStore): void {
    this.dataStore = dataStore;
    logger.info('SkillParameterTuner: DataStore injected, using PostgreSQL for persistence');
  }

  /**
   * 初始化
   */
  async initialize(): Promise<void> {
    if (this.initialized) {
      return;
    }

    try {
      await this.loadData();
      this.startAutoSave();
      this.initialized = true;
      logger.info('SkillParameterTuner initialized', {
        records: this.usageRecords.length,
        recommendations: this.recommendations.size,
        abTests: this.abTests.size,
      });
    } catch (error) {
      logger.error('Failed to initialize SkillParameterTuner', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * 加载数据（从 PostgreSQL）
   */
  private async loadData(): Promise<void> {
    if (!this.dataStore) {
      logger.debug('SkillParameterTuner: No DataStore, running in memory-only mode');
      return;
    }

    try {
      // 加载使用记录（最近 maxRecords 条）
      const rows = await this.dataStore.query<{
        id: string;
        skill_name: string;
        parameters: Record<string, unknown>;
        success: boolean;
        response_time: number;
        satisfaction: number;
        created_at: string;
      }>(
        'SELECT id, skill_name, parameters, success, response_time, satisfaction, created_at FROM skill_parameter_usage ORDER BY created_at DESC LIMIT $1',
        [this.config.maxRecords]
      );
      this.usageRecords = rows.reverse().map(r => ({
        id: r.id,
        skillName: r.skill_name,
        parameters: r.parameters as unknown as ParameterSnapshot,
        success: r.success,
        responseTime: r.response_time,
        satisfaction: r.satisfaction,
        timestamp: new Date(r.created_at),
      }));

      // 加载建议
      const recs = await this.dataStore.query<{
        id: string;
        skill_name: string;
        param_name: string;
        current_value: string;
        recommended_value: string;
        expected_improvement: number;
        confidence: number;
        reason: string;
        status: string;
        created_at: string;
      }>('SELECT * FROM skill_parameter_recommendations');
      for (const rec of recs) {
        this.recommendations.set(rec.id, {
          id: rec.id,
          skillName: rec.skill_name,
          paramName: rec.param_name,
          currentValue: isNaN(Number(rec.current_value)) ? rec.current_value : Number(rec.current_value),
          recommendedValue: isNaN(Number(rec.recommended_value)) ? rec.recommended_value : Number(rec.recommended_value),
          expectedImprovement: rec.expected_improvement,
          confidence: rec.confidence,
          reason: rec.reason,
          status: rec.status as ParameterRecommendation['status'],
          createdAt: new Date(rec.created_at),
        });
      }

      // 加载 A/B 测试
      const tests = await this.dataStore.query<{
        test_id: string;
        skill_name: string;
        param_name: string;
        control_value: string;
        experiment_value: string;
        experiment_ratio: number;
        min_sample_size: number;
        status: string;
        control_stats: { count: number; successCount: number; totalResponseTime: number };
        experiment_stats: { count: number; successCount: number; totalResponseTime: number };
        started_at: string;
        ended_at: string | null;
      }>('SELECT * FROM skill_ab_tests');
      for (const test of tests) {
        this.abTests.set(test.test_id, {
          testId: test.test_id,
          skillName: test.skill_name,
          paramName: test.param_name,
          controlValue: isNaN(Number(test.control_value)) ? test.control_value : Number(test.control_value),
          experimentValue: isNaN(Number(test.experiment_value)) ? test.experiment_value : Number(test.experiment_value),
          experimentRatio: test.experiment_ratio,
          minSampleSize: test.min_sample_size,
          status: test.status as ABTestConfig['status'],
          controlStats: test.control_stats,
          experimentStats: test.experiment_stats,
          startedAt: new Date(test.started_at),
          endedAt: test.ended_at ? new Date(test.ended_at) : undefined,
        });
      }
    } catch (error) {
      logger.warn('Failed to load tuning data from PostgreSQL', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * 保存数据（刷入 PostgreSQL）
   */
  private async saveData(): Promise<void> {
    if (!this.dirty) return;
    if (!this.dataStore) {
      this.dirty = false;
      return;
    }

    try {
      // 保存新增的使用记录（upsert）
      for (const record of this.usageRecords) {
        await this.dataStore.execute(
          `INSERT INTO skill_parameter_usage (id, skill_name, parameters, success, response_time, satisfaction, created_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7)
           ON CONFLICT (id) DO NOTHING`,
          [record.id, record.skillName, JSON.stringify(record.parameters), record.success, record.responseTime, record.satisfaction, record.timestamp.toISOString()]
        );
      }

      // 保存建议（upsert）
      for (const rec of this.recommendations.values()) {
        await this.dataStore.execute(
          `INSERT INTO skill_parameter_recommendations (id, skill_name, param_name, current_value, recommended_value, expected_improvement, confidence, reason, status, created_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
           ON CONFLICT (id) DO UPDATE SET status = EXCLUDED.status`,
          [rec.id, rec.skillName, rec.paramName, String(rec.currentValue), String(rec.recommendedValue), rec.expectedImprovement, rec.confidence, rec.reason, rec.status, rec.createdAt.toISOString()]
        );
      }

      // 保存 A/B 测试（upsert）
      for (const test of this.abTests.values()) {
        await this.dataStore.execute(
          `INSERT INTO skill_ab_tests (test_id, skill_name, param_name, control_value, experiment_value, experiment_ratio, min_sample_size, status, control_stats, experiment_stats, started_at, ended_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
           ON CONFLICT (test_id) DO UPDATE SET
             status = EXCLUDED.status,
             control_stats = EXCLUDED.control_stats,
             experiment_stats = EXCLUDED.experiment_stats,
             ended_at = EXCLUDED.ended_at`,
          [test.testId, test.skillName, test.paramName, String(test.controlValue), String(test.experimentValue), test.experimentRatio, test.minSampleSize, test.status, JSON.stringify(test.controlStats), JSON.stringify(test.experimentStats), test.startedAt.toISOString(), test.endedAt?.toISOString() ?? null]
        );
      }

      this.dirty = false;
      logger.debug('Tuning data saved to PostgreSQL');
    } catch (error) {
      logger.error('Failed to save tuning data to PostgreSQL', {
        error: error instanceof Error ? error.message : String(error),
      });
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
      await this.saveData();
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

  // ==================== 参数记录 ====================

  /**
   * 记录参数使用
   */
  recordUsage(
    skillName: string,
    parameters: ParameterSnapshot,
    success: boolean,
    responseTime: number,
    satisfaction: number = 0
  ): void {
    const record: ParameterUsageRecord = {
      id: this.generateId(),
      skillName,
      parameters,
      success,
      responseTime,
      satisfaction,
      timestamp: new Date(),
    };

    this.usageRecords.push(record);

    // 限制记录数量
    if (this.usageRecords.length > this.config.maxRecords) {
      this.usageRecords = this.usageRecords.slice(-this.config.maxRecords);
    }

    // 更新 A/B 测试统计
    this.updateABTestStats(record);

    this.dirty = true;

    logger.debug('Parameter usage recorded', {
      skillName,
      success,
      responseTime,
    });
  }

  /**
   * 从 Skill 配置提取参数快照
   */
  extractParameterSnapshot(skill: Skill): ParameterSnapshot {
    return {
      temperature: skill.config.caps.temperature,
      maxIterations: skill.config.caps.maxIterations,
      maxTokens: skill.config.caps.maxTokens,
      knowledgeMinScore: skill.config.knowledgeConfig.minScore,
    };
  }

  // ==================== 统计分析 ====================

  /**
   * 获取参数统计
   */
  getParameterStats(skillName: string): Map<string, ParameterStats[]> {
    const records = this.usageRecords.filter(r => r.skillName === skillName);
    const statsMap = new Map<string, ParameterStats[]>();

    // 分析温度参数
    statsMap.set('temperature', this.analyzeNumericParam(records, 'temperature'));
    
    // 分析最大迭代次数
    statsMap.set('maxIterations', this.analyzeNumericParam(records, 'maxIterations'));
    
    // 分析知识检索最小分数
    statsMap.set('knowledgeMinScore', this.analyzeNumericParam(records, 'knowledgeMinScore'));

    return statsMap;
  }

  /**
   * 分析数值参数
   */
  private analyzeNumericParam(
    records: ParameterUsageRecord[],
    paramName: keyof ParameterSnapshot
  ): ParameterStats[] {
    // 按参数值分组
    const groups = new Map<number, ParameterUsageRecord[]>();
    
    for (const record of records) {
      const value = record.parameters[paramName] as number | undefined;
      if (value === undefined) continue;
      
      // 将值四舍五入到一位小数以便分组
      const roundedValue = Math.round(value * 10) / 10;
      
      if (!groups.has(roundedValue)) {
        groups.set(roundedValue, []);
      }
      groups.get(roundedValue)!.push(record);
    }

    // 计算每组统计
    const stats: ParameterStats[] = [];
    
    for (const [value, groupRecords] of groups) {
      const successCount = groupRecords.filter(r => r.success).length;
      const totalResponseTime = groupRecords.reduce((sum, r) => sum + r.responseTime, 0);
      const totalSatisfaction = groupRecords.reduce((sum, r) => sum + r.satisfaction, 0);
      
      stats.push({
        paramName,
        value,
        usageCount: groupRecords.length,
        successCount,
        successRate: groupRecords.length > 0 ? successCount / groupRecords.length : 0,
        avgResponseTime: groupRecords.length > 0 ? totalResponseTime / groupRecords.length : 0,
        avgSatisfaction: groupRecords.length > 0 ? totalSatisfaction / groupRecords.length : 0,
      });
    }

    // 按成功率降序排序
    stats.sort((a, b) => b.successRate - a.successRate);

    return stats;
  }

  // ==================== 优化建议 ====================

  /**
   * 生成优化建议
   */
  generateRecommendations(skillName: string): ParameterRecommendation[] {
    const skill = this.registry.get(skillName);
    if (!skill) {
      logger.warn('Skill not found for recommendations', { skillName });
      return [];
    }

    const stats = this.getParameterStats(skillName);
    const recommendations: ParameterRecommendation[] = [];

    // 分析温度参数
    const tempStats = stats.get('temperature') || [];
    const tempRec = this.analyzeAndRecommend(
      skillName,
      'temperature',
      skill.config.caps.temperature,
      tempStats
    );
    if (tempRec) recommendations.push(tempRec);

    // 分析最大迭代次数
    const iterStats = stats.get('maxIterations') || [];
    const iterRec = this.analyzeAndRecommend(
      skillName,
      'maxIterations',
      skill.config.caps.maxIterations,
      iterStats
    );
    if (iterRec) recommendations.push(iterRec);

    // 分析知识检索最小分数
    const scoreStats = stats.get('knowledgeMinScore') || [];
    const scoreRec = this.analyzeAndRecommend(
      skillName,
      'knowledgeMinScore',
      skill.config.knowledgeConfig.minScore,
      scoreStats
    );
    if (scoreRec) recommendations.push(scoreRec);

    // 保存建议
    for (const rec of recommendations) {
      this.recommendations.set(rec.id, rec);
    }
    this.dirty = true;

    return recommendations;
  }

  /**
   * 分析并生成单个参数建议
   */
  private analyzeAndRecommend(
    skillName: string,
    paramName: string,
    currentValue: number,
    stats: ParameterStats[]
  ): ParameterRecommendation | null {
    // 需要足够的样本
    const totalSamples = stats.reduce((sum, s) => sum + s.usageCount, 0);
    if (totalSamples < this.config.minSampleSize) {
      return null;
    }

    // 找到当前值的统计
    const currentStats = stats.find(s => Math.abs((s.value as number) - currentValue) < 0.05);
    const currentSuccessRate = currentStats?.successRate || 0;

    // 找到最佳值
    const bestStats = stats[0]; // 已按成功率排序
    if (!bestStats || bestStats.usageCount < 5) {
      return null;
    }

    const bestValue = bestStats.value as number;
    const improvement = bestStats.successRate - currentSuccessRate;

    // 只有当改进显著时才建议
    if (improvement < this.config.significanceThreshold) {
      return null;
    }

    // 计算置信度（基于样本量）
    const confidence = Math.min(bestStats.usageCount / 50, 1);

    return {
      id: this.generateId(),
      skillName,
      paramName,
      currentValue,
      recommendedValue: bestValue,
      expectedImprovement: improvement * 100,
      confidence,
      reason: `基于 ${totalSamples} 次使用记录分析，将 ${paramName} 从 ${currentValue} 调整为 ${bestValue} 可能提升成功率 ${(improvement * 100).toFixed(1)}%`,
      createdAt: new Date(),
      status: 'pending',
    };
  }

  /**
   * 获取所有建议
   */
  getRecommendations(skillName?: string): ParameterRecommendation[] {
    let recs = Array.from(this.recommendations.values());
    
    if (skillName) {
      recs = recs.filter(r => r.skillName === skillName);
    }
    
    return recs.sort((a, b) => b.expectedImprovement - a.expectedImprovement);
  }

  /**
   * 更新建议状态
   */
  updateRecommendationStatus(
    recommendationId: string,
    status: ParameterRecommendation['status']
  ): boolean {
    const rec = this.recommendations.get(recommendationId);
    if (!rec) return false;

    rec.status = status;
    this.dirty = true;
    
    logger.info('Recommendation status updated', {
      id: recommendationId,
      status,
    });
    
    return true;
  }

  // ==================== A/B 测试 ====================

  /**
   * 创建 A/B 测试
   */
  createABTest(
    skillName: string,
    paramName: string,
    experimentValue: number | string,
    options?: {
      experimentRatio?: number;
      minSampleSize?: number;
    }
  ): ABTestConfig | null {
    const skill = this.registry.get(skillName);
    if (!skill) {
      logger.warn('Skill not found for A/B test', { skillName });
      return null;
    }

    // 获取当前值
    let controlValue: number | string;
    switch (paramName) {
      case 'temperature':
        controlValue = skill.config.caps.temperature;
        break;
      case 'maxIterations':
        controlValue = skill.config.caps.maxIterations;
        break;
      case 'maxTokens':
        controlValue = skill.config.caps.maxTokens;
        break;
      case 'knowledgeMinScore':
        controlValue = skill.config.knowledgeConfig.minScore;
        break;
      default:
        logger.warn('Unknown parameter for A/B test', { paramName });
        return null;
    }

    const testId = this.generateId();
    const test: ABTestConfig = {
      testId,
      skillName,
      paramName,
      controlValue,
      experimentValue,
      experimentRatio: options?.experimentRatio || this.config.defaultExperimentRatio,
      minSampleSize: options?.minSampleSize || this.config.minSampleSize,
      startedAt: new Date(),
      status: 'running',
      controlStats: { count: 0, successCount: 0, totalResponseTime: 0 },
      experimentStats: { count: 0, successCount: 0, totalResponseTime: 0 },
    };

    this.abTests.set(testId, test);
    this.dirty = true;

    logger.info('A/B test created', {
      testId,
      skillName,
      paramName,
      controlValue,
      experimentValue,
    });

    return test;
  }

  /**
   * 获取 A/B 测试
   */
  getABTest(testId: string): ABTestConfig | undefined {
    return this.abTests.get(testId);
  }

  /**
   * 获取 Skill 的活跃 A/B 测试
   */
  getActiveABTests(skillName?: string): ABTestConfig[] {
    let tests = Array.from(this.abTests.values()).filter(t => t.status === 'running');
    
    if (skillName) {
      tests = tests.filter(t => t.skillName === skillName);
    }
    
    return tests;
  }

  /**
   * 判断是否应该使用实验组
   */
  shouldUseExperiment(testId: string): boolean {
    const test = this.abTests.get(testId);
    if (!test || test.status !== 'running') {
      return false;
    }
    
    return Math.random() < test.experimentRatio;
  }

  /**
   * 更新 A/B 测试统计
   */
  private updateABTestStats(record: ParameterUsageRecord): void {
    const activeTests = this.getActiveABTests(record.skillName);
    
    for (const test of activeTests) {
      const paramValue = record.parameters[test.paramName as keyof ParameterSnapshot];
      if (paramValue === undefined) continue;

      // 判断是控制组还是实验组
      const isExperiment = paramValue === test.experimentValue;
      const stats = isExperiment ? test.experimentStats : test.controlStats;

      stats.count++;
      if (record.success) stats.successCount++;
      stats.totalResponseTime += record.responseTime;

      // 检查是否达到最小样本数
      if (test.controlStats.count >= test.minSampleSize &&
          test.experimentStats.count >= test.minSampleSize) {
        this.evaluateABTest(test.testId);
      }
    }
  }

  /**
   * 评估 A/B 测试结果
   */
  evaluateABTest(testId: string): {
    winner: 'control' | 'experiment' | 'inconclusive';
    controlSuccessRate: number;
    experimentSuccessRate: number;
    improvement: number;
    significant: boolean;
  } | null {
    const test = this.abTests.get(testId);
    if (!test) return null;

    const controlSuccessRate = test.controlStats.count > 0
      ? test.controlStats.successCount / test.controlStats.count
      : 0;
    
    const experimentSuccessRate = test.experimentStats.count > 0
      ? test.experimentStats.successCount / test.experimentStats.count
      : 0;

    const improvement = experimentSuccessRate - controlSuccessRate;
    const significant = Math.abs(improvement) >= this.config.significanceThreshold;

    let winner: 'control' | 'experiment' | 'inconclusive';
    if (!significant) {
      winner = 'inconclusive';
    } else if (improvement > 0) {
      winner = 'experiment';
    } else {
      winner = 'control';
    }

    return {
      winner,
      controlSuccessRate,
      experimentSuccessRate,
      improvement,
      significant,
    };
  }

  /**
   * 结束 A/B 测试
   */
  endABTest(testId: string, status: 'completed' | 'cancelled' = 'completed'): boolean {
    const test = this.abTests.get(testId);
    if (!test) return false;

    test.status = status;
    test.endedAt = new Date();
    this.dirty = true;

    logger.info('A/B test ended', {
      testId,
      status,
      controlCount: test.controlStats.count,
      experimentCount: test.experimentStats.count,
    });

    return true;
  }

  // ==================== 辅助方法 ====================

  /**
   * 生成唯一 ID
   */
  private generateId(): string {
    return `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  }

  /**
   * 获取使用记录
   */
  getUsageRecords(skillName?: string, limit?: number): ParameterUsageRecord[] {
    let records = this.usageRecords;
    
    if (skillName) {
      records = records.filter(r => r.skillName === skillName);
    }
    
    if (limit) {
      records = records.slice(-limit);
    }
    
    return records;
  }

  /**
   * 清空数据
   */
  clearData(): void {
    this.usageRecords = [];
    this.recommendations.clear();
    this.abTests.clear();
    this.dirty = true;
    logger.info('Parameter tuning data cleared');
  }

  /**
   * 检查是否已初始化
   */
  isInitialized(): boolean {
    return this.initialized;
  }

  /**
   * 关闭服务
   */
  async shutdown(): Promise<void> {
    this.stopAutoSave();
    await this.saveData();
    logger.info('SkillParameterTuner shutdown');
  }
}

// 导出单例实例（延迟初始化）
let _parameterTuner: SkillParameterTuner | null = null;

export function getParameterTuner(
  registry: SkillRegistry,
  metrics: SkillMetrics,
  dataStore?: DataStore
): SkillParameterTuner {
  if (!_parameterTuner) {
    _parameterTuner = new SkillParameterTuner(registry, metrics);
  }
  if (dataStore && !_parameterTuner['dataStore']) {
    _parameterTuner.setDataStore(dataStore);
  }
  return _parameterTuner;
}
