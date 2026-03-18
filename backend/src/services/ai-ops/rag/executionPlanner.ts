/**
 * ExecutionPlanner - 执行计划器
 * 
 * 分析复杂任务并生成执行计划 DAG
 * 
 * Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 2.6
 * - 2.1: 为复杂查询生成执行 DAG
 * - 2.2: DAG 中节点表示工具调用，边表示依赖
 * - 2.3: 识别可并行执行的独立工具调用
 * - 2.4: 支持基于中间结果的计划修订
 * - 2.5: 1000ms 内完成计划生成
 * - 2.6: 计划生成失败时回退到串行模式
 */

import { logger } from '../../../utils/logger';
import {
  ExecutionPlan,
  ExecutionStage,
  PlannedToolCall,
  MergedObservation,
  ParallelExecutionError,
  ParallelExecutionErrorType,
} from '../../../types/parallel-execution';
import { DependencyAnalyzer, dependencyAnalyzer } from './dependencyAnalyzer';
import { SkillContext } from './reactLoopController';
// 智能进化系统配置导入 (Requirements: 3.2)
import { getCapabilityConfig } from '../evolutionConfig';

/**
 * 阶段评估结果
 * Requirements: 3.1.1, 3.1.2
 */
export interface StageEvaluationResult {
  /** 阶段 ID */
  stageId: string;
  /** 是否成功 */
  success: boolean;
  /** 质量评分 (0-100) */
  qualityScore: number;
  /** 是否需要修订计划 */
  needsRevision: boolean;
  /** 修订建议 */
  revisionSuggestions?: string[];
  /** 评估详情 */
  details?: {
    /** 完成的工具调用数 */
    completedCalls: number;
    /** 失败的工具调用数 */
    failedCalls: number;
    /** 关键发现 */
    keyFindings?: string[];
    /** 潜在问题 */
    potentialIssues?: string[];
  };
}

/**
 * 计划修订操作
 * Requirements: 3.2.1, 3.2.2
 */
export interface PlanRevisionOperation {
  /** 操作类型 */
  type: 'add' | 'remove' | 'modify';
  /** 目标阶段 ID（用于 remove 和 modify） */
  targetStageId?: string;
  /** 新阶段（用于 add 和 modify） */
  newStage?: ExecutionStage;
  /** 修订原因 */
  reason: string;
}

/**
 * 执行计划器配置
 */
export interface ExecutionPlannerConfig {
  /** 是否启用 */
  enabled: boolean;
  /** 计划生成超时（毫秒） */
  timeout: number;
  /** 最大阶段数 */
  maxStages: number;
  /** 每阶段最大工具调用数 */
  maxCallsPerStage: number;
  /** 修订触发配置 - Requirements: 3.3.1, 3.3.2, 3.3.3, 3.3.4 */
  revisionTriggers?: RevisionTriggerConfig;
}

/**
 * 修订触发配置
 * Requirements: 3.3.1, 3.3.2, 3.3.3, 3.3.4
 */
export interface RevisionTriggerConfig {
  /** 失败率阈值（超过此值触发修订），默认 0.3 */
  failureRateThreshold: number;
  /** 质量评分阈值（低于此值触发修订），默认 60 */
  qualityScoreThreshold: number;
  /** 触发修订的关键词列表 */
  triggerKeywords: string[];
  /** 是否启用自动修订，默认 true */
  autoRevisionEnabled: boolean;
  /** 最大修订次数，默认 2 */
  maxRevisions: number;
}

/**
 * 默认修订触发配置
 */
const DEFAULT_REVISION_TRIGGERS: RevisionTriggerConfig = {
  failureRateThreshold: 0.3,
  qualityScoreThreshold: 60,
  triggerKeywords: [
    '需要进一步', '建议检查', '可能存在', '异常', '错误',
    'further investigation', 'recommend checking', 'potential issue', 'error',
    '失败', 'failed', 'failure', '超时', 'timeout'
  ],
  autoRevisionEnabled: true,
  maxRevisions: 2,
};

/**
 * 默认配置
 */
const DEFAULT_CONFIG: ExecutionPlannerConfig = {
  enabled: true,
  timeout: 1000,
  maxStages: 5,
  maxCallsPerStage: 5,
  revisionTriggers: DEFAULT_REVISION_TRIGGERS,
};

/**
 * 任务模板
 * 定义常见任务类型的执行计划模板
 */
const TASK_TEMPLATES: Record<string, PlannedToolCall[][]> = {
  // 故障诊断模板
  fault_diagnosis: [
    [
      { toolName: 'knowledge_search', paramsTemplate: { query: '{{issue}}' }, purpose: '查询历史案例', optional: false },
    ],
    [
      { toolName: 'device_query', paramsTemplate: { command: '/system/resource' }, purpose: '获取系统资源', optional: false },
      { toolName: 'device_query', paramsTemplate: { command: '/interface' }, purpose: '获取接口状态', optional: false },
    ],
    [
      { toolName: 'device_query', paramsTemplate: { command: '/log', limit: 20 }, purpose: '获取最近日志', optional: true },
    ],
  ],
  // 配置检查模板
  config_check: [
    [
      { toolName: 'device_query', paramsTemplate: { command: '/ip/address' }, purpose: '获取 IP 配置', optional: false },
      { toolName: 'device_query', paramsTemplate: { command: '/ip/route' }, purpose: '获取路由配置', optional: false },
    ],
    [
      { toolName: 'device_query', paramsTemplate: { command: '/ip/firewall/filter', limit: 20 }, purpose: '获取防火墙规则', optional: true },
    ],
  ],
  // 性能分析模板
  performance_analysis: [
    [
      { toolName: 'device_query', paramsTemplate: { command: '/system/resource' }, purpose: '获取系统资源', optional: false },
    ],
    [
      { toolName: 'device_query', paramsTemplate: { command: '/interface' }, purpose: '获取接口状态', optional: false },
      { toolName: 'monitor_metrics', paramsTemplate: {}, purpose: '获取性能指标', optional: false },
    ],
  ],
};

/**
 * 任务类型关键词
 */
const TASK_TYPE_KEYWORDS: Record<string, string[]> = {
  fault_diagnosis: ['故障', '问题', '错误', '异常', '不通', '断开', 'fault', 'error', 'issue', 'problem'],
  config_check: ['配置', '检查', '查看', '设置', 'config', 'check', 'setting'],
  performance_analysis: ['性能', '负载', '资源', '流量', 'performance', 'load', 'resource', 'traffic'],
};

/**
 * ExecutionPlanner 类
 * 生成和管理执行计划
 * 
 * 计划动态修订能力 (Requirements: 3.1, 3.2, 3.3)
 * - 3.1: 阶段评估
 * - 3.2: 智能计划修订
 * - 3.3: 修订触发条件
 */
export class ExecutionPlanner {
  private config: ExecutionPlannerConfig;
  private dependencyAnalyzer: DependencyAnalyzer;
  private planIdCounter = 0;

  constructor(
    config?: Partial<ExecutionPlannerConfig>,
    deps?: { dependencyAnalyzer?: DependencyAnalyzer }
  ) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.dependencyAnalyzer = deps?.dependencyAnalyzer || dependencyAnalyzer;
    logger.debug('ExecutionPlanner initialized', { config: this.config });
  }

  /**
   * 生成执行计划
   * Requirements: 2.1, 2.2, 2.3, 2.5, 2.6
   * 
   * @param message 用户消息
   * @param skillContext 可选的 Skill 上下文
   * @returns 执行计划
   */
  async generatePlan(
    message: string,
    skillContext?: SkillContext
  ): Promise<ExecutionPlan> {
    const startTime = Date.now();
    const planId = `plan_${++this.planIdCounter}_${Date.now()}`;

    try {
      // 设置超时
      const plan = await Promise.race([
        this.doGeneratePlan(planId, message, skillContext),
        this.createTimeout(planId),
      ]);

      const elapsed = Date.now() - startTime;
      logger.info('Execution plan generated', {
        planId,
        stageCount: plan.stages.length,
        estimatedToolCalls: plan.estimatedToolCalls,
        elapsed,
      });

      return plan;
    } catch (error) {
      const elapsed = Date.now() - startTime;
      logger.error('Plan generation failed', {
        planId,
        error: error instanceof Error ? error.message : String(error),
        elapsed,
      });

      throw new ParallelExecutionError(
        ParallelExecutionErrorType.PLANNING_ERROR,
        'Failed to generate execution plan',
        { planId, message: message.substring(0, 100) },
        true
      );
    }
  }

  /**
   * 修订执行计划
   * Requirements: 2.4, 3.2.1, 3.2.2, 3.2.3, 3.2.4
   * 
   * @param currentPlan 当前计划
   * @param completedStages 已完成的阶段
   * @param intermediateResults 中间结果
   * @param evaluation 可选的阶段评估结果
   * @returns 修订后的计划
   */
  async revisePlan(
    currentPlan: ExecutionPlan,
    completedStages: ExecutionStage[],
    intermediateResults: MergedObservation[],
    evaluation?: StageEvaluationResult
  ): Promise<ExecutionPlan> {
    const startTime = Date.now();

    // 如果有评估结果且不需要修订，直接返回剩余阶段
    if (evaluation && !evaluation.needsRevision) {
      const remainingStages = currentPlan.stages.filter(
        stage => !completedStages.some(cs => cs.stageId === stage.stageId)
      );

      return {
        ...currentPlan,
        stages: remainingStages,
        estimatedToolCalls: remainingStages.reduce(
          (sum, stage) => sum + stage.toolCalls.length,
          0
        ),
      };
    }

    // 分析中间结果，决定是否需要调整计划
    const needsRevision = evaluation?.needsRevision || this.analyzeIntermediateResults(intermediateResults);

    if (!needsRevision) {
      // 不需要修订，返回剩余阶段
      const remainingStages = currentPlan.stages.filter(
        stage => !completedStages.some(cs => cs.stageId === stage.stageId)
      );

      return {
        ...currentPlan,
        stages: remainingStages,
        estimatedToolCalls: remainingStages.reduce(
          (sum, stage) => sum + stage.toolCalls.length,
          0
        ),
      };
    }

    // 需要修订，生成修订操作
    const operations = this.generateRevisionOperations(
      currentPlan,
      completedStages,
      intermediateResults,
      evaluation
    );

    // 应用修订操作
    const revisedPlan = this.applyRevisionOperations(currentPlan, completedStages, operations);

    // 修复阶段依赖关系（确保引用的阶段存在）
    revisedPlan.stages = this.fixStageDependencies(revisedPlan.stages);

    // Requirements: 3.2 - 限制新增阶段数不超过 maxAdditionalSteps
    try {
      const prConfig = getCapabilityConfig('planRevision');
      const originalRemainingCount = currentPlan.stages.length - completedStages.length;
      const additionalStages = revisedPlan.stages.length - originalRemainingCount;

      if (additionalStages > 0 && additionalStages > prConfig.maxAdditionalSteps) {
        const maxAllowed = originalRemainingCount + prConfig.maxAdditionalSteps;
        logger.info('Truncating revised plan stages to maxAdditionalSteps limit', {
          revisedStages: revisedPlan.stages.length,
          additionalStages,
          maxAdditionalSteps: prConfig.maxAdditionalSteps,
          truncatedTo: maxAllowed,
        });
        revisedPlan.stages = revisedPlan.stages.slice(0, maxAllowed);
        revisedPlan.estimatedToolCalls = revisedPlan.stages.reduce(
          (sum, stage) => sum + stage.toolCalls.length,
          0
        );
      }
    } catch (configError) {
      // 配置读取失败不影响修订结果
      logger.warn('Failed to check maxAdditionalSteps config, skipping truncation', {
        error: configError instanceof Error ? configError.message : String(configError),
      });
    }

    logger.info('Execution plan revised', {
      planId: currentPlan.planId,
      originalStages: currentPlan.stages.length,
      revisedStages: revisedPlan.stages.length,
      operationsApplied: operations.length,
      elapsed: Date.now() - startTime,
    });

    return revisedPlan;
  }

  /**
   * 评估阶段执行结果
   * Requirements: 3.1.1, 3.1.2, 3.1.4
   * 
   * @param stage 已执行的阶段
   * @param observation 阶段执行结果
   * @param context 执行上下文
   * @returns 评估结果
   */
  async evaluateStep(
    stage: ExecutionStage,
    observation: MergedObservation,
    context?: { originalQuery?: string; previousEvaluations?: StageEvaluationResult[] }
  ): Promise<StageEvaluationResult> {
    const startTime = Date.now();

    try {
      // 基础评估：统计成功/失败
      const completedCalls = observation.results.filter(r => r.success).length;
      const failedCalls = observation.results.filter(r => !r.success).length;
      const totalCalls = observation.results.length;

      // 计算基础质量分数
      let qualityScore = totalCalls > 0 ? (completedCalls / totalCalls) * 100 : 0;

      // 分析结果内容
      const keyFindings: string[] = [];
      const potentialIssues: string[] = [];
      let needsRevision = false;
      const revisionSuggestions: string[] = [];

      // 检查失败的调用
      if (failedCalls > 0) {
        needsRevision = true;
        revisionSuggestions.push(`重试 ${failedCalls} 个失败的工具调用`);
        potentialIssues.push(`${failedCalls} 个工具调用失败`);
      }

      // 分析观察结果文本
      const observationText = observation.formattedText || '';
      
      // 检测需要进一步调查的信号
      const investigationKeywords = [
        '需要进一步', '建议检查', '可能存在', '异常', '错误',
        'further investigation', 'recommend checking', 'potential issue', 'error'
      ];
      
      for (const keyword of investigationKeywords) {
        if (observationText.toLowerCase().includes(keyword.toLowerCase())) {
          needsRevision = true;
          keyFindings.push(`检测到关键词: ${keyword}`);
          break;
        }
      }

      // 使用简化的质量评估（不依赖 CriticService 的复杂签名）
      // CriticService.evaluateStep 需要 RemediationStep 和 ExecutionResult，
      // 这里我们使用简化的启发式评估
      const observationLength = observationText.length;
      if (observationLength > 100) {
        // 有实质性内容，提高分数
        qualityScore = Math.min(100, qualityScore + 10);
        keyFindings.push('获取到实质性结果');
      }

      // 检查是否有错误信息
      const errorKeywords = ['error', 'failed', 'failure', '错误', '失败', '异常'];
      for (const keyword of errorKeywords) {
        if (observationText.toLowerCase().includes(keyword.toLowerCase())) {
          qualityScore = Math.max(0, qualityScore - 15);
          potentialIssues.push(`检测到错误关键词: ${keyword}`);
          needsRevision = true;
          break;
        }
      }

      // 如果质量分数低于阈值，标记需要修订
      if (qualityScore < 60) {
        needsRevision = true;
        revisionSuggestions.push('质量评分较低，建议补充更多信息');
      }

      const result: StageEvaluationResult = {
        stageId: stage.stageId,
        success: failedCalls === 0,
        qualityScore,
        needsRevision,
        revisionSuggestions: revisionSuggestions.length > 0 ? revisionSuggestions : undefined,
        details: {
          completedCalls,
          failedCalls,
          keyFindings: keyFindings.length > 0 ? keyFindings : undefined,
          potentialIssues: potentialIssues.length > 0 ? potentialIssues : undefined,
        },
      };

      logger.debug('Stage evaluation completed', {
        stageId: stage.stageId,
        qualityScore,
        needsRevision,
        elapsed: Date.now() - startTime,
      });

      return result;
    } catch (error) {
      logger.error('Stage evaluation failed', { stageId: stage.stageId, error });
      
      // 返回保守的评估结果
      return {
        stageId: stage.stageId,
        success: false,
        qualityScore: 50,
        needsRevision: true,
        revisionSuggestions: ['评估失败，建议重新执行'],
      };
    }
  }

  /**
   * 生成修订操作
   * Requirements: 3.2.1, 3.2.2
   */
  private generateRevisionOperations(
    currentPlan: ExecutionPlan,
    completedStages: ExecutionStage[],
    intermediateResults: MergedObservation[],
    evaluation?: StageEvaluationResult
  ): PlanRevisionOperation[] {
    const operations: PlanRevisionOperation[] = [];

    // 基于评估建议生成操作
    if (evaluation?.revisionSuggestions) {
      for (const suggestion of evaluation.revisionSuggestions) {
        if (suggestion.includes('重试')) {
          // 生成重试阶段
          const failedCalls = intermediateResults
            .flatMap(r => r.results)
            .filter(r => !r.success);

          if (failedCalls.length > 0) {
            operations.push({
              type: 'add',
              newStage: {
                stageId: `retry_${Date.now()}`,
                order: 100,
                toolCalls: failedCalls.map(call => ({
                  toolName: call.toolName,
                  paramsTemplate: {},
                  purpose: `重试: ${call.toolName}`,
                  optional: true,
                })),
                dependsOnStages: [],
              },
              reason: suggestion,
            });
          }
        }
      }
    }

    // 基于中间结果生成额外操作
    const additionalStages = this.generateAdditionalStages(intermediateResults);
    for (const stage of additionalStages) {
      operations.push({
        type: 'add',
        newStage: stage,
        reason: '基于中间结果分析',
      });
    }

    return operations;
  }

  /**
   * 应用修订操作
   * Requirements: 3.2.3
   */
  private applyRevisionOperations(
    currentPlan: ExecutionPlan,
    completedStages: ExecutionStage[],
    operations: PlanRevisionOperation[]
  ): ExecutionPlan {
    // 获取剩余阶段
    let stages = currentPlan.stages.filter(
      stage => !completedStages.some(cs => cs.stageId === stage.stageId)
    );

    // 应用操作
    for (const op of operations) {
      switch (op.type) {
        case 'add':
          if (op.newStage) {
            stages.push(op.newStage);
          }
          break;
        case 'remove':
          if (op.targetStageId) {
            stages = stages.filter(s => s.stageId !== op.targetStageId);
          }
          break;
        case 'modify':
          if (op.targetStageId && op.newStage) {
            const index = stages.findIndex(s => s.stageId === op.targetStageId);
            if (index >= 0) {
              stages[index] = op.newStage;
            }
          }
          break;
      }
    }

    // 限制阶段数量
    if (stages.length > this.config.maxStages) {
      stages = stages.slice(0, this.config.maxStages);
      logger.warn('Revised plan truncated to max stages', { maxStages: this.config.maxStages });
    }

    return {
      ...currentPlan,
      stages,
      estimatedToolCalls: stages.reduce((sum, stage) => sum + stage.toolCalls.length, 0),
    };
  }

  /**
   * 修复阶段依赖关系
   * Requirements: 3.2.4
   */
  private fixStageDependencies(stages: ExecutionStage[]): ExecutionStage[] {
    const stageIds = new Set(stages.map(s => s.stageId));
    
    return stages.map(stage => ({
      ...stage,
      dependsOnStages: stage.dependsOnStages.filter(depId => stageIds.has(depId)),
    }));
  }

  /**
   * 验证计划有效性
   * 
   * @param plan 执行计划
   * @returns 验证结果
   */
  validatePlan(plan: ExecutionPlan): { valid: boolean; errors: string[] } {
    const errors: string[] = [];

    // 检查阶段数量
    if (plan.stages.length === 0) {
      errors.push('Plan has no stages');
    }

    if (plan.stages.length > this.config.maxStages) {
      errors.push(`Plan exceeds maximum stages (${this.config.maxStages})`);
    }

    // 检查每个阶段
    for (const stage of plan.stages) {
      if (stage.toolCalls.length === 0) {
        errors.push(`Stage ${stage.stageId} has no tool calls`);
      }

      if (stage.toolCalls.length > this.config.maxCallsPerStage) {
        errors.push(`Stage ${stage.stageId} exceeds maximum calls per stage`);
      }

      // 检查依赖的阶段是否存在
      for (const depStageId of stage.dependsOnStages) {
        if (!plan.stages.some(s => s.stageId === depStageId)) {
          errors.push(`Stage ${stage.stageId} depends on non-existent stage ${depStageId}`);
        }
      }
    }

    return {
      valid: errors.length === 0,
      errors,
    };
  }

  /**
   * 更新配置
   */
  updateConfig(config: Partial<ExecutionPlannerConfig>): void {
    this.config = { ...this.config, ...config };
    logger.debug('ExecutionPlanner config updated', { config: this.config });
  }

  /**
   * 获取配置
   */
  getConfig(): ExecutionPlannerConfig {
    return { ...this.config };
  }

  // ==================== 私有方法 ====================

  /**
   * 实际生成计划
   */
  private async doGeneratePlan(
    planId: string,
    message: string,
    skillContext?: SkillContext
  ): Promise<ExecutionPlan> {
    // 识别任务类型
    const taskType = this.identifyTaskType(message);

    // 获取模板
    const template = TASK_TEMPLATES[taskType];

    if (template) {
      // 使用模板生成计划
      return this.generateFromTemplate(planId, template, message, skillContext);
    }

    // 没有匹配的模板，生成通用计划
    return this.generateGenericPlan(planId, message, skillContext);
  }

  /**
   * 识别任务类型
   */
  private identifyTaskType(message: string): string {
    const lowerMessage = message.toLowerCase();

    for (const [taskType, keywords] of Object.entries(TASK_TYPE_KEYWORDS)) {
      for (const keyword of keywords) {
        if (lowerMessage.includes(keyword.toLowerCase())) {
          return taskType;
        }
      }
    }

    return 'generic';
  }

  /**
   * 从模板生成计划
   */
  private generateFromTemplate(
    planId: string,
    template: PlannedToolCall[][],
    message: string,
    skillContext?: SkillContext
  ): ExecutionPlan {
    const stages: ExecutionStage[] = [];
    let stageOrder = 0;

    for (const stageCalls of template) {
      // 过滤掉 Skill 不允许的工具
      const filteredCalls = skillContext?.allowedTools.length
        ? stageCalls.filter(call =>
            skillContext.allowedTools.includes(call.toolName)
          )
        : stageCalls;

      if (filteredCalls.length === 0) continue;

      const stageId = `${planId}_stage_${stageOrder}`;
      stages.push({
        stageId,
        order: stageOrder,
        toolCalls: filteredCalls.map(call => ({
          ...call,
          paramsTemplate: this.substituteParams(call.paramsTemplate, message),
        })),
        dependsOnStages: stageOrder > 0 ? [`${planId}_stage_${stageOrder - 1}`] : [],
      });

      stageOrder++;
    }

    const estimatedToolCalls = stages.reduce(
      (sum, stage) => sum + stage.toolCalls.length,
      0
    );

    return {
      planId,
      stages,
      estimatedToolCalls,
      estimatedDuration: estimatedToolCalls * 2000, // 估算每个调用 2 秒
      maxParallelism: Math.max(...stages.map(s => s.toolCalls.length)),
      createdAt: Date.now(),
    };
  }

  /**
   * 生成通用计划
   */
  private generateGenericPlan(
    planId: string,
    message: string,
    skillContext?: SkillContext
  ): ExecutionPlan {
    // 默认先查询知识库，再查询设备
    const stages: ExecutionStage[] = [];

    // 阶段 1：知识库查询
    if (!skillContext?.allowedTools.length || skillContext.allowedTools.includes('knowledge_search')) {
      stages.push({
        stageId: `${planId}_stage_0`,
        order: 0,
        toolCalls: [
          {
            toolName: 'knowledge_search',
            paramsTemplate: { query: message.substring(0, 200) },
            purpose: '查询相关知识',
            optional: false,
          },
        ],
        dependsOnStages: [],
      });
    }

    // 阶段 2：设备查询
    if (!skillContext?.allowedTools.length || skillContext.allowedTools.includes('device_query')) {
      stages.push({
        stageId: `${planId}_stage_1`,
        order: 1,
        toolCalls: [
          {
            toolName: 'device_query',
            paramsTemplate: { command: '/system/resource' },
            purpose: '获取系统状态',
            optional: false,
          },
        ],
        dependsOnStages: stages.length > 0 ? [`${planId}_stage_0`] : [],
      });
    }

    const estimatedToolCalls = stages.reduce(
      (sum, stage) => sum + stage.toolCalls.length,
      0
    );

    return {
      planId,
      stages,
      estimatedToolCalls,
      estimatedDuration: estimatedToolCalls * 2000,
      maxParallelism: Math.max(1, ...stages.map(s => s.toolCalls.length)),
      createdAt: Date.now(),
    };
  }

  /**
   * 替换参数中的占位符
   */
  private substituteParams(
    params: Record<string, unknown>,
    message: string
  ): Record<string, unknown> {
    const result: Record<string, unknown> = {};

    for (const [key, value] of Object.entries(params)) {
      if (typeof value === 'string' && value.includes('{{')) {
        // 替换占位符
        result[key] = value.replace(/\{\{(\w+)\}\}/g, (_, placeholder) => {
          if (placeholder === 'issue' || placeholder === 'query') {
            return message.substring(0, 200);
          }
          return placeholder;
        });
      } else {
        result[key] = value;
      }
    }

    return result;
  }

  /**
   * 分析中间结果，决定是否需要修订计划
   * Requirements: 3.3.1, 3.3.2, 3.3.3
   */
  private analyzeIntermediateResults(results: MergedObservation[]): boolean {
    const triggers = this.config.revisionTriggers || DEFAULT_REVISION_TRIGGERS;

    // 如果禁用自动修订，直接返回 false
    if (!triggers.autoRevisionEnabled) {
      return false;
    }

    // 计算总体失败率
    let totalCalls = 0;
    let failedCalls = 0;
    for (const result of results) {
      totalCalls += result.results.length;
      failedCalls += result.failureCount;
    }

    // 检查失败率是否超过阈值
    if (totalCalls > 0) {
      const failureRate = failedCalls / totalCalls;
      if (failureRate >= triggers.failureRateThreshold) {
        logger.debug('Revision triggered by failure rate', { failureRate, threshold: triggers.failureRateThreshold });
        return true;
      }
    }

    // 检查结果中是否包含触发关键词
    for (const result of results) {
      const text = (result.formattedText || '').toLowerCase();
      for (const keyword of triggers.triggerKeywords) {
        if (text.includes(keyword.toLowerCase())) {
          logger.debug('Revision triggered by keyword', { keyword });
          return true;
        }
      }
    }

    return false;
  }

  /**
   * 检查是否应该触发修订
   * Requirements: 3.3.4
   * 
   * @param evaluation 阶段评估结果
   * @param revisionCount 当前修订次数
   * @returns 是否应该触发修订
   */
  shouldTriggerRevision(evaluation: StageEvaluationResult, revisionCount: number = 0): boolean {
    const triggers = this.config.revisionTriggers || DEFAULT_REVISION_TRIGGERS;

    // 检查是否超过最大修订次数
    if (revisionCount >= triggers.maxRevisions) {
      logger.debug('Max revisions reached', { revisionCount, maxRevisions: triggers.maxRevisions });
      return false;
    }

    // 检查是否禁用自动修订
    if (!triggers.autoRevisionEnabled) {
      return false;
    }

    // 检查质量评分
    if (evaluation.qualityScore < triggers.qualityScoreThreshold) {
      logger.debug('Revision triggered by quality score', { 
        qualityScore: evaluation.qualityScore, 
        threshold: triggers.qualityScoreThreshold 
      });
      return true;
    }

    // 检查评估结果是否标记需要修订
    return evaluation.needsRevision;
  }

  /**
   * 获取修订触发配置
   */
  getRevisionTriggerConfig(): RevisionTriggerConfig {
    return { ...(this.config.revisionTriggers || DEFAULT_REVISION_TRIGGERS) };
  }

  /**
   * 更新修订触发配置
   * Requirements: 3.3.4
   */
  updateRevisionTriggerConfig(config: Partial<RevisionTriggerConfig>): void {
    this.config.revisionTriggers = {
      ...(this.config.revisionTriggers || DEFAULT_REVISION_TRIGGERS),
      ...config,
    };
    logger.debug('Revision trigger config updated', { config: this.config.revisionTriggers });
  }

  /**
   * 根据中间结果生成额外阶段
   */
  private generateAdditionalStages(results: MergedObservation[]): ExecutionStage[] {
    const additionalStages: ExecutionStage[] = [];

    // 分析失败的调用，生成重试阶段
    for (const result of results) {
      const failedCalls = result.results.filter(r => !r.success);
      if (failedCalls.length > 0) {
        additionalStages.push({
          stageId: `retry_${Date.now()}`,
          order: 100, // 高序号表示后续阶段
          toolCalls: failedCalls.map(call => ({
            toolName: call.toolName,
            paramsTemplate: {},
            purpose: `重试失败的 ${call.toolName} 调用`,
            optional: true,
          })),
          dependsOnStages: [],
        });
      }
    }

    return additionalStages;
  }

  /**
   * 创建超时
   */
  private createTimeout(planId: string): Promise<never> {
    return new Promise((_, reject) => {
      setTimeout(() => {
        reject(new ParallelExecutionError(
          ParallelExecutionErrorType.PLANNING_ERROR,
          `Plan generation timeout for ${planId}`,
          { planId, timeout: this.config.timeout },
          true
        ));
      }, this.config.timeout);
    });
  }
}

// 导出单例实例
export const executionPlanner = new ExecutionPlanner();
