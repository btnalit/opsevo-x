/**
 * 输出验证类型定义
 * 
 * Requirements: 9.1, 9.2, 9.3, 9.4, 9.5, 10.1, 10.4, 10.5
 */

import { FormattedKnowledge } from './intelligentRetrieval';

// ==================== 知识引用类型 ====================

/**
 * 知识引用
 * Requirements: 9.1
 */
export interface KnowledgeReference {
  /** 完整引用文本，如 [KB-alert-abc12345] */
  fullText: string;
  /** 知识类型 */
  type: string;
  /** 短 ID (8位字母数字) */
  shortId: string;
  /** 在输出中的位置 */
  position: number;
}

/**
 * 引用 ID 格式正则表达式
 * 格式: [KB-{type}-{shortId}]
 * type: 小写字母
 * shortId: 8位字母数字
 * Requirements: 9.1, 14.1, 14.2, 14.3
 */
export const REFERENCE_ID_PATTERN = /\[KB-([a-z]+)-([a-zA-Z0-9]{8})\]/g;

/**
 * 单个引用 ID 格式正则（不带全局标志）
 */
export const SINGLE_REFERENCE_PATTERN = /^\[KB-([a-z]+)-([a-zA-Z0-9]{8})\]$/;

/**
 * 引用 ID 内部格式正则（不带方括号）
 */
export const REFERENCE_ID_INNER_PATTERN = /^KB-([a-z]+)-([a-zA-Z0-9]{8})$/;

// ==================== 知识上下文类型 ====================

/**
 * 知识上下文
 * Requirements: 9.2
 */
export interface KnowledgeContext {
  /** 当前会话中可用的知识 */
  availableKnowledge: Map<string, FormattedKnowledge>;
  /** 会话 ID */
  sessionId: string;
}

// ==================== 验证错误类型 ====================

/**
 * 验证错误类型
 * Requirements: 9.3, 9.4
 */
export type ValidationErrorType = 
  | 'invalid_format'      // 引用格式无效
  | 'missing_reference'   // 缺少引用
  | 'unknown_id';         // 引用 ID 不存在

/**
 * 验证错误
 * Requirements: 9.3
 */
export interface ValidationError {
  /** 错误类型 */
  type: ValidationErrorType;
  /** 错误消息 */
  message: string;
  /** 相关引用 */
  reference?: string;
  /** 错误位置 */
  position?: number;
}

/**
 * 验证警告
 */
export interface ValidationWarning {
  /** 警告类型 */
  type: 'low_credibility' | 'outdated_knowledge' | 'partial_match';
  /** 警告消息 */
  message: string;
  /** 相关引用 */
  reference?: string;
}

// ==================== 验证结果类型 ====================

/**
 * 引用验证结果
 * Requirements: 9.2
 */
export interface ReferenceValidationResult {
  /** 所有提取的引用 */
  allReferences: KnowledgeReference[];
  /** 有效引用 */
  validReferences: KnowledgeReference[];
  /** 无效引用 */
  invalidReferences: KnowledgeReference[];
  /** 验证详情 */
  details: Map<string, { valid: boolean; reason?: string }>;
}

/**
 * 验证结果
 * Requirements: 9.1, 9.2, 9.3, 9.4
 */
export interface ValidationResult {
  /** 是否验证通过 */
  isValid: boolean;
  /** 错误列表 */
  errors: ValidationError[];
  /** 警告列表 */
  warnings: ValidationWarning[];
  /** 提取的引用 */
  references: KnowledgeReference[];
  /** 有效引用 */
  validReferences: KnowledgeReference[];
  /** 无效引用 */
  invalidReferences: KnowledgeReference[];
  /** 验证时间戳 */
  validatedAt: number;
}

// ==================== 修正相关类型 ====================

/**
 * 修正提示词选项
 * Requirements: 10.1
 */
export interface CorrectionPromptOptions {
  /** 是否包含原始输出 */
  includeOriginalOutput: boolean;
  /** 是否包含错误详情 */
  includeErrorDetails: boolean;
  /** 最大错误数量 */
  maxErrors: number;
}

/**
 * 修正历史记录
 * Requirements: 10.5
 */
export interface CorrectionHistory {
  /** 会话 ID */
  sessionId: string;
  /** 原始输出 */
  originalOutput: string;
  /** 修正后的输出 */
  correctedOutput: string;
  /** 验证错误 */
  validationErrors: ValidationError[];
  /** 修正尝试次数 */
  correctionAttempts: number;
  /** 最终是否有效 */
  finallyValid: boolean;
  /** 时间戳 */
  timestamp: number;
}

// ==================== 验证器配置 ====================

/**
 * 输出验证器配置
 * Requirements: 9.5, 10.4
 */
export interface OutputValidatorConfig {
  /** 引用格式正则 */
  referencePattern: RegExp;
  /** 最大修正次数，默认 2 */
  maxCorrectionAttempts: number;
  /** 是否严格验证，默认 true */
  strictValidation: boolean;
  /** 是否要求至少一个引用 */
  requireAtLeastOneReference: boolean;
}

/**
 * 默认输出验证器配置
 */
export const DEFAULT_OUTPUT_VALIDATOR_CONFIG: OutputValidatorConfig = {
  referencePattern: REFERENCE_ID_PATTERN,
  maxCorrectionAttempts: 2,
  strictValidation: true,
  requireAtLeastOneReference: false,
};
