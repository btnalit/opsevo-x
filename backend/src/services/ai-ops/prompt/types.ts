/**
 * Prompt 模块化架构 - 核心类型定义
 *
 * 定义 PromptModule、DynamicContext、ComposeOptions 等核心接口，
 * 作为模块化 Prompt 系统的基础类型约束。
 *
 * @see Requirements 1.1 - PromptModule 统一模块接口
 * @see Requirements 4.1 - DynamicContext 动态上下文注入
 */

/**
 * Prompt 模块接口
 *
 * 每个模块封装一个独立的 Prompt 职责（如人设定义、ReAct 格式、API 安全规则等），
 * 通过 PromptComposer 按需组合为完整的 Prompt。
 *
 * @see Requirements 1.1 - 定义统一的模块接口，包含模块名称、Token 预算、内容生成方法和依赖声明
 */
export interface PromptModule {
  /** 模块唯一名称 */
  readonly name: string;

  /** Token 预算上限 */
  readonly tokenBudget: number;

  /** 依赖的其他模块名称 */
  readonly dependencies: string[];

  /** 生成模块内容 */
  render(context?: Record<string, unknown>): string;

  /** 模块在 PromptTemplateService 中注册的子模板名称 */
  readonly templateName?: string;
}

/**
 * 动态上下文接口
 *
 * 运行时动态注入到 Prompt 中的上下文信息，包含设备健康评分、
 * 风险指标、活跃告警和异常预测结果。
 *
 * @see Requirements 4.1 - injectContext 方法接受 DynamicContext 对象
 * @see Requirements 4.2 - 健康评分低于 60 时注入健康状态摘要
 * @see Requirements 4.3 - 存在活跃告警时注入最近 5 条告警摘要
 * @see Requirements 4.4 - 存在预测结果时注入预测摘要
 */
export interface DynamicContext {
  /** 设备健康评分 (0-100) */
  healthScore?: number;

  /** 主要风险指标 */
  riskIndicators?: string[];

  /** 最近活跃告警 (最多5条) */
  activeAlerts?: Array<{
    name: string;
    severity: string;
    message: string;
  }>;

  /** 异常预测结果 */
  anomalyPredictions?: Array<{
    type: string;
    confidence: number;
    description: string;
  }>;

  /** 历史改进建议 (来自 CriticService) */
  improvementSuggestions?: Array<{
    advice: string;
    reason: string;
  }>;

  /** 工具历史执行统计 (来自 ToolFeedbackCollector) */
  toolStats?: Array<{
    toolName: string;
    successRate: number;
    totalCalls: number;
  }>;
}

/**
 * Prompt 组合选项
 *
 * 控制 PromptComposer.compose() 的行为，包括模板变量替换和去重选项。
 *
 * @see Requirements 1.2 - compose 方法接受模块列表并按声明顺序组合
 * @see Requirements 1.3 - 自动去除模块间的重复内容段落
 */
export interface ComposeOptions {
  /** 模板变量替换 */
  variables?: Record<string, string>;

  /** 是否启用去重 */
  deduplication?: boolean;
}
