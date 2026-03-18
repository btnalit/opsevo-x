/**
 * SkillAwareToolSelector - Skill 感知的工具选择器
 * 
 * 根据 Skill 配置过滤和约束工具
 * 
 * Requirements: 8.1-8.8
 * - 8.1: 工具白名单过滤
 * - 8.2: 工具优先级排序
 * - 8.3: 默认参数应用
 * - 8.4: 参数约束验证
 * - 8.5: 工具可用性检查
 * - 8.6: 工具调用拦截
 * - 8.7: 参数自动补全
 * - 8.8: 约束违规处理
 * 
 * AI-OPS 智能进化系统扩展 (Requirements: 4.2.1, 4.2.2, 4.2.3, 4.2.4)
 * - 4.2.1: 基于指标的工具优先级优化
 * - 4.2.2: 得分计算和排序逻辑
 * - 4.2.3: 熔断器状态检查
 * - 4.2.4: 动态优先级调整
 */

import { logger } from '../../../utils/logger';
import { Skill, ToolConstraint } from '../../../types/skill';
import { skillMetrics, ToolUsageMetrics } from './skillMetrics';

/**
 * Agent 工具接口（与 mastraAgent 兼容）
 */
export interface AgentTool {
  name: string;
  description: string;
  parameters?: Record<string, unknown>;
  execute?: (params: Record<string, unknown>) => Promise<unknown>;
}

/**
 * 参数验证结果
 */
export interface ParamValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
  correctedParams?: Record<string, unknown>;
}

/**
 * 工具选择结果
 */
export interface ToolSelectionResult {
  tools: AgentTool[];
  filtered: string[];
  prioritized: boolean;
  /** 被熔断排除的工具 (Requirements: 4.2.3) */
  circuitBroken?: string[];
  /** 工具得分详情 (Requirements: 4.2.2) */
  scores?: Record<string, number>;
}

/**
 * 工具优先级配置
 * Requirements: 4.2.1, 4.2.4
 */
export interface ToolPriorityConfig {
  /** 是否启用基于指标的优先级 */
  enableMetricsPriority: boolean;
  /** 健康度权重 (0-1) */
  healthWeight: number;
  /** 成功率权重 (0-1) */
  successRateWeight: number;
  /** 响应时间权重 (0-1) */
  responseTimeWeight: number;
  /** 是否排除熔断工具 */
  excludeCircuitBroken: boolean;
  /** 最低健康度阈值 */
  minHealthScore: number;
}

/**
 * SkillAwareToolSelector 类
 * Skill 感知的工具选择器
 */
export class SkillAwareToolSelector {
  /** 工具优先级配置 (Requirements: 4.2.1) */
  private priorityConfig: ToolPriorityConfig = {
    enableMetricsPriority: true,
    healthWeight: 0.4,
    successRateWeight: 0.4,
    responseTimeWeight: 0.2,
    excludeCircuitBroken: true,
    minHealthScore: 20,
  };

  constructor() {
    logger.debug('SkillAwareToolSelector created');
  }

  /**
   * 设置优先级配置
   * Requirements: 4.2.4
   */
  setPriorityConfig(config: Partial<ToolPriorityConfig>): void {
    this.priorityConfig = { ...this.priorityConfig, ...config };
    logger.debug('Tool priority config updated', { config: this.priorityConfig });
  }

  /**
   * 获取优先级配置
   */
  getPriorityConfig(): ToolPriorityConfig {
    return { ...this.priorityConfig };
  }

  /**
   * 过滤可用工具
   * Requirements: 8.1, 8.2, 4.2.1, 4.2.2, 4.2.3
   * 
   * @param allTools 所有可用工具
   * @param skill 当前 Skill
   * @param useMetricsPriority 是否使用基于指标的优先级（覆盖配置）
   * @returns 过滤和排序后的工具列表
   */
  filterTools(
    allTools: AgentTool[], 
    skill: Skill,
    useMetricsPriority?: boolean
  ): ToolSelectionResult {
    const allowedTools = skill.config.allowedTools;
    const filtered: string[] = [];
    const circuitBroken: string[] = [];
    const scores: Record<string, number> = {};

    // 如果没有配置白名单，使用所有工具
    let candidateTools = allTools;
    if (allowedTools && allowedTools.length > 0) {
      candidateTools = allTools.filter(t => {
        const allowed = allowedTools.includes(t.name);
        if (!allowed) {
          filtered.push(t.name);
        }
        return allowed;
      });
    }

    // 检查熔断状态并排除 (Requirements: 4.2.3)
    const enableMetrics = useMetricsPriority ?? this.priorityConfig.enableMetricsPriority;
    if (enableMetrics && this.priorityConfig.excludeCircuitBroken) {
      candidateTools = candidateTools.filter(t => {
        const metrics = skillMetrics.getToolMetrics(t.name);
        if (metrics?.circuitBreakerOpen) {
          circuitBroken.push(t.name);
          logger.debug('Tool excluded due to circuit breaker', { toolName: t.name });
          return false;
        }
        // 检查最低健康度
        if (metrics && metrics.healthScore < this.priorityConfig.minHealthScore) {
          circuitBroken.push(t.name);
          logger.debug('Tool excluded due to low health score', { 
            toolName: t.name, 
            healthScore: metrics.healthScore 
          });
          return false;
        }
        return true;
      });
    }

    // 按优先级排序
    let prioritizedTools: AgentTool[];
    let prioritized = false;

    if (enableMetrics) {
      // 使用基于指标的优先级排序 (Requirements: 4.2.2)
      prioritizedTools = this.sortByMetricsPriority(candidateTools, skill, scores);
      prioritized = true;
    } else {
      // 使用 Skill 配置的优先级
      const priority = skill.config.toolPriority || [];
      prioritizedTools = this.sortByPriority(candidateTools, priority);
      prioritized = priority.length > 0;
    }

    logger.debug('Tools filtered for Skill', {
      skill: skill.metadata.name,
      total: allTools.length,
      allowed: prioritizedTools.length,
      filtered: filtered.length,
      circuitBroken: circuitBroken.length,
      useMetricsPriority: enableMetrics,
    });

    return {
      tools: prioritizedTools,
      filtered,
      prioritized,
      circuitBroken: circuitBroken.length > 0 ? circuitBroken : undefined,
      scores: Object.keys(scores).length > 0 ? scores : undefined,
    };
  }

  /**
   * 基于指标的优先级排序
   * Requirements: 4.2.2
   */
  private sortByMetricsPriority(
    tools: AgentTool[], 
    skill: Skill,
    scores: Record<string, number>
  ): AgentTool[] {
    const skillPriority = skill.config.toolPriority || [];
    
    // 计算每个工具的综合得分
    const toolsWithScores = tools.map(tool => {
      const score = this.calculateToolScore(tool.name, skillPriority);
      scores[tool.name] = score;
      return { tool, score };
    });

    // 按得分降序排序
    toolsWithScores.sort((a, b) => b.score - a.score);

    return toolsWithScores.map(t => t.tool);
  }

  /**
   * 计算工具综合得分
   * Requirements: 4.2.2
   * 
   * 得分计算公式：
   * score = healthScore * healthWeight + 
   *         successRate * 100 * successRateWeight + 
   *         responseTimeScore * responseTimeWeight +
   *         skillPriorityBonus
   */
  calculateToolScore(toolName: string, skillPriority: string[] = []): number {
    const metrics = skillMetrics.getToolMetrics(toolName);
    
    // 基础分数（没有指标时）
    let baseScore = 50;
    
    if (metrics) {
      // 健康度分数 (0-100)
      const healthScore = metrics.healthScore * this.priorityConfig.healthWeight;
      
      // 成功率分数 (0-100)
      const successScore = metrics.successRate * 100 * this.priorityConfig.successRateWeight;
      
      // 响应时间分数 (0-100，响应时间越短分数越高)
      // 假设 1000ms 为理想响应时间，5000ms 为最大可接受时间
      const responseTimeScore = this.calculateResponseTimeScore(metrics.avgResponseTime) 
        * this.priorityConfig.responseTimeWeight;
      
      baseScore = healthScore + successScore + responseTimeScore;
    }
    
    // Skill 配置的优先级加成
    const priorityIndex = skillPriority.indexOf(toolName);
    let priorityBonus = 0;
    if (priorityIndex !== -1) {
      // 优先级越高（索引越小），加成越大
      priorityBonus = Math.max(0, 20 - priorityIndex * 2);
    }
    
    return Math.round(baseScore + priorityBonus);
  }

  /**
   * 计算响应时间得分
   * Requirements: 4.2.2
   */
  private calculateResponseTimeScore(avgResponseTime: number): number {
    if (avgResponseTime <= 0) return 100;
    if (avgResponseTime <= 1000) return 100;
    if (avgResponseTime >= 5000) return 0;
    
    // 线性插值：1000ms -> 100分，5000ms -> 0分
    return Math.round(100 - (avgResponseTime - 1000) / 40);
  }

  /**
   * 获取工具健康状态摘要
   * Requirements: 4.2.3
   */
  getToolHealthSummary(toolNames: string[]): Record<string, { healthy: boolean; score: number; reason?: string }> {
    const summary: Record<string, { healthy: boolean; score: number; reason?: string }> = {};
    
    for (const toolName of toolNames) {
      const metrics = skillMetrics.getToolMetrics(toolName);
      if (!metrics) {
        summary[toolName] = { healthy: true, score: 50, reason: '无历史数据' };
        continue;
      }
      
      let healthy = true;
      let reason: string | undefined;
      
      if (metrics.circuitBreakerOpen) {
        healthy = false;
        reason = '熔断器已开启';
      } else if (metrics.healthScore < this.priorityConfig.minHealthScore) {
        healthy = false;
        reason = `健康度过低 (${metrics.healthScore})`;
      } else if (metrics.successRate < 0.5) {
        healthy = false;
        reason = `成功率过低 (${(metrics.successRate * 100).toFixed(1)}%)`;
      }
      
      summary[toolName] = { healthy, score: metrics.healthScore, reason };
    }
    
    return summary;
  }

  /**
   * 推荐替代工具
   * Requirements: 4.2.4
   * 
   * 当某个工具不可用时，推荐功能相似的替代工具
   */
  recommendAlternatives(
    unavailableTool: string, 
    allTools: AgentTool[], 
    skill: Skill
  ): AgentTool[] {
    // 获取可用工具
    const result = this.filterTools(allTools, skill);
    
    // 排除不可用的工具
    const availableTools = result.tools.filter(t => t.name !== unavailableTool);
    
    // 返回前 3 个最高分的工具作为替代
    return availableTools.slice(0, 3);
  }

  /**
   * 应用工具默认参数
   * Requirements: 8.3, 8.7
   * 
   * @param toolName 工具名称
   * @param params 用户提供的参数
   * @param skill 当前 Skill
   * @returns 合并后的参数
   */
  applyDefaults(
    toolName: string,
    params: Record<string, unknown>,
    skill: Skill
  ): Record<string, unknown> {
    const defaults = skill.config.toolDefaults[toolName] || {};
    
    // 默认值在前，用户参数覆盖
    const merged = { ...defaults, ...params };

    logger.debug('Applied tool defaults', {
      toolName,
      defaults: Object.keys(defaults),
      userParams: Object.keys(params),
      merged: Object.keys(merged),
    });

    return merged;
  }

  /**
   * 验证工具参数
   * Requirements: 8.4, 8.8
   * 
   * @param toolName 工具名称
   * @param params 参数
   * @param skill 当前 Skill
   * @returns 验证结果
   */
  validateParams(
    toolName: string,
    params: Record<string, unknown>,
    skill: Skill
  ): ParamValidationResult {
    const constraints = skill.config.toolConstraints[toolName] || {};
    const errors: string[] = [];
    const warnings: string[] = [];
    const correctedParams = { ...params };

    for (const [paramName, constraint] of Object.entries(constraints)) {
      const value = params[paramName];
      const validationResult = this.validateSingleParam(
        paramName,
        value,
        constraint,
        correctedParams
      );

      errors.push(...validationResult.errors);
      warnings.push(...validationResult.warnings);
    }

    const valid = errors.length === 0;

    if (!valid) {
      logger.warn('Tool parameter validation failed', {
        toolName,
        errors,
      });
    }

    return {
      valid,
      errors,
      warnings,
      correctedParams: valid ? correctedParams : undefined,
    };
  }

  /**
   * 验证单个参数
   */
  private validateSingleParam(
    paramName: string,
    value: unknown,
    constraint: ToolConstraint,
    correctedParams: Record<string, unknown>
  ): { errors: string[]; warnings: string[] } {
    const errors: string[] = [];
    const warnings: string[] = [];

    // 检查必需参数
    if (constraint.required && value === undefined) {
      // 如果有默认值，自动应用
      if (constraint.defaultValue !== undefined) {
        correctedParams[paramName] = constraint.defaultValue;
        warnings.push(`参数 ${paramName} 未提供，已使用默认值: ${constraint.defaultValue}`);
      } else {
        errors.push(`参数 ${paramName} 是必需的`);
      }
      return { errors, warnings };
    }

    if (value === undefined) {
      // 应用默认值
      if (constraint.defaultValue !== undefined) {
        correctedParams[paramName] = constraint.defaultValue;
      }
      return { errors, warnings };
    }

    // 检查允许的值
    if (constraint.allowedValues && !constraint.allowedValues.includes(value)) {
      // 如果有默认值且默认值在允许列表中，使用默认值
      if (constraint.defaultValue !== undefined && 
          constraint.allowedValues.includes(constraint.defaultValue)) {
        correctedParams[paramName] = constraint.defaultValue;
        warnings.push(
          `参数 ${paramName} 的值 ${value} 不在允许范围内，已使用默认值: ${constraint.defaultValue}`
        );
      } else {
        errors.push(
          `参数 ${paramName} 的值 ${value} 不在允许范围内 (允许: ${constraint.allowedValues.join(', ')})`
        );
      }
    }

    // 检查数值范围
    if (typeof value === 'number') {
      if (constraint.minValue !== undefined && value < constraint.minValue) {
        errors.push(
          `参数 ${paramName} 的值 ${value} 小于最小值 ${constraint.minValue}`
        );
      }
      if (constraint.maxValue !== undefined && value > constraint.maxValue) {
        errors.push(
          `参数 ${paramName} 的值 ${value} 大于最大值 ${constraint.maxValue}`
        );
      }
    }

    return { errors, warnings };
  }

  /**
   * 检查工具是否允许
   * Requirements: 8.5
   * 
   * @param toolName 工具名称
   * @param skill 当前 Skill
   * @returns 是否允许
   */
  isToolAllowed(toolName: string, skill: Skill): boolean {
    const allowedTools = skill.config.allowedTools;

    // 如果没有配置白名单，允许所有工具
    if (!allowedTools || allowedTools.length === 0) {
      return true;
    }

    return allowedTools.includes(toolName);
  }

  /**
   * 拦截工具调用
   * Requirements: 8.6
   * 
   * @param toolName 工具名称
   * @param params 参数
   * @param skill 当前 Skill
   * @returns 处理后的参数或 null（如果不允许调用）
   */
  interceptToolCall(
    toolName: string,
    params: Record<string, unknown>,
    skill: Skill
  ): { allowed: boolean; params?: Record<string, unknown>; reason?: string } {
    // 检查工具是否允许
    if (!this.isToolAllowed(toolName, skill)) {
      return {
        allowed: false,
        reason: `工具 ${toolName} 不在当前 Skill (${skill.metadata.name}) 的允许列表中`,
      };
    }

    // 应用默认参数
    const paramsWithDefaults = this.applyDefaults(toolName, params, skill);

    // 验证参数
    const validation = this.validateParams(toolName, paramsWithDefaults, skill);

    if (!validation.valid) {
      return {
        allowed: false,
        reason: `参数验证失败: ${validation.errors.join('; ')}`,
      };
    }

    // 使用修正后的参数
    return {
      allowed: true,
      params: validation.correctedParams || paramsWithDefaults,
    };
  }

  /**
   * 获取工具的约束信息
   */
  getToolConstraints(toolName: string, skill: Skill): Record<string, ToolConstraint> {
    return skill.config.toolConstraints[toolName] || {};
  }

  /**
   * 获取工具的默认参数
   */
  getToolDefaults(toolName: string, skill: Skill): Record<string, unknown> {
    return skill.config.toolDefaults[toolName] || {};
  }

  /**
   * 获取工具优先级
   */
  getToolPriority(skill: Skill): string[] {
    return skill.config.toolPriority || [];
  }

  /**
   * 检查是否有工具约束
   */
  hasConstraints(toolName: string, skill: Skill): boolean {
    const constraints = skill.config.toolConstraints[toolName];
    return constraints !== undefined && Object.keys(constraints).length > 0;
  }

  /**
   * 按 Skill 配置的优先级排序工具
   * Requirements: 8.2
   * 
   * @param tools 工具列表
   * @param priority 优先级配置（工具名称数组，索引越小优先级越高）
   * @returns 排序后的工具列表
   */
  private sortByPriority(tools: AgentTool[], priority: string[]): AgentTool[] {
    if (priority.length === 0) {
      return tools;
    }

    return [...tools].sort((a, b) => {
      const aIndex = priority.indexOf(a.name);
      const bIndex = priority.indexOf(b.name);

      // 不在优先级列表中的工具排在最后
      if (aIndex === -1 && bIndex === -1) return 0;
      if (aIndex === -1) return 1;
      if (bIndex === -1) return -1;

      return aIndex - bIndex;
    });
  }
}

// 导出单例实例
export const skillAwareToolSelector = new SkillAwareToolSelector();
