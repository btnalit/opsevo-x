/**
 * AdaptiveModeSelector - 自适应模式选择器
 * 
 * 根据任务特征自动选择最优执行模式
 * 
 * Requirements: 4.1, 4.2, 4.3, 4.4, 4.5, 4.6, 4.7
 * - 4.1: 分析查询并选择执行模式
 * - 4.2: 简单查询选择串行模式
 * - 4.3: 中等复杂度选择并行模式
 * - 4.4: 高复杂度选择计划模式
 * - 4.5: 考虑 Skill 上下文
 * - 4.6: 50ms 内完成模式选择
 * - 4.7: 支持手动模式覆盖
 */

import { logger } from '../../../utils/logger';
import {
  ExecutionMode,
  ModeSelectionResult,
  ComplexityAnalysis,
} from '../../../types/parallel-execution';
import { SkillContext } from './reactLoopController';

/**
 * 模式选择配置
 */
export interface ModeSelectorConfig {
  /** 简单查询阈值（预估工具调用数） */
  simpleThreshold: number;
  /** 复杂查询阈值 */
  complexThreshold: number;
  /** 是否启用自动模式选择 */
  autoSelect: boolean;
  /** 模式选择超时（毫秒） */
  timeout: number;
}

/**
 * 默认配置
 */
const DEFAULT_CONFIG: ModeSelectorConfig = {
  simpleThreshold: 2,
  complexThreshold: 4,
  autoSelect: true,
  timeout: 50,
};

/**
 * 复杂度关键词
 */
const COMPLEXITY_KEYWORDS = {
  simple: [
    '查看', '显示', '获取', '状态', '是什么', '多少',
    'show', 'get', 'status', 'what', 'how many',
  ],
  moderate: [
    '检查', '分析', '比较', '诊断', '排查',
    'check', 'analyze', 'compare', 'diagnose', 'troubleshoot',
  ],
  complex: [
    '配置', '修改', '优化', '迁移', '部署', '故障', '全面',
    '所有', '批量', '多个', '同时',
    'configure', 'modify', 'optimize', 'migrate', 'deploy', 'fault',
    'all', 'batch', 'multiple', 'simultaneously',
  ],
};

/**
 * 工具数量估算关键词
 */
const TOOL_COUNT_INDICATORS = {
  single: ['单个', '一个', '这个', 'single', 'one', 'this'],
  multiple: ['多个', '几个', '所有', '批量', 'multiple', 'several', 'all', 'batch'],
  comprehensive: ['全面', '完整', '详细', '深入', 'comprehensive', 'complete', 'detailed', 'thorough'],
};

/**
 * AdaptiveModeSelector 类
 * 根据任务特征选择执行模式
 */
export class AdaptiveModeSelector {
  private config: ModeSelectorConfig;
  private modeOverride: ExecutionMode | null = null;

  constructor(config?: Partial<ModeSelectorConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    logger.debug('AdaptiveModeSelector initialized', { config: this.config });
  }

  /**
   * 选择执行模式
   * Requirements: 4.1, 4.2, 4.3, 4.4, 4.5, 4.6
   * 
   * @param message 用户消息
   * @param skillContext 可选的 Skill 上下文
   * @returns 模式选择结果
   */
  selectMode(
    message: string,
    skillContext?: SkillContext
  ): ModeSelectionResult {
    const startTime = Date.now();

    // 检查手动覆盖
    if (this.modeOverride !== null) {
      return {
        mode: this.modeOverride,
        confidence: 1.0,
        reason: 'Manual mode override',
        estimatedToolCalls: 0,
        estimatedParallelism: 1,
      };
    }

    // 如果禁用自动选择，默认使用串行模式
    if (!this.config.autoSelect) {
      return {
        mode: ExecutionMode.SEQUENTIAL,
        confidence: 1.0,
        reason: 'Auto-select disabled',
        estimatedToolCalls: 1,
        estimatedParallelism: 1,
      };
    }

    // 分析复杂度
    const complexity = this.analyzeComplexity(message);

    // 考虑 Skill 上下文
    const adjustedComplexity = this.adjustForSkillContext(complexity, skillContext);

    // 根据复杂度选择模式
    const result = this.selectModeByComplexity(adjustedComplexity);

    // 检查超时
    const elapsed = Date.now() - startTime;
    if (elapsed > this.config.timeout) {
      logger.warn('Mode selection exceeded timeout', {
        elapsed,
        timeout: this.config.timeout,
      });
    }

    logger.debug('Mode selected', {
      mode: result.mode,
      confidence: result.confidence,
      complexity: adjustedComplexity.complexity,
      estimatedToolCalls: result.estimatedToolCalls,
      elapsed,
    });

    return result;
  }

  /**
   * 分析查询复杂度
   * Requirements: 4.2, 4.3, 4.4
   * 
   * @param message 用户消息
   * @returns 复杂度分析结果
   */
  analyzeComplexity(message: string): ComplexityAnalysis {
    const startTime = Date.now();
    const lowerMessage = message.toLowerCase();
    const detectedKeywords: string[] = [];

    // 计算各复杂度级别的匹配分数
    let simpleScore = 0;
    let moderateScore = 0;
    let complexScore = 0;

    for (const keyword of COMPLEXITY_KEYWORDS.simple) {
      if (lowerMessage.includes(keyword.toLowerCase())) {
        simpleScore++;
        detectedKeywords.push(keyword);
      }
    }

    for (const keyword of COMPLEXITY_KEYWORDS.moderate) {
      if (lowerMessage.includes(keyword.toLowerCase())) {
        moderateScore++;
        detectedKeywords.push(keyword);
      }
    }

    for (const keyword of COMPLEXITY_KEYWORDS.complex) {
      if (lowerMessage.includes(keyword.toLowerCase())) {
        complexScore++;
        detectedKeywords.push(keyword);
      }
    }

    // 估算工具调用数
    let estimatedToolCalls = 1;

    for (const keyword of TOOL_COUNT_INDICATORS.single) {
      if (lowerMessage.includes(keyword.toLowerCase())) {
        estimatedToolCalls = Math.max(estimatedToolCalls, 1);
      }
    }

    for (const keyword of TOOL_COUNT_INDICATORS.multiple) {
      if (lowerMessage.includes(keyword.toLowerCase())) {
        estimatedToolCalls = Math.max(estimatedToolCalls, 3);
      }
    }

    for (const keyword of TOOL_COUNT_INDICATORS.comprehensive) {
      if (lowerMessage.includes(keyword.toLowerCase())) {
        estimatedToolCalls = Math.max(estimatedToolCalls, 5);
      }
    }

    // 根据分数确定复杂度
    let complexity: 'simple' | 'moderate' | 'complex';
    
    if (complexScore > moderateScore && complexScore > simpleScore) {
      complexity = 'complex';
      estimatedToolCalls = Math.max(estimatedToolCalls, this.config.complexThreshold);
    } else if (moderateScore > simpleScore) {
      complexity = 'moderate';
      estimatedToolCalls = Math.max(estimatedToolCalls, this.config.simpleThreshold);
    } else {
      complexity = 'simple';
    }

    // 消息长度也是复杂度的指标
    if (message.length > 200) {
      estimatedToolCalls = Math.max(estimatedToolCalls, 2);
      if (complexity === 'simple') {
        complexity = 'moderate';
      }
    }

    return {
      complexity,
      estimatedToolCalls,
      keywords: detectedKeywords,
      analysisTime: Date.now() - startTime,
    };
  }

  /**
   * 设置手动模式覆盖
   * Requirements: 4.7
   * 
   * @param mode 要覆盖的模式，null 表示取消覆盖
   */
  setModeOverride(mode: ExecutionMode | null): void {
    this.modeOverride = mode;
    logger.info('Mode override set', { mode });
  }

  /**
   * 获取当前模式覆盖
   */
  getModeOverride(): ExecutionMode | null {
    return this.modeOverride;
  }

  /**
   * 更新配置
   */
  updateConfig(config: Partial<ModeSelectorConfig>): void {
    this.config = { ...this.config, ...config };
    logger.debug('AdaptiveModeSelector config updated', { config: this.config });
  }

  /**
   * 获取配置
   */
  getConfig(): ModeSelectorConfig {
    return { ...this.config };
  }

  // ==================== 私有方法 ====================

  /**
   * 根据 Skill 上下文调整复杂度
   * Requirements: 4.5
   */
  private adjustForSkillContext(
    complexity: ComplexityAnalysis,
    skillContext?: SkillContext
  ): ComplexityAnalysis {
    if (!skillContext) {
      return complexity;
    }

    const adjusted = { ...complexity };

    // 根据允许的工具数量调整估算
    if (skillContext.allowedTools.length > 0) {
      // 如果 Skill 限制了工具，可能需要更多调用来完成任务
      if (skillContext.allowedTools.length < 3) {
        adjusted.estimatedToolCalls = Math.min(adjusted.estimatedToolCalls, 2);
      }
    }

    // 根据工具优先级调整
    if (skillContext.toolPriority.length > 3) {
      // 多个优先工具可能意味着更复杂的任务
      adjusted.estimatedToolCalls = Math.max(adjusted.estimatedToolCalls, 3);
      if (adjusted.complexity === 'simple') {
        adjusted.complexity = 'moderate';
      }
    }

    return adjusted;
  }

  /**
   * 根据复杂度选择模式
   */
  private selectModeByComplexity(complexity: ComplexityAnalysis): ModeSelectionResult {
    const { estimatedToolCalls } = complexity;

    // 简单查询：串行模式
    if (complexity.complexity === 'simple' || estimatedToolCalls <= this.config.simpleThreshold) {
      return {
        mode: ExecutionMode.SEQUENTIAL,
        confidence: 0.8,
        reason: `Simple query with estimated ${estimatedToolCalls} tool calls`,
        estimatedToolCalls,
        estimatedParallelism: 1,
      };
    }

    // 中等复杂度：并行模式
    if (complexity.complexity === 'moderate' || estimatedToolCalls <= this.config.complexThreshold) {
      return {
        mode: ExecutionMode.PARALLEL,
        confidence: 0.7,
        reason: `Moderate complexity with estimated ${estimatedToolCalls} tool calls`,
        estimatedToolCalls,
        estimatedParallelism: Math.min(estimatedToolCalls, 3),
      };
    }

    // 高复杂度：计划模式
    return {
      mode: ExecutionMode.PLANNED,
      confidence: 0.6,
      reason: `Complex query with estimated ${estimatedToolCalls} tool calls`,
      estimatedToolCalls,
      estimatedParallelism: Math.min(estimatedToolCalls, 5),
    };
  }
}

// 导出单例实例
export const adaptiveModeSelector = new AdaptiveModeSelector();
