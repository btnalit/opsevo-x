/**
 * Summarization Types - 智能摘要相关类型定义
 * 
 * Requirements: 4.3
 * - 定义 SummarizationErrorCode 枚举
 * - 定义 SummarizationError 类
 */

/**
 * 摘要错误代码枚举
 */
export enum SummarizationErrorCode {
  /** 格式化失败 */
  FORMAT_ERROR = 'FORMAT_ERROR',
  /** Token 估算失败 */
  TOKEN_ESTIMATION_ERROR = 'TOKEN_ESTIMATION_ERROR',
  /** JSON 解析失败 */
  JSON_PARSE_ERROR = 'JSON_PARSE_ERROR',
  /** 预算分配失败 */
  BUDGET_ALLOCATION_ERROR = 'BUDGET_ALLOCATION_ERROR',
  /** 配置无效 */
  INVALID_CONFIG = 'INVALID_CONFIG',
}

/**
 * 摘要错误类
 */
export class SummarizationError extends Error {
  public readonly code: SummarizationErrorCode;
  public readonly originalError?: Error;

  constructor(
    code: SummarizationErrorCode,
    message: string,
    originalError?: Error
  ) {
    super(message);
    this.name = 'SummarizationError';
    this.code = code;
    this.originalError = originalError;
    
    // 保持原型链
    Object.setPrototypeOf(this, SummarizationError.prototype);
  }

  /**
   * 获取用户友好的错误消息
   */
  getUserFriendlyMessage(): string {
    switch (this.code) {
      case SummarizationErrorCode.FORMAT_ERROR:
        return '内容格式化失败，将使用简单截断';
      case SummarizationErrorCode.TOKEN_ESTIMATION_ERROR:
        return 'Token 估算失败，将使用默认估算';
      case SummarizationErrorCode.JSON_PARSE_ERROR:
        return 'JSON 解析失败，将作为文本处理';
      case SummarizationErrorCode.BUDGET_ALLOCATION_ERROR:
        return '预算分配失败，将使用默认比例';
      case SummarizationErrorCode.INVALID_CONFIG:
        return '配置无效，将使用默认配置';
      default:
        return this.message;
    }
  }
}

/**
 * 摘要配置接口
 */
export interface SummarizationConfig {
  /** 是否启用知识内容智能摘要 */
  knowledgeSummarizationEnabled?: boolean;
  /** 是否启用工具输出智能摘要 */
  toolOutputSummarizationEnabled?: boolean;
  /** 知识内容预算比例 (0-1)，默认 0.6 */
  knowledgeBudgetRatio?: number;
  /** 工具输出预算比例 (0-1)，默认 0.25 */
  toolsBudgetRatio?: number;
}

/**
 * 默认摘要配置
 */
export const DEFAULT_SUMMARIZATION_CONFIG: Required<SummarizationConfig> = {
  knowledgeSummarizationEnabled: true,
  toolOutputSummarizationEnabled: true,
  knowledgeBudgetRatio: 0.6,
  toolsBudgetRatio: 0.25,
};
